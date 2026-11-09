import { describe, expect, test } from "bun:test";
import { ConfigError } from "@operad-io/engine";
import { BindFailed, startWithRetry } from "../src/http-bind.ts";

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
