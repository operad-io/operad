/**
 * Takes a check place in a real child process, says so, and holds it until it
 * is killed. The parent proves a killed holder gives its place back. An optional
 * repository name and limit make it take a repository place as well.
 */

import { withCheckPlace } from "../../src/places.ts";

const [home, checks, name, limit] = process.argv.slice(2);
if (home === undefined || checks === undefined) {
  throw new Error("usage: place-child <home> <checks> [<repository> <places>]");
}

await withCheckPlace(
  {
    home,
    checks: Number(checks),
    repository:
      name === undefined || limit === undefined
        ? undefined
        : { name, path: `/r/${name}`, places: Number(limit) },
    log: () => {},
  },
  async () => {
    process.stdout.write("held\n");
    await new Promise<void>(() => {});
  },
);
