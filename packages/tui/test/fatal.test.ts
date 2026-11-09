import { describe, expect, test } from "bun:test";
import { createCliRenderer } from "@opentui/core";
import { PassThrough } from "node:stream";
import type { PendingItem, RunningItem, ViewListPage, ViewObject } from "@operad-io/engine";
import {
  TuiError,
  createTuiView,
  runTui,
  startShell,
  type TuiEventSource,
  type TuiShellClient,
  type TuiState,
  type TuiView,
} from "../src/index.ts";
import { immediateClock } from "./support.ts";

const AMBIGUOUS = '"operad" is ambiguous: use repo:operad, repository:operad';

class Quiet implements TuiEventSource {
  private release: () => void = () => undefined;
  private readonly ended = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  stop(): void {
    this.release();
  }
  [Symbol.asyncIterator](): AsyncIterator<never> {
    return { next: () => this.ended.then(() => ({ done: true, value: undefined })) };
  }
}

class Watch implements TuiView {
  last: TuiState | undefined;
  private readonly waiters: { test: (s: TuiState) => boolean; resolve: () => void }[] = [];
  render(state: TuiState): void {
    this.last = state;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.test(state)) waiter.resolve();
      else this.waiters.push(waiter);
    }
  }
  destroy(): void {}
  until(test: (s: TuiState) => boolean): Promise<void> {
    if (this.last !== undefined && test(this.last)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }
}

const row = { id: "one", title: "One", state: "new", waiting: false, running: false };

class Failing implements TuiShellClient {
  types(): Promise<{ readonly types: readonly { type: string; title: string }[] }> {
    return Promise.resolve({ types: [{ type: "item", title: "Item" }] });
  }
  pending(): Promise<readonly PendingItem[]> {
    return Promise.resolve([]);
  }
  running(): Promise<readonly RunningItem[]> {
    return Promise.resolve([]);
  }
  objects(): Promise<ViewListPage> {
    return Promise.resolve({ rows: [row] });
  }
  object(): Promise<ViewObject> {
    return Promise.reject(new TuiError(AMBIGUOUS, { status: 400, kind: "ambiguous" }));
  }
}

describe("a request that fails", () => {
  test("shows its message on the page and the app keeps running", async () => {
    const view = new Watch();
    const failures: string[] = [];
    const shell = startShell({
      client: new Failing(),
      events: () => new Quiet(),
      view,
      width: 80,
      height: 20,
      theme: "dark",
      clock: immediateClock,
      onMessage: (message) => failures.push(message),
    });
    await view.until((s) => s.tabs.find((t) => t.id === "type:item")?.list.loaded === true);
    shell.key({ name: "3" });
    shell.key({ name: "enter" });
    await view.until((s) => s.object?.error?.includes("is ambiguous") === true);
    expect(failures).toContain(AMBIGUOUS);
    // Still running: the keys are still answered, and `q` ends it with 0.
    shell.key({ name: "escape" });
    await view.until((s) => s.object === undefined);
    shell.key({ name: "q" });
    expect(await shell.done).toBe(0);
  });
});

/** A real renderer on streams that keep every byte written to the terminal. */
async function recorded(): Promise<{
  renderer: Awaited<ReturnType<typeof createCliRenderer>>;
  bytes: () => string;
}> {
  const chunks: string[] = [];
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 60, rows: 10, fd: 1 });
  stdout.on("data", (chunk) => chunks.push(String(chunk)));
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: () => stdin,
  });
  const renderer = await createCliRenderer({
    stdin: stdin as never,
    stdout: stdout as never,
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
  });
  return { renderer, bytes: () => chunks.join("") };
}

const RESTORE = [
  "\u001b[?1003l\u001b[?1002l\u001b[?1000l\u001b[?1006l", // mouse tracking off
  "\u001b[>4;0m", // keyboard protocol back
  "\u001b[?1049l", // main screen
];

