#!/usr/bin/env bun
/**
 * A host for one `runLine` call whose line blocks until it is killed. The line
 * writes the sentinel's pid and its own, then sleeps far longer than the test:
 * only the sentinel's host watcher can end it, because the host is killed
 * before the line can finish.
 */
import { runLine } from "../../src/platform/index.ts";

const [root, sentinelFile, lineFile] = process.argv.slice(2);
if (root === undefined || sentinelFile === undefined || lineFile === undefined) {
  console.error("usage: run-line-blocked <cwd> <sentinel pid file> <line pid file>");
  process.exit(2);
}

await runLine({
  line: `echo $PPID > '${sentinelFile}'; echo $$ > '${lineFile}'; sleep 3600`,
  cwd: root,
  signal: new AbortController().signal,
});
