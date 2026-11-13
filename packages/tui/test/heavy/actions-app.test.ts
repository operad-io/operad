import { describe, expect, test } from "bun:test";
import {
  TuiClient,
  startShell,
  type TuiEvent,
  type TuiEventSource,
  type TuiState,
  type TuiView,
} from "../../src/index.ts";
import { makeHarness, immediateClock } from "../support.ts";

/** A change stream that never speaks; the test refreshes through its own actions. */
class Quiet implements TuiEventSource {
  private release: () => void = () => undefined;
  private readonly ended = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  stop(): void {
    this.release();
  }
  [Symbol.asyncIterator](): AsyncIterator<TuiEvent> {
    return { next: () => this.ended.then(() => ({ done: true as const, value: undefined })) };
  }
}

class View implements TuiView {
  last: TuiState | undefined;
  private readonly waiters: { test: (state: TuiState) => boolean; resolve: () => void }[] = [];
  render(state: TuiState): void {
    this.last = state;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.test(state)) waiter.resolve();
      else this.waiters.push(waiter);
    }
  }
  destroy(): void {}
  until(test: (state: TuiState) => boolean): Promise<void> {
    if (this.last !== undefined && test(this.last)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }
}

describe("actions against the in-process server", () => {
  test("an action that returns opens opens that object's page", async () => {
    const h = await makeHarness();
    const client = new TuiClient({ url: h.base, token: h.token });
    const view = new View();
    const shell = startShell({
      client,
      events: () => new Quiet(),
      view,
      width: 120,
      height: 30,
      theme: "dark",
      clock: immediateClock,
    });
    try {
      h.store.put("item", "one", { title: "One", state: "new" }, "seed");
      h.store.put("item", "two", { title: "Two", state: "new" }, "seed");
      shell.key({ name: "r" });
      await view.until((state) => state.tabs.find((tab) => tab.id === "plugin:tuitest")?.list.rows.length === 2);
      shell.key({ name: "3" });
      shell.key({ name: "enter" });
      await view.until((state) => (state.object?.actions.length ?? 0) > 0);
      shell.key({ name: ":", sequence: ":" });
      for (const char of "make") {
        shell.key({ name: char === " " ? "space" : char, sequence: char });
      }
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.row.title === "Two" && state.object.loading === false);
      expect(view.last?.object?.id).toBe("two");
    } finally {
      shell.stop();
      await shell.done;
      await h.close();
    }
  });

  test("a note action and a confirm action reach the plugin with the right body", async () => {
    const h = await makeHarness();
    const bodies: Record<string, unknown>[] = [];
    const client = new TuiClient({
      url: h.base,
      token: h.token,
      fetch: (input, init) => {
        const url = String(input);
        if (url.endsWith("/v1/act") && typeof init?.body === "string") {
          bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return fetch(input, init);
      },
    });
    const view = new View();
    const logs: string[] = [];
    const shell = startShell({
      client,
      onLog: (message) => logs.push(message),
      events: () => new Quiet(),
      view,
      width: 120,
      height: 30,
      theme: "dark",
      clock: immediateClock,
    });
    const type = (text: string): void => {
      for (const char of text) {
        shell.key({ name: char === " " ? "space" : char, sequence: char });
      }
    };
    try {
      h.store.put("item", "one", { title: "One", state: "new" }, "seed");
      shell.key({ name: "r" });
      await view.until((state) => state.tabs.find((tab) => tab.id === "plugin:tuitest")?.list.rows.length === 1);
      // The plugin's default keys arrive from /v1/keys.
      await view.until((state) => state.bindings.some((binding) => binding.key === "m"));
      shell.key({ name: "3" });
      shell.key({ name: "enter" });
      await view.until((state) => (state.object?.actions.length ?? 0) > 0);

      // A required note: refused while empty, then sent as the note.
      shell.key({ name: "m" });
      expect(view.last?.input?.kind).toBe("note");
      shell.key({ name: "enter" });
      expect(view.last?.notice).toBe("a note is required");
      expect(bodies).toEqual([]);
      type("fine work");
      shell.key({ name: "enter" });
      await view.until((state) => state.object?.row.state === "approved" && !state.acting);
      expect(bodies).toEqual([{ action: "tuitest:approve", id: "item:one", note: "fine work" }]);
      expect((await h.store.get("item", "one"))?.data.approvedNote).toBe("fine work");
      // Approved is no longer offered: the key says so.
      shell.key({ name: "m" });
      expect(view.last?.notice).toBe("tuitest:approve is not available for one");

      // A confirm action: n sends nothing, y sends confirmed.
      shell.key({ name: "d" });
      expect(view.last?.input?.kind).toBe("confirm");
      shell.key({ name: "n", sequence: "n" });
      expect(bodies).toHaveLength(1);
      shell.key({ name: "d" });
      shell.key({ name: "y", sequence: "y" });
      await view.until((state) => state.object?.row.state === "dropped" && !state.acting);
      expect(bodies[1]).toEqual({ action: "tuitest:drop", id: "item:one", confirmed: true });

      // The plugin's refusal shows its line, without the status.
      shell.key({ name: ":", sequence: ":" });
      type("fail");
      shell.key({ name: "enter" });
      await view.until((state) => state.notice !== undefined && !state.acting);
      expect(view.last?.notice).toBe("the plugin refused");
      // The status stays in the log, not on the page.
      expect(logs).toEqual(["action tuitest:fail one: 422 the plugin refused"]);
      shell.key({ name: "j" });
      expect(view.last?.notice).toBeUndefined();
    } finally {
      shell.stop();
      await shell.done;
      await h.close();
    }
  });

  test("a pending question whose choices are not actions offers them and answers", async () => {
    const h = await makeHarness();
    const bodies: Record<string, unknown>[] = [];
    const client = new TuiClient({
      url: h.base,
      token: h.token,
      fetch: (input, init) => {
        const url = String(input);
        if (url.endsWith("/v1/answer") && typeof init?.body === "string") {
          bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return fetch(input, init);
      },
    });
    const view = new View();
    const shell = startShell({
      client,
      events: () => new Quiet(),
      view,
      width: 120,
      height: 30,
      theme: "dark",
      clock: immediateClock,
    });
    try {
      h.store.put("item", "one", { title: "One", state: "waiting" }, "seed");
      const run = await h.log.startRun("demo-flow", "item:one");
      await h.log.append(run.runId, 0, [
        {
          kind: "waiting_for_person",
          payload: {
            waitId: "wait:1",
            step: "ask",
            prompt: "Open a worktree?",
            choices: ["yes", "no"],
            waitKind: "step",
            effectId: null,
          },
          cause: "test",
        },
      ]);
      shell.key({ name: "r" });
      await view.until(
        (state) =>
          state.tabs.find((tab) => tab.id === "pending")?.list.rows.length === 1,
      );
      const row = view.last?.tabs.find((tab) => tab.id === "pending")?.list.rows[0];
      expect(row?.answer).toEqual({
        runId: run.runId,
        waitId: "wait:1",
        prompt: "Open a worktree?",
        choices: ["yes", "no"],
      });
      expect(row?.detail).toContain("choices: yes, no");

      shell.key({ name: "a" });
      expect(view.last?.input?.kind).toBe("answer");
      shell.key({ name: "down" });
      shell.key({ name: "enter" });
      await view.until((state) => !state.acting && state.answerRequest === undefined);
      expect(bodies).toEqual([
        { runId: run.runId, waitId: "wait:1", choice: "no" },
      ]);
      const inputs = [];
      for await (const input of h.log.readInputs()) inputs.push(input);
      expect(inputs.find((input) => input.runId === run.runId)?.payload).toMatchObject({
        kind: "person_answer",
        waitId: "wait:1",
        choice: "no",
        actor: { via: "tui" },
      });
    } finally {
      shell.stop();
      await shell.done;
      await h.close();
    }
  });

});
