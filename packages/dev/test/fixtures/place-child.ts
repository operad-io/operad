/**
 * Takes a check place in a real child process, says so, and holds it until it
 * is killed. The parent proves a killed holder gives its place back.
 */

import { withCheckPlace } from "../../src/places.ts";

const [home, checks] = process.argv.slice(2);
if (home === undefined || checks === undefined) {
  throw new Error("usage: place-child <home> <checks>");
}

await withCheckPlace(
  { home, checks: Number(checks), log: () => {} },
  async () => {
    process.stdout.write("held\n");
    await new Promise<void>(() => {});
  },
);
