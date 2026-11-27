import { describe, expect, test } from "bun:test";
import { OutputQueue } from "../src/index.ts";

/** A terminal that parses a write only when the test says so. */
function slowSink() {
  const pending: { text: string; done: () => void }[] = [];
  return {
    write: (text: string, done: () => void) => {
      pending.push({ text, done });
    },
    /** What it was given and has not parsed. */
    given: () => pending.map((item) => item.text),
    parseAll: () => {
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) next.done();
    },
    parseOne: () => pending.shift()?.done(),
  };
}

function queue(sink: ReturnType<typeof slowSink>) {
  const seen: string[] = [];
  let drops = 0;
  const made = new OutputQueue(sink, { onDrop: () => (drops += 1), maxParsing: 4, maxWaiting: 6 });
  return {
    seen,
    drops: () => drops,
    write: (text: string) => made.write(text, () => seen.push(text)),
    run: (name: string) => made.run(() => seen.push(name)),
  };
}

describe("the order of output through a slow terminal", () => {
  test("gives the terminal only so much at a time, and keeps work in its place", () => {
    const sink = slowSink();
    const output = queue(sink);
    output.write("aaa");
    output.write("bbb");
    output.run("resize");
    output.write("c");
    expect(sink.given()).toEqual(["aaa"]);
    sink.parseOne();
    expect(sink.given()).toEqual(["bbb", "", "c"]);
    sink.parseAll();
    expect(output.seen).toEqual(["aaa", "bbb", "resize", "c"]);
    expect(output.drops()).toBe(0);
  });

  test("when too much waits, leaves out the oldest whole pieces and no work, saying so once", () => {
    const sink = slowSink();
    const output = queue(sink);
    output.write("aaaa");
    output.write("bbb");
    output.run("first");
    output.write("ccc");
    output.write("ddd");
    output.run("second");
    output.write("eee");
    sink.parseAll();
    expect(output.seen).toEqual(["aaaa", "first", "ddd", "second", "eee"]);
    expect(output.drops()).toBe(1);
    // Caught up: leaving output out again is said again.
    for (const text of ["ffff", "ggg", "hhh", "iii"]) output.write(text);
    sink.parseAll();
    expect(output.drops()).toBe(2);
  });

  test("keeps the newest piece even when it is over the limit alone", () => {
    const sink = slowSink();
    const output = queue(sink);
    output.write("aaaa");
    output.write("bb");
    output.write("cccccccccc");
    sink.parseAll();
    expect(output.seen).toEqual(["aaaa", "cccccccccc"]);
  });
});
