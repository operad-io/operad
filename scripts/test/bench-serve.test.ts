import { describe, expect, test } from "bun:test";
import {
  api,
  getJson,
  isLogReadRequest,
  logReadsPerSecond,
  parseCpuProfile,
  peakCpuPercent,
  profileWindowMicros,
} from "../bench-serve.ts";

describe("serve benchmark", () => {
  test("a run with too few samples has no CPU interval and a zero peak", () => {
    expect(peakCpuPercent([])).toBe(0);
    expect(peakCpuPercent([{ atMs: 0, cpuSeconds: 1, rssBytes: 0 }])).toBe(0);
    expect(
      peakCpuPercent([
        { atMs: 0, cpuSeconds: 1, rssBytes: 0 },
        { atMs: 250, cpuSeconds: 1.25, rssBytes: 0 },
      ]),
    ).toBe(100);
  });

  test("closing a client aborts a request that is still open", async () => {
    let opened: AbortSignal | undefined;
    const client = api("http://bench.invalid", "token", (_input, init) => {
      const signal = init.signal;
      if (signal === null || signal === undefined) {
        return Promise.reject(new Error("the request has no client signal"));
      }
      opened = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by close")), { once: true });
      });
    });
    const request = getJson(client, "/v1/pending");
    expect(opened?.aborted).toBe(false);
    client.close();
    await expect(request).rejects.toThrow("aborted by close");
    expect(opened?.aborted).toBe(true);
  });

  test("log reads per second counts log section requests only", () => {
    expect(isLogReadRequest("/v1/objects/job:g1/sections/log")).toBe(true);
    expect(isLogReadRequest("/v1/objects/job:g1/sections/log?full=1")).toBe(true);
    expect(isLogReadRequest("/v1/objects/chat:c1/sections/transcript")).toBe(false);
    expect(isLogReadRequest("/v1/pending")).toBe(false);
    expect(
      logReadsPerSecond(
        { "/v1/objects/job:g1/sections/log": 6, "/v1/objects/job:g2/sections/log": 4, "/v1/pending": 50 },
        2000,
      ),
    ).toBe(5);
    expect(logReadsPerSecond({}, 1000)).toBe(0);
  });

  test("a profile on the wall clock keeps the measured window", () => {
    const serveStart = 1_700_000_000_000_000;
    const serveEnd = serveStart + 1_000_000_000;
    const measuredStart = serveStart + 5_000_000;
    const measuredEnd = serveStart + 6_000_000;
    expect(
      profileWindowMicros(
        serveStart + 20_000,
        serveEnd - 10_000,
        measuredStart,
        measuredEnd,
        serveStart,
        serveEnd,
      ),
    ).toEqual({ start: measuredStart, end: measuredEnd });
  });

  test("a profile on its own clock is mapped across serve's wall span", () => {
    const serveStart = 1_700_000_000_000_000;
    const serveEnd = serveStart + 1_000_000_000;
    expect(
      profileWindowMicros(0, 1_000_000, serveStart + 500_000_000, serveStart + 600_000_000, serveStart, serveEnd),
    ).toEqual({ start: 500_000, end: 600_000 });
  });

  test("only samples inside the measured window reach the profile list", () => {
    const profileStart = 1_700_000_000_000_000;
    const profile = {
      startTime: profileStart,
      endTime: profileStart + 2000,
      nodes: [
        { id: 1, callFrame: { functionName: "inside", url: "file:///repo/src/a.ts", lineNumber: 4 } },
        { id: 2, callFrame: { functionName: "outside", url: "file:///repo/src/b.ts", lineNumber: 0 } },
      ],
      samples: [2, 1, 2],
      timeDeltas: [1000, 1000, 1000],
    };
    expect(
      parseCpuProfile(
        JSON.stringify(profile),
        "/repo",
        profileStart + 500,
        profileStart + 1500,
        profileStart - 10_000,
        profileStart + 3000,
      ),
    ).toEqual([{ function: "inside", file: "src/a.ts", line: 5, selfMs: 1, selfPercent: 100 }]);
  });
});
