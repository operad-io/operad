/**
 * The program radian runs before each tool call (a `PreToolUse` hook) when the
 * run's access profile has rules: `bun hook.ts <profile file>`. It reads the
 * call from stdin, asks the access profile and exits 2 with the reason on stderr
 * to deny it, which radian does before the tool runs; it exits 0 to let it go.
 * Any other exit also denies, so a broken hook never lets a call through.
 */

import { readFileSync } from "node:fs";
import { readProfile } from "@operad-io/access-match";
import { radianRefusal } from "./refusal.ts";

const file = process.argv[2] ?? "";
const read = readProfile(JSON.parse(readFileSync(file, "utf8")));
if (!read.ok) {
  process.stderr.write(`the access profile is not usable: ${read.message}\n`);
  process.exit(3);
}
const call: unknown = JSON.parse(await Bun.stdin.text());
const record = typeof call === "object" && call !== null ? (call as Record<string, unknown>) : {};
const toolName = typeof record.tool_name === "string" ? record.tool_name : "";
const cwd = typeof record.cwd === "string" ? record.cwd : process.cwd();
const why = radianRefusal(read.profile, toolName, record.tool_input, cwd);
if (why !== undefined) {
  process.stderr.write(`${toolName} call ${why}\n`);
  process.exit(2);
}
