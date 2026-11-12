import { describe, expect, test } from "bun:test";
import { describeSummary, summarize, timesFile } from "../test-times.ts";

const line = (total: number, result = "pass"): string =>
  `date=2026-11-12T10:00:00Z commit=abc1234 tests=2200 together=${total - 20} tui=20 total=${total} parallel=2 result=${result}`;

describe("test times", () => {
  test("the median, the fastest and the number of runs come from the lines", () => {
    const summary = summarize([line(400), line(300), line(500), ""].join("\n"));
    expect(summary).toEqual({ runs: 3, median: 400, fastest: 300 });
    expect(describeSummary(summary)).toBe("runs: 3\nmedian: 400s\nfastest: 300s");
  });

  test("an even number of runs takes the middle two", () => {
    expect(summarize([line(300), line(500), line(360), line(340)].join("\n")).median).toBe(350);
  });

  test("a failed run and a line that is not a run are left out", () => {
    const summary = summarize([line(100, "fail"), "garbage", line(400)].join("\n"));
    expect(summary).toEqual({ runs: 1, median: 400, fastest: 400 });
  });

  test("no runs prints a count of zero", () => {
    expect(describeSummary(summarize(""))).toBe("runs: 0");
  });

  test("the file is OPERAD_TEST_TIMES, else one in the home directory", () => {
    expect(timesFile({ OPERAD_TEST_TIMES: "/x/times", HOME: "/h" })).toBe("/x/times");
    expect(timesFile({ HOME: "/h" })).toBe("/h/.operad-test-times");
  });
});
