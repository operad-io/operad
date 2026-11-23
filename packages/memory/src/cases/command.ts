/** The `memory score` and `memory propose` verbs. */

import { join } from "node:path";
import type { CommandContext } from "@operad-io/engine";
import { CaseError } from "./format.ts";
import { CASES_DIRECTORY, proposeCases } from "./propose.ts";
import { programAnswerer, runScore, scoreText } from "./score.ts";

/** `memory score [--cases <dir>] [--bot <name>] [--memory <dir>] [--window <n>] [--no-record] [--answer-with <program> [args]]` */
export async function runMemoryScore(ctx: CommandContext, argv: readonly string[]): Promise<string> {
  let casesDir = join(ctx.home, CASES_DIRECTORY);
  let bot: string | undefined;
  let memory: string | undefined;
  let window: number | undefined;
  let record = true;
  let program: readonly string[] | undefined;
  const value = (at: number, flag: string): string => {
    const next = argv[at + 1];
    if (next === undefined || next.length === 0) throw new CaseError(`${flag} takes a value`);
    return next;
  };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? "";
    if (arg === "--cases") casesDir = value(at++, arg);
    else if (arg === "--bot") bot = value(at++, arg);
    else if (arg === "--memory") memory = value(at++, arg);
    else if (arg === "--window") window = Number(value(at++, arg));
    else if (arg === "--no-record") record = false;
    else if (arg === "--answer-with") {
      program = argv.slice(at + 1);
      if (program.length === 0) throw new CaseError("--answer-with takes a program");
      break;
    } else throw new CaseError(`score does not take "${arg}"`);
  }
  const run = await runScore({
    home: ctx.home,
    casesDir,
    settings: ctx.settings,
    ...(bot === undefined ? {} : { bot }),
    ...(memory === undefined ? {} : { memory }),
    ...(window === undefined ? {} : { window }),
    ...(program === undefined ? {} : { answerer: programAnswerer(program), answererName: program.join(" ") }),
    now: () => Date.now(),
    record,
  });
  return scoreText(run);
}

/** `memory propose [--chat <id>]`: stores a pending proposal for each correction in the chat record. */
export async function runMemoryPropose(ctx: CommandContext, argv: readonly string[]): Promise<string> {
  let chat: string | undefined;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? "";
    if (arg === "--chat") {
      chat = argv[++at];
      if (chat === undefined || chat.length === 0) throw new CaseError("--chat takes a chat id");
    } else throw new CaseError(`propose does not take "${arg}"`);
  }
  const made = await proposeCases(ctx.store, { home: ctx.home, ...(chat === undefined ? {} : { chat }), now: () => Date.now() });
  return made.length === 0
    ? "no new corrections to propose\n"
    : `proposed ${made.length} test case${made.length === 1 ? "" : "s"}; they wait in pending for the phrases a right answer states\n`;
}
