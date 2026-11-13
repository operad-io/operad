// Started by a test that kills it with SIGKILL: runs a check whose command
// prints a line and then holds on a fifo that nobody ever releases. The check
// shares this process's output, so the test sees the output end only when no
// shell of the check is left.
import { join } from "node:path";
import { holdUntilReleased } from "./hold.ts";

const [local, release] = process.argv.slice(2);
if (local === undefined || release === undefined) throw new Error("usage: <local> <release fifo>");
Bun.spawn(
  ["bash", join(local, "scripts", "remote-check.sh"), `echo started; ${holdUntilReleased(release)}`],
  { cwd: local, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
);
setInterval(() => {}, 1000);
