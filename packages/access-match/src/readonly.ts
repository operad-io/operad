/**
 * The commands a read-only working directory lets run. Anything not recognised
 * here is not read-only: the allowlist is the rule, so a new way to write a file
 * never needs a new pattern. A command is read-only only when every part of it
 * (split at `|`, `;`, `&&`, `||`, `&`, newlines) is, and it has no redirection
 * that writes a file, no substitution and no inline code.
 */

import { scan, baseName } from "./command.ts";

/** Programs that only read, whatever their arguments (the ones with a writing option are checked below). */
const PLAIN = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "stat", "file", "du", "tree", "which", "true",
  "cd", "echo", "printf", "sort", "cut", "tr", "basename", "dirname", "realpath", "readlink", "date", "jq", "diff", "cmp",
]);

/** Options of an otherwise reading program that write or run something. */
const WRITING_OPTIONS: Readonly<Record<string, RegExp>> = {
  tree: /^-[a-zA-Z]*o|^--output/,
  rg: /^--pre(=|$)|^--hostname-bin|^--search-zip$|^-z$/,
  grep: /^--output/,
  printf: /^-[^-]*v/,
  sort: /^-[^-]*o|^--output|^--compress-program(=|$)/,
  date: /^-[^-]*s|^--set/,
  jq: /^-[^-]*i|^--in-place|^--output/,
  diff: /^-[^-]*o|^--output/,
};

const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "ls-tree", "shortlog", "describe", "cat-file", "grep"]);
const GIT_WRITING_OPTION = /^--output|^--ext-diff|^--textconv|^-o$|^--open-files-in-pager|^-O/;
const FIND_WRITING = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const SED_SCRIPT = /^\d*(?:,(?:\d+|\$))?p$/;

/** A redirection that writes nowhere: to `/dev/null`, or one file descriptor onto another. */
const HARMLESS_FD_DUP = new Set(["2>&1", "1>&2"]);
const OUTPUT_REDIRECT = /^(?:(\d+|&)?)(>>?)(.*)$/;
const INPUT_REDIRECT = new Set(["<", "<<", "<<<"]);

/**
 * The words without the redirections that write nowhere, or undefined when one
 * of them writes a file. A separated `> /dev/null` is two words; a glued
 * `2>/dev/null` is one.
 */
function withoutWritingRedirections(words: readonly string[]): readonly string[] | undefined {
  const rest: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!word.includes(">")) {
      // An input redirect reads a file; it writes nothing. Drop it and its target.
      if (INPUT_REDIRECT.has(word)) index += 1;
      else if (word.startsWith("<") && !word.startsWith("<(")) continue;
      else rest.push(word);
      continue;
    }
    if (HARMLESS_FD_DUP.has(word)) continue;
    const match = OUTPUT_REDIRECT.exec(word);
    if (match === null) return undefined;
    const glued = match[3] ?? "";
    if (glued.startsWith("&")) return undefined;
    const target = glued.length > 0 ? glued : words[index + 1];
    if (target === undefined) return undefined;
    if (glued.length === 0) index += 1;
    if (target !== "/dev/null") return undefined;
  }
  return rest;
}

function gitIsReadOnly(words: readonly string[]): boolean {
  // The options before the subcommand that read: `-C <dir>` chooses the
  // directory, and `--no-pager` only stops git from running a pager. The
  // directory stays in the words, so the path rules still check it.
  let index = 1;
  while (index < words.length) {
    const word = words[index] ?? "";
    if (word === "--no-pager") {
      index += 1;
      continue;
    }
    if (word === "-C") {
      if (words[index + 1] === undefined) return false;
      index += 2;
      continue;
    }
    break;
  }
  const sub = words[index];
  if (sub === undefined || sub.startsWith("-")) return false;
  const rest = words.slice(index + 1);
  if (sub === "branch") return rest.every((word) => ["--list", "-a", "-r", "-v", "-vv", "--show-current"].includes(word));
  if (!GIT_READ.has(sub)) return false;
  return !rest.some((word) => GIT_WRITING_OPTION.test(word));
}

function partIsReadOnly(words: readonly string[]): boolean {
  const plain = withoutWritingRedirections(words);
  if (plain === undefined) return false;
  const first = plain[0];
  if (first === undefined) return true;
  const program = baseName(first);
  const args = plain.slice(1);
  if (program === "env") return args.length === 0;
  if (program === "uniq") return args.filter((word) => !word.startsWith("-")).length <= 1;
  if (PLAIN.has(program)) return !args.some((word) => WRITING_OPTIONS[program]?.test(word) === true);
  switch (program) {
    case "git":
      return gitIsReadOnly(plain);
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
