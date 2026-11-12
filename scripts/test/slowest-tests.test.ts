import { describe, expect, test } from "bun:test";
import { formatSlowest, parseJunit, slowest } from "../slowest-tests.ts";

const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4">
  <testsuite name="b.test.ts" file="b.test.ts" tests="1">
    <testcase name="b slow" classname="" time="0.5" file="b.test.ts" assertions="0" />
  </testsuite>
  <testsuite name="a.test.ts" file="a.test.ts" tests="3">
    <testsuite name="outer" file="a.test.ts">
      <testcase name="says &quot;hi&quot; &amp; leaves" classname="outer&amp;apos;s &amp;amp; co" time="2.25" file="a.test.ts" assertions="0">
        <failure type="AssertionError" />
      </testcase>
      <testcase name="fast" classname="outer" time="0.000035" file="a.test.ts" assertions="0" />
    </testsuite>
  </testsuite>
</testsuites>`;

describe("slowest tests", () => {
  test("a junit report gives each test its file, its groups and its seconds", () => {
    expect(parseJunit(report)).toEqual([
      { file: "b.test.ts", name: "b slow", seconds: 0.5 },
      { file: "a.test.ts", name: 'outer\'s & co > says "hi" & leaves', seconds: 2.25 },
      { file: "a.test.ts", name: "outer > fast", seconds: 0.000035 },
    ]);
  });

  test("the list is the slowest first and no longer than asked", () => {
    const tests = Array.from({ length: 15 }, (_, i) => ({ file: "f.test.ts", name: `t${i}`, seconds: i }));
    const top = slowest(tests);
    expect(top.map((t) => t.name)).toEqual(["t14", "t13", "t12", "t11", "t10", "t9", "t8", "t7", "t6", "t5"]);
    expect(slowest(tests, 2)).toHaveLength(2);
    expect(slowest([])).toEqual([]);
  });

  test("a line holds the seconds, the file and the test name", () => {
    const text = formatSlowest([{ file: "a.test.ts", name: "outer > one", seconds: 2.254 }]);
    expect(text.split("\n")[1]).toBe("   2.25s  a.test.ts  outer > one");
  });

  test("a report that holds no test, or is not XML, lists nothing", () => {
    expect(parseJunit("")).toEqual([]);
    expect(parseJunit("<testsuites></testsuites>")).toEqual([]);
  });
});
