// A serve under the real supervisor whose first start leaves for a reload when
// the test says so: it releases the lock, says "leaving", and ends with the
// reload code only once the test writes "go". A later start says "up2" and
// stays until it is stopped. The home is OPERAD_HOME; the argument is `serve`
// so the process looks like one to `serve stop`.
import { acquireLock, serveLockPath } from "@operad-io/engine";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELOAD_EXIT, SUPERVISED_ENV, superviseServe } from "../../src/code-reload.ts";
import { recordSupervisor } from "../../src/serve-stop.ts";
import { waitForChange } from "../../../engine/src/platform/index.ts";

const home = process.env.OPERAD_HOME ?? "";

if (process.env[SUPERVISED_ENV] !== "1") {
  process.exitCode = await superviseServe(() => Promise.resolve("stopped"));
} else {
  recordSupervisor(home);
  const lock = acquireLock(serveLockPath(home));
  const second = existsSync(join(home, "up1"));
  if (second) {
    writeFileSync(join(home, "up2"), String(process.pid));
    await new Promise<void>((resolve) => {
      process.on("SIGTERM", () => resolve());
    });
    lock.release();
  } else {
    // The supervisor passes the stop on; the serve says it arrived and goes on leaving.
    process.on("SIGTERM", () => writeFileSync(join(home, "term"), ""));
    writeFileSync(join(home, "up1"), String(process.pid));
    await waitFor("release");
    lock.release();
    writeFileSync(join(home, "leaving"), "");
    await waitFor("go");
    process.exit(RELOAD_EXIT);
  }
}

async function waitFor(name: string): Promise<void> {
  while (!existsSync(join(home, name))) await waitForChange(home, name, 200);
}
