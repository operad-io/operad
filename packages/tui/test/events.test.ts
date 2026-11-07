import { describe, expect, test } from "bun:test";
import {
  TuiEvents,
  TuiUnauthorizedError,
  retryDelay,
  type FetchLike,
  type TuiEvent,
} from "../src/index.ts";
import { makeHarness, type TuiHarness } from "./support.ts";

function seed(h: TuiHarness, id: string): void {
  h.store.put("item", id, { title: id, state: "new" }, "seed");
}

interface ConnectedFetch {
  readonly fetch: FetchLike;
  /** Resolves once a response's headers arrived, so the server subscribed. */
  readonly connected: Promise<void>;
}

function connectedFetch(): ConnectedFetch {
  let announce: () => void = () => undefined;
  const connected = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let first = true;
  return {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (first) {
        first = false;
        announce();
      }
      return response;
    },
    connected,
  };
}

function take(result: IteratorResult<TuiEvent>): TuiEvent {
  if (result.done) throw new Error("the event stream ended before an event");
  return result.value;
}

describe("TuiEvents", () => {
  test("a change arrives with the server's opaque id", async () => {
    const h = await makeHarness();
    try {
      const connection = connectedFetch();
      const events = new TuiEvents({
        url: h.base,
        token: h.token,
        fetch: connection.fetch,
      });
      try {
        const waiting = events.next();
        await connection.connected;
        seed(h, "one");

        expect(take(await waiting)).toEqual({ kind: "change", id: "one" });
        expect(events.lastEventId).toBeString();
        expect(events.lastEventId).not.toBe("");
      } finally {
        events.stop();
      }
    } finally {
      await h.close();
    }
  });

  test("a reconnect with the last id gets the event it missed", async () => {
    const h = await makeHarness();
    try {
      const first = connectedFetch();
      const events = new TuiEvents({
        url: h.base,
        token: h.token,
        fetch: first.fetch,
      });
      const waiting = events.next();
      await first.connected;
      seed(h, "one");
      expect(take(await waiting)).toEqual({ kind: "change", id: "one" });
      const resume = events.lastEventId;
      expect(resume).toBeString();
      events.stop();

      seed(h, "two");

      const second = connectedFetch();
      const resumed = new TuiEvents({
        url: h.base,
        token: h.token,
        fetch: second.fetch,
        lastEventId: resume,
      });
      try {
        const missed = resumed.next();
        await second.connected;
        expect(take(await missed)).toEqual({ kind: "change", id: "two" });
        expect(resumed.lastEventId).not.toBe(resume);
      } finally {
        resumed.stop();
      }
    } finally {
      await h.close();
    }
  });

  test("an id the server cannot resume becomes one reset signal", async () => {
    const h = await makeHarness();
    try {
      const events = new TuiEvents({
        url: h.base,
        token: h.token,
        lastEventId: "not-an-id-from-this-serve",
      });
      try {
        expect(take(await events.next())).toEqual({ kind: "reset" });
        expect(events.lastEventId).toBeUndefined();
      } finally {
        events.stop();
      }
    } finally {
      await h.close();
    }
  });

  test("a refused connection retries with the first backoff step", async () => {
    const h = await makeHarness();
    try {
      const delays: number[] = [];
      const connection = connectedFetch();
      let attempts = 0;
      const fetchImpl: FetchLike = async (input, init) => {
        attempts += 1;
        if (attempts === 1) throw new Error("connection refused");
        return connection.fetch(input, init);
      };
      const events = new TuiEvents({
        url: h.base,
        token: h.token,
        fetch: fetchImpl,
        wait: async (ms) => {
          delays.push(ms);
        },
      });
      try {
        const waiting = events.next();
        await connection.connected;
        seed(h, "one");
        expect(take(await waiting)).toEqual({ kind: "change", id: "one" });
        expect(attempts).toBe(2);
        expect(delays).toEqual([retryDelay(0)]);
      } finally {
        events.stop();
      }
    } finally {
      await h.close();
    }
  });

  test("a stream that closes without an event keeps backing off", async () => {
    const h = await makeHarness();
    try {
      const delays: number[] = [];
      let attempts = 0;
      const fetchImpl: FetchLike = async () => {
        attempts += 1;
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      const events = new TuiEvents({
        url: h.base,
        token: h.token,
        fetch: fetchImpl,
        wait: async (ms) => {
          delays.push(ms);
          if (delays.length === 3) events.stop();
        },
      });
      // Each reconnect with no id to resume from says so with one reset.
      const seen: TuiEvent[] = [];
      for (;;) {
        const result = await events.next();
        if (result.done) break;
        seen.push(result.value);
      }
      expect(seen).toEqual([{ kind: "reset" }, { kind: "reset" }]);
      expect(attempts).toBe(3);
      expect(delays).toEqual([retryDelay(0), retryDelay(1), retryDelay(2)]);
    } finally {
      await h.close();
    }
  });

  test("a bad token ends the stream after one error event", async () => {
    const h = await makeHarness();
    try {
      let attempts = 0;
      const counting: FetchLike = (input, init) => {
        attempts += 1;
        return fetch(input, init);
      };
      const events = new TuiEvents({
        url: h.base,
        token: "not-the-token",
        fetch: counting,
        wait: async () => undefined,
      });
      const first = await events.next();
      if (first.done || first.value.kind !== "error") {
        throw new Error("expected an error event");
      }
      expect(first.value.error).toBeInstanceOf(TuiUnauthorizedError);
      expect(first.value.error.status).toBe(401);
      expect(await events.next()).toEqual({ done: true, value: undefined });
      expect(attempts).toBe(1);
    } finally {
      await h.close();
    }
  });

  test("404 and 409 end the stream; 500 is retried with backoff", async () => {
    const h = await makeHarness();
    try {
      for (const status of [404, 409]) {
        let attempts = 0;
        const events = new TuiEvents({
          url: h.base,
          token: h.token,
          fetch: async () => {
            attempts += 1;
            return Response.json(
              { error: { kind: "x", message: `refused ${status}` } },
              { status },
            );
          },
          wait: async () => undefined,
        });
        const first = await events.next();
        if (first.done || first.value.kind !== "error") {
          throw new Error("expected an error event");
        }
        expect(first.value.error.status).toBe(status);
        expect(first.value.error.message).toBe(`refused ${status}`);
        expect(await events.next()).toEqual({ done: true, value: undefined });
        expect(attempts).toBe(1);
      }

      const delays: number[] = [];
      let attempts = 0;
      const events = new TuiEvents({
        url: h.base,
        token: h.token,
        fetch: async () => {
          attempts += 1;
          return Response.json(
            { error: { kind: "internal", message: "boom" } },
            { status: 500 },
          );
        },
        wait: async (ms) => {
          delays.push(ms);
          if (delays.length === 2) events.stop();
        },
      });
      const kinds: string[] = [];
      for (;;) {
        const result = await events.next();
        if (result.done) break;
        kinds.push(result.value.kind);
      }
      expect(kinds).toEqual(["error", "error"]);
      expect(attempts).toBe(2);
      expect(delays).toEqual([retryDelay(0), retryDelay(1)]);
    } finally {
      await h.close();
    }
  });

  test("a reconnect with no id to resume from sends one reset", async () => {
    const encoder = new TextEncoder();
    let attempts = 0;
    const headers: (string | null)[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      attempts += 1;
      headers.push(new Headers(init?.headers).get("last-event-id"));
      if (attempts === 1) {
        // Accepted, then dropped before any event: no id is held.
        return new Response(new ReadableStream({ start: (c) => c.close() }), {
          status: 200,
        });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('id: s-1\ndata: {"id":"after"}\n\n'),
            );
          },
        }),
        { status: 200 },
      );
    };
    const events = new TuiEvents({
      url: "http://127.0.0.1:1",
      token: "t",
      fetch: fetchImpl,
      wait: async () => undefined,
    });
    try {
      expect(take(await events.next())).toEqual({ kind: "reset" });
      expect(take(await events.next())).toEqual({ kind: "change", id: "after" });
      expect(headers).toEqual([null, null]);
    } finally {
      events.stop();
    }
  });

  test("the same instance reconnects with the last id and gets the missed event", async () => {
    const encoder = new TextEncoder();
    const seen: (string | null)[] = [];
    let attempts = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      attempts += 1;
      seen.push(new Headers(init?.headers).get("last-event-id"));
      const frame =
        attempts === 1
          ? 'id: s-1\ndata: {"id":"one"}\n\n'
          : 'id: s-2\ndata: {"id":"two"}\n\n';
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(frame));
            // The first response ends after its one event.
            if (attempts === 1) controller.close();
          },
        }),
        { status: 200 },
      );
    };
    const events = new TuiEvents({
      url: "http://127.0.0.1:1",
      token: "t",
      fetch: fetchImpl,
      wait: async () => undefined,
    });
    try {
      expect(take(await events.next())).toEqual({ kind: "change", id: "one" });
      expect(take(await events.next())).toEqual({ kind: "change", id: "two" });
      expect(seen).toEqual([null, "s-1"]);
    } finally {
      events.stop();
    }
  });

  test("stop ends a waiting reader at once", async () => {
    const h = await makeHarness();
    try {
      const events = new TuiEvents({ url: h.base, token: h.token });
      const waiting = events.next();
      events.stop();
      expect(await waiting).toEqual({ done: true, value: undefined });
    } finally {
      await h.close();
    }
  });

  test("the retry delay doubles and stays under the cap", () => {
    expect(retryDelay(0, 250, 5_000)).toBe(250);
    expect(retryDelay(1, 250, 5_000)).toBe(500);
    expect(retryDelay(2, 250, 5_000)).toBe(1_000);
    expect(retryDelay(10, 250, 5_000)).toBe(5_000);
    expect(retryDelay(0, 100, 50)).toBe(100);
  });
});
