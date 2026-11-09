import { describe, expect, test } from "bun:test";
import { ConfigError } from "@operad-io/engine";
import { BindFailed, HandOverStuck, leaveStuck, startWithRetry, type StuckActions } from "../src/http-bind.ts";

/** A clock that only moves when the code under test waits. */
function clock(): { now: () => number; wait: (ms: number) => Promise<void>; waits: number[] } {
  let time = 0;
  const waits: number[] = [];
  return {
    now: () => time,
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    waits,
  };
}

describe("startWithRetry", () => {
  test("tries again until the start works", async () => {
    const c = clock();
    let tries = 0;
    const value = await startWithRetry(
      async () => {
        tries += 1;
        if (tries < 3) throw new Error("Failed to start server. Is port 7480 in use?");
        return "up";
      },
      { retryMs: 1_000, stepMs: 100, now: c.now, wait: c.wait },
    );
    expect(value).toBe("up");
    expect(tries).toBe(3);
    expect(c.waits).toEqual([100, 100]);
  });

  test("gives up after the bounded time with the last error", async () => {
    const c = clock();
    let tries = 0;
    const result = startWithRetry(
      async () => {
        tries += 1;
        throw new Error(`in use ${tries}`);
      },
      { retryMs: 1_000, stepMs: 250, now: c.now, wait: c.wait },
    );
    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BindFailed);
    expect((error as BindFailed).message).toBe("in use 5");
    expect(c.now()).toBe(1_000);
  });

  test("does not try again a configuration that is wrong", async () => {
    const c = clock();
    let tries = 0;
    const error = await startWithRetry(
      async () => {
        tries += 1;
        throw new ConfigError("http.listen: bad address");
      },
      { retryMs: 1_000, stepMs: 100, now: c.now, wait: c.wait },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect(tries).toBe(1);
  });
});

describe("leaveStuck", () => {
  function actions(supervised: boolean): { calls: string[]; value: StuckActions } {
    const calls: string[] = [];
    return {
      calls,
      value: {
        supervised,
        startReplacement: () => calls.push("replace"),
        exit: (code) => {
          calls.push(`exit ${code}`);
          throw new Error("exited");
        },
        log: () => calls.push("log"),
      },
    };
  }
  const stuck = (reload: boolean): HandOverStuck => new HandOverStuck(new Error("http: 192.168.6.64 did not release the port"), reload);

  test("a reload that cannot release ends the process, and a new serve starts first", () => {
    const a = actions(false);
    expect(() => leaveStuck(stuck(true), a.value)).toThrow("exited");
    expect(a.calls).toEqual(["log", "replace", "exit 1"]);
  });

  test("under a supervisor the process ends with the reload code and starts nothing itself", () => {
    const a = actions(true);
    expect(() => leaveStuck(stuck(true), a.value)).toThrow("exited");
    expect(a.calls).toEqual(["log", "exit 75"]);
  });

  test("a stop that cannot release ends the process and starts nothing", () => {
    const a = actions(false);
    expect(() => leaveStuck(stuck(false), a.value)).toThrow("exited");
    expect(a.calls).toEqual(["log", "exit 1"]);
  });
});