describe("a fault that ends the app", () => {
  const faults: readonly [string, (arm: (fault: () => void) => void) => void][] = [
    [
      "a view that throws while a request is answered",
      (arm) =>
        arm(() => {
          throw new Error("view broke");
        }),
    ],
    [
      "an uncaught exception",
      (arm) =>
        arm(() => {
          queueMicrotask(() => process.emit("uncaughtException", new Error("view broke")));
        }),
    ],
    [
      "an uncaught rejection",
      (arm) =>
        arm(() => {
          queueMicrotask(() => process.emit("unhandledRejection", new Error("view broke"), Promise.resolve()));
        }),
    ],
  ];
  for (const [name, fault] of faults) {
    test(`${name}: the terminal is restored before the message is written`, async () => {
      const { renderer, bytes } = await recorded();
      let armed: (() => void) | undefined;
      fault((run) => {
        armed = run;
      });
      const atMessage: string[] = [];
      const reported: string[] = [];
      const code = await runTui({
        url: "http://127.0.0.1:1",
        token: "t",
        onError: (message) => {
          reported.push(message);
          atMessage.push(bytes());
        },
        hooks: {
          renderer: async () => renderer,
          view: (ctx) => {
            const real = createTuiView(ctx);
            return {
              render(state) {
                real.render(state);
                if (state.status !== undefined && armed !== undefined) {
                  const run = armed;
                  armed = undefined;
                  run();
                }
              },
              destroy: () => real.destroy(),
            };
          },
        },
      });
      expect(code).toBe(1);
      // The fault is the last message; earlier ones are request failures echoed at exit.
      expect(reported.at(-1)).toBe("view broke");
      const written = atMessage[0] ?? "";
      for (const sequence of RESTORE) expect(written).toContain(sequence);
      expect(written.endsWith("\u001b[?25h")).toBe(true);
      expect(written.lastIndexOf("\u001b[?1049l")).toBeGreaterThan(written.lastIndexOf("\u001b[?1049h"));
      expect(renderer.isDestroyed).toBe(true);
    });
  }
});

describe("a fault in the app's own loops", () => {
  test("a view that throws while a request is answered ends the app through the request guard", async () => {
    // Nothing but the list request can render a loaded list here: the event stream is quiet.
    const fatals: string[] = [];
    let armed = false;
    const view: TuiView = {
      render(state) {
        if (state.tabs.find((tab) => tab.id === "type:item")?.list.loaded === true) {
          if (!armed) {
            armed = true;
            throw new Error("view broke");
          }
        }
      },
      destroy() {},
    };
    const shell = startShell({
      client: new Failing(),
      events: () => new Quiet(),
      view,
      width: 80,
      height: 20,
      theme: "dark",
      clock: immediateClock,
      onFatal: (message) => fatals.push(message),
    });
    expect(await shell.done).toBe(1);
    expect(fatals).toEqual(["view broke"]);
  });

  test("an event stream that throws ends the app with the message", async () => {
    const fatals: string[] = [];
    let finished = 0;
    const shell = startShell({
      client: new Failing(),
      events: () => ({
        stop() {},
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("stream broke")) }),
      }),
      view: new Watch(),
      width: 80,
      height: 20,
      theme: "dark",
      clock: immediateClock,
      onFatal: (message) => fatals.push(message),
      onFinish: () => {
        finished += 1;
      },
    });
    expect(await shell.done).toBe(1);
    expect(fatals).toEqual(["stream broke"]);
    expect(finished).toBe(1);
  });
});

describe("runTui", () => {
  test("a fault before the shell exists still ends the app, with the message", async () => {
    const { renderer } = await recorded();
    const reported: string[] = [];
    const code = await runTui({
      url: "http://127.0.0.1:1",
      token: "t",
      onError: (message) => reported.push(message),
      hooks: {
        renderer: async () => {
          process.emit("unhandledRejection", new Error("early fault"), Promise.resolve());
          return renderer;
        },
      },
    });
    expect(code).toBe(1);
    expect(reported).toContain("early fault");
    expect(renderer.isDestroyed).toBe(true);
  });

  test("a server that cannot be reached is echoed after the screen closes", async () => {
    const { renderer } = await recorded();
    const reported: string[] = [];
    const controller = new AbortController();
    const code = await runTui({
      url: "http://127.0.0.1:1",
      token: "t",
      signal: controller.signal,
      onError: (message) => reported.push(message),
      hooks: {
        renderer: async () => renderer,
        view: (ctx) => {
          const real = createTuiView(ctx);
          return {
            render(state) {
              real.render(state);
              if (state.connection === "unreachable") controller.abort();
            },
            destroy: () => real.destroy(),
          };
        },
      },
    });
    expect(code).toBe(0);
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.join("\n")).toContain("127.0.0.1:1");
  });
});
