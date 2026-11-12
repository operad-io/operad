/**
 * slowest-tests.ts <junit.xml>...: prints the ten slowest tests of the runs
 * whose junit reports (bun test --reporter=junit) are named: file, test name,
 * seconds. scripts/run-tests.sh ends its output with this list. It only lists
 * (decision 7 of docs/backlog/operad-test-slimming.md): it exits 0 whatever
 * the reports hold, a missing or unreadable one included.
 */
import { readFileSync } from "node:fs";

export interface TestTime {
  file: string;
  name: string;
  seconds: number;
}

function unescape(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Every test case of one junit report, with the groups it sits in joined to its name. */
export function parseJunit(xml: string): TestTime[] {
  const found: TestTime[] = [];
  for (const tag of xml.matchAll(/<testcase\s([^>]*?)\/?>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of (tag[1] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attributes.set(attribute[1] ?? "", unescape(attribute[2] ?? ""));
    }
    const seconds = Number(attributes.get("time"));
    if (!Number.isFinite(seconds)) continue;
    // bun escapes the groups of a test twice (it&amp;apos;s), its name once.
    const group = unescape(attributes.get("classname") ?? "");
    const name = attributes.get("name") ?? "";
    found.push({
      file: attributes.get("file") ?? "",
      name: group === "" ? name : `${group} > ${name}`,
      seconds,
    });
  }
  return found;
}

/** The `count` slowest tests, slowest first. */
export function slowest(tests: readonly TestTime[], count = 10): TestTime[] {
  return [...tests].sort((a, b) => b.seconds - a.seconds).slice(0, count);
}

export function formatSlowest(tests: readonly TestTime[]): string {
  const lines = tests.map((test) => `${test.seconds.toFixed(2).padStart(7)}s  ${test.file}  ${test.name}`);
  return ["Slowest tests (seconds, file, test):", ...lines].join("\n");
}

if (import.meta.main) {
  const all: TestTime[] = [];
  for (const path of process.argv.slice(2)) {
    try {
      all.push(...parseJunit(readFileSync(path, "utf8")));
    } catch {
      // A step that left no report adds nothing; the list never fails a check.
    }
  }
  if (all.length > 0) console.log(`\n${formatSlowest(slowest(all))}`);
}
