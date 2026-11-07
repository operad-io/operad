import { afterAll, describe, expect, test } from "bun:test";
import {
  TuiEvents,
  retryDelay,
  type FetchLike,
  type TuiEvent,
} from "../src/index.ts";
import { cleanupTempRoots, makeHarness, type TuiHarness } from "./support.ts";

afterAll(cleanupTempRoots);

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
