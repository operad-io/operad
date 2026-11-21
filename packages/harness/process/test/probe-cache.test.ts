import { describe, expect, test } from "bun:test";
import { createCachedProbe } from "../src/index.ts";

describe("a cached probe", () => {
  test("keeps an answer for its time, and asks again after it", async () => {
    let clock = 1_000;
    let probes = 0;
    const cached = createCachedProbe<string>({ now: () => clock, ttlMs: 30_000 });
    const probe = async (): Promise<string> => {
      probes += 1;
      return `answer ${probes}`;
    };
    expect(await cached("one", probe)).toBe("answer 1");
    expect(await cached("one", probe)).toBe("answer 1");
    expect(probes).toBe(1);
    clock += 30_000;
    expect(await cached("one", probe)).toBe("answer 2");
    expect(probes).toBe(2);
  });

  test("concurrent callers of one key share one probe", async () => {
    let probes = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cached = createCachedProbe<boolean>({ now: () => 1_000, ttlMs: 30_000 });
    const probe = async (): Promise<boolean> => {
      probes += 1;
      await gate;
      return true;
    };
    const first = cached("one", probe);
    const second = cached("one", probe);
    while (probes === 0) await Promise.resolve();
    expect(probes).toBe(1);
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(probes).toBe(1);
  });

  test("different keys do not share an answer", async () => {
    let probes = 0;
    const cached = createCachedProbe<number>({ now: () => 1_000, ttlMs: 30_000 });
    const probe = async (): Promise<number> => {
      probes += 1;
      return probes;
    };
    expect(await cached("one", probe)).toBe(1);
    expect(await cached("two", probe)).toBe(2);
  });
});
