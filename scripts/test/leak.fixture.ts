// Fixture for stress.test.ts, not a test of its own: starts a long stress run,
// announces its pids on stdout and waits to be killed from outside.
import { test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnStress } from "./stress-group.ts";

test("leak fixture", async () => {
  const pidfile = process.env.LEAK_PIDFILE ?? "";
  const run = spawnStress(["--runs", "100000", "--load", "2", join(import.meta.dir, "steady.fixture.ts")], {
    STRESS_PIDFILE: pidfile,
    STRESS_CPUS: "2",
  });
  // The helpers are started before the pidfile is filled, ahead of the test run.
  let helpers: string[] = [];
  while (helpers.length < 2) {
    await Bun.sleep(5);
    helpers = existsSync(pidfile) ? readFileSync(pidfile, "utf8").split("\n").filter(Boolean) : [];
  }
  console.log(`ready ${run.pid} ${helpers.join(" ")}`);
  await new Promise(() => {});
}, 120000);
