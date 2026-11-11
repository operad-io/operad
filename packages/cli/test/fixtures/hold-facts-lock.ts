import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lockFactsFile } from "../../../engine/src/plugin/file-store.ts";

/**
 * A slow plugin writer: takes the facts lock, says so, appends one fact a moment
 * later and lets go. argv: the store directory.
 */
const [root] = process.argv.slice(2);
if (root === undefined) throw new Error("the store directory is required");
const facts = join(root, "plugins", "facts.jsonl");
const release = lockFactsFile(join(root, "plugins", "facts.lock"));
process.stdout.write("held\n");
setTimeout(() => {
  const last = readFileSync(facts, "utf8").trim().split("\n").at(-1) ?? "{}";
  const sequence = (JSON.parse(last) as { sequence: number }).sequence + 1;
  appendFileSync(
    facts,
    `${JSON.stringify({ sequence, type: "note", cause: "slow", at: 1, data: { text: "in flight" } })}\n`,
  );
  release();
  process.exit(0);
}, 400);
