/**
 * test-times.ts [file]: prints the number of full runs, the median and the
 * fastest total seconds of the passing ones, read from the file
 * scripts/run-tests.sh appends one line to per full run. The median is the
 * measure of the six-minute target (decision 6 of
 * docs/backlog/operad-test-slimming.md).
 *
 * The file: OPERAD_TEST_TIMES, else ~/.operad-test-times. On the check host
 * that is the check user's home directory, which scripts/remote-check.sh never
 * cleans (it cleans only the clone, with `git clean -ffdx -e /node_modules`),
 * so the file survives every fresh checkout and every slot's tree shares it.
 * A line is space-separated key=value words: date, commit, tests, one
 * <step>=<seconds> word per step run, total, parallel, result (pass or fail).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TimesSummary {
  runs: number;
  median: number | undefined;
  fastest: number | undefined;
}

export function summarize(text: string): TimesSummary {
  const totals: number[] = [];
  for (const line of text.split("\n")) {
    const words = new Map<string, string>();
    for (const word of line.trim().split(/\s+/)) {
      const at = word.indexOf("=");
      if (at > 0) words.set(word.slice(0, at), word.slice(at + 1));
    }
    const total = Number(words.get("total"));
    if (words.get("result") === "pass" && words.has("total") && Number.isFinite(total)) totals.push(total);
  }
  totals.sort((a, b) => a - b);
  const middle = Math.floor(totals.length / 2);
  const median =
    totals.length === 0
      ? undefined
      : totals.length % 2 === 1
        ? totals[middle]
        : ((totals[middle - 1] ?? 0) + (totals[middle] ?? 0)) / 2;
  return { runs: totals.length, median, fastest: totals[0] };
}

export function describeSummary(summary: TimesSummary): string {
  if (summary.median === undefined || summary.fastest === undefined) return "runs: 0";
  return `runs: ${summary.runs}\nmedian: ${summary.median}s\nfastest: ${summary.fastest}s`;
}

export function timesFile(env: Record<string, string | undefined>): string {
  return env["OPERAD_TEST_TIMES"] || join(env["HOME"] ?? homedir(), ".operad-test-times");
}

if (import.meta.main) {
  const path = process.argv[2] ?? timesFile(process.env);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  console.log(describeSummary(summarize(text)));
}
