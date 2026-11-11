/**
 * The commands a read-only working directory lets run. Anything not recognised
 * here is not read-only: the allowlist is the rule, so a new way to write a file
 * never needs a new pattern. A command is read-only only when every part of it
 * (split at `|`, `;`, `&&`, `||`, `&`, newlines) is, and it has no output
 * redirection, no substitution and no inline code.
 */

import { scan, baseName } from "./command.ts";

/** Programs that only read, whatever their arguments (the ones with a writing option are checked below). */
const PLAIN = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "stat", "file", "du", "tree", "which", "true"]);

/** Options of an otherwise reading program that write or run something. */
const WRITING_OPTIONS: Readonly<Record<string, RegExp>> = {
  tree: /^-[a-zA-Z]*o|^--output/,
  rg: /^--pre(=|$)|^--hostname-bin|^--search-zip$|^-z$/,
  grep: /^--output/,
};

const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "ls-tree", "shortlog", "describe", "cat-file", "grep"]);
const GIT_WRITING_OPTION = /^--output|^--ext-diff|^--textconv|^-o$|^--open-files-in-pager|^-O/;
const FIND_WRITING = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const SED_SCRIPT = /^\d*(?:,(?:\d+|\$))?p$/;

function gitIsReadOnly(words: readonly string[]): boolean {
  const sub = words[1];
  if (sub === undefined || sub.startsWith("-")) return false;
  const rest = words.slice(2);
  if (sub === "branch") return rest.every((word) => ["--list", "-a", "-r", "-v", "-vv", "--show-current"].includes(word));
  if (!GIT_READ.has(sub)) return false;
  return !rest.some((word) => GIT_WRITING_OPTION.test(word));
}

function partIsReadOnly(words: readonly string[]): boolean {
  const first = words[0];
  if (first === undefined) return true;
  const program = baseName(first);
  const args = words.slice(1);
  if (words.some((word) => word.includes(">"))) return false;
  if (PLAIN.has(program)) return !args.some((word) => WRITING_OPTIONS[program]?.test(word) === true);
  switch (program) {
    case "git":
      return gitIsReadOnly(words);
    case "find":
      return !args.some((word) => FIND_WRITING.has(word));
    case "sed": {
      if (args[0] !== "-n") return false;
      const script = args[1];
      return args.length >= 2 && script !== undefined && SED_SCRIPT.test(script) && !args.slice(2).some((word) => word.startsWith("-"));
    }
    case "bun":
      return args[0] === "test";
    case "bunx":
      return args[0] === "tsc" && args.includes("--noEmit") && !args.includes("-b") && !args.includes("--build");
    default:
      return false;
  }
}

/** Whether a shell command only reads. */
export function isReadOnlyCommand(command: string): boolean {
  const { parts, substitution } = scan(command);
  if (substitution !== undefined) return false;
  return parts.every((part) => partIsReadOnly(part.words));
}
