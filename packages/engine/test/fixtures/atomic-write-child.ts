/**
 * Writes a file atomically and stops just before the rename: the parent kills
 * this process once it reads "ready" on stdout.
 * Usage: bun atomic-write-child.ts <target> <text>
 */
import { writeFileAtomic } from "../../src/index.ts";

const [target, text] = process.argv.slice(2);
if (target === undefined || text === undefined) {
  throw new Error("usage: atomic-write-child <target> <text>");
}
await writeFileAtomic(target, text, {
  beforeRename: async () => {
    process.stdout.write("ready\n");
    await new Promise<void>(() => undefined);
  },
});
