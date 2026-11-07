#!/usr/bin/env bun
/**
 * A host for one `runLine` call that the test kills before the line ends. The
 * line writes the sentinel's pid and waits for a release file; the test kills
 * this process, then writes the release so the sentinel reaches its post-line
 * loop and finds its parent gone.
 */
import { runLine } from "../../src/platform/index.ts";

const [root, pidFile, release] = process.argv.slice(2);
if (root === undefined || pidFile === undefined || release === undefined) {
  console.error("usage: run-line-orphan <cwd> <pid file> <release file>");
  process.exit(2);
}

await runLine({
  line: `echo $PPID > '${pidFile}'; while [ ! -f '${release}' ]; do sleep 0.05; done`,
  cwd: root,
  signal: new AbortController().signal,
});
