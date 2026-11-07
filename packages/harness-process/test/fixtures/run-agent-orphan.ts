#!/usr/bin/env bun
/**
 * A host for one `runAgent` call that the test kills while the harness runs.
 * The harness records its own pid and its parent's (the sentinel's) in files,
 * then blocks; nothing ends it but the sentinel's check on this process.
 */
import { runAgent } from "../../src/index.ts";

const [root, pidFile] = process.argv.slice(2);
if (root === undefined || pidFile === undefined) {
  console.error("usage: run-agent-orphan <cwd> <pid file>");
  process.exit(2);
}

await runAgent({
  command: "sh",
  args: [
    "-c",
    `echo $PPID > '${pidFile}.sentinel'; echo $$ > '${pidFile}'; exec sleep 3600`,
  ],
  cwd: root,
  wallMs: 0,
  stallMs: 0,
  signal: new AbortController().signal,
  onLine() {},
});
