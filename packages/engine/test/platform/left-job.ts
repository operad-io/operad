/**
 * A job that outlives its shell: a process of its own group that ignores TERM
 * and HUP and holds a FIFO open while it lives. It is Bun, because macOS
 * withholds the environment of Apple's own binaries.
 */

import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";

/** `line` starts it from a shell: `up` settles once it runs, `gone` once it ended. */
export function leftJob(fifo: string) {
  execFileSync("mkfifo", [fifo]);
  const stream = createReadStream(fifo, { encoding: "utf8" });
  let ended = false;
  let pid = 0;
  const up = new Promise<void>((resolve) =>
    stream.once("data", (data) => {
      pid = Number(String(data));
      resolve();
    }),
  );
  const gone = new Promise<void>((resolve) =>
    stream.once("end", () => {
      ended = true;
      resolve();
    }),
  );
  // It ends by itself after a minute, so a failing test leaves nothing behind for long.
  const code = `process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});const fs=require("fs");fs.writeSync(fs.openSync(process.argv[1],"w"),String(process.pid));setTimeout(()=>process.exit(0),60000)`;
  const program = `'${process.execPath}' -e '${code}' '${fifo}' </dev/null >/dev/null 2>&1`;
  return { program, line: `set -m; ${program} &`, up, gone, ended: () => ended, pid: () => pid };
}
