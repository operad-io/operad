/**
 * Splits a `bash` command into parts and matches the parts against
 * `denyCommands` rules. The tables are in `../README.md`.
 */

/** One command between operators; `sep` is the operator before it ("" for the first). */
export interface Part {
  readonly sep: string;
  readonly words: readonly string[];
  readonly text: string;
}

export interface Scan {
  readonly parts: readonly Part[];
  /** The first command or process substitution seen outside single quotes. */
  readonly substitution: string | undefined;
  /** An extended glob (`@(a|b)`, `!(a)`, `+(a)`) was seen outside quotes; the shell may expand it to any path. */
  readonly extglob: boolean;
}

const WHITESPACE = new Set([" ", "\t", "\r"]);

export function scan(command: string): Scan {
  const parts: Part[] = [];
  let substitution: string | undefined;
  let extglob = false;
  let words: string[] = [];
  let word: string | undefined;
  let sep = "";
  let start = 0;

  const endWord = (): void => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endPart = (end: number, next: string, nextStart: number): void => {
    endWord();
    if (words.length > 0) parts.push({ sep, words, text: command.slice(start, end).trim() });
    words = [];
    sep = next;
    start = nextStart;
  };
  const note = (form: string): void => {
    substitution ??= form;
  };

  let i = 0;
  while (i < command.length) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      word ??= "";
      i += 1;
      while (i < command.length && command.charAt(i) !== '"') {
        const inner = command.charAt(i);
        if (inner === "\\" && i + 1 < command.length) {
          const escaped = command.charAt(i + 1);
          word += '"\\`$'.includes(escaped) ? escaped : `\\${escaped}`;
          i += 2;
          continue;
        }
        if (inner === "`") note("`");
        if (inner === "$" && command.charAt(i + 1) === "(") note("$(");
        word += inner;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "\\") {
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < command.length) word = (word ?? "") + next;
      i += 2;
      continue;
    }
    if (ch === "`") {
      note("`");
      word = (word ?? "") + ch;
      i += 1;
      continue;
    }
    if (ch === "$" && next === "(") {
      note("$(");
      word = (word ?? "") + ch;
      i += 1;
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      note(`${ch}(`);
      word = (word ?? "") + ch;
      i += 1;
      continue;
    }
    if (ch === "(" && word !== undefined && "@!+?*".includes(word.slice(-1)) && word.length > 0) {
      let depth = 0;
      let end = i;
      for (; end < command.length; end += 1) {
        const c = command.charAt(end);
        if (c === "(") depth += 1;
        if (c === ")" && --depth === 0) break;
      }
      extglob = true;
      word += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (WHITESPACE.has(ch)) {
      endWord();
      i += 1;
      continue;
    }
    if (ch === "&" && (command.charAt(i - 1) === ">" || command.charAt(i - 1) === "<" || next === ">")) {
      word = (word ?? "") + ch; // 2>&1 and &> are redirections, not operators
      i += 1;
      continue;
    }
    if (ch === "&" && next === "&") {
      endPart(i, "&&", i + 2);
      i += 2;
      continue;
    }
    if (ch === "|" && (next === "|" || next === "&")) {
      endPart(i, `|${next}`, i + 2);
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "(" || ch === ")") {
      endPart(i, ch === "\n" ? ";" : ch, i + 1);
      i += 1;
      continue;
    }
    word = (word ?? "") + ch;
    i += 1;
  }
  endPart(command.length, "", command.length);
  return { parts, substitution, extglob };
}

const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "builtin", "sudo", "doas"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function baseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

function skipAssignments(words: readonly string[]): readonly string[] {
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words.at(index) ?? "")) index += 1;
  return words.slice(index);
}

/** The part's words as the part itself, then after each wrapper in front. */
export function levels(words: readonly string[]): ReadonlyArray<readonly string[]> {
  const result: Array<readonly string[]> = [];
  let current = skipAssignments(words);
  while (current.length > 0) {
    result.push(current);
    if (!WRAPPERS.has(baseName(current.at(0) ?? ""))) break;
    let rest = current.slice(1);
    for (;;) {
      const first = rest.at(0);
      if (first === undefined || !(first.startsWith("-") || ASSIGNMENT.test(first))) break;
      rest = rest.slice(1);
    }
    current = rest;
  }
  return result;
}

const CLUSTER = /^-[A-Za-z0-9]+$/;

function letters(args: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const arg of args) {
    if (CLUSTER.test(arg)) for (const letter of arg.slice(1)) found.add(letter);
  }
  return found;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INLINE_E = new Set(["node", "bun", "osascript"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** The inline-code form a part runs at one wrapper level, or undefined. */
function inlineForm(words: readonly string[]): string | undefined {
  const name = baseName(words.at(0) ?? "");
  const args = words.slice(1);
  if (SHELLS.has(name) && letters(args).has("c")) return `${name} -c`;
  if (/^python[0-9.]*$/.test(name) && letters(args).has("c")) return `${name} -c`;
  if (INLINE_E.has(name) && letters(args).has("e")) return `${name} -e`;
  if (name === "find") {
    const hit = args.find((arg) => FIND_EXEC.has(arg));
    if (hit !== undefined) return `find ${hit}`;
  }
  if (name === "xargs" || name === "eval") return name;
  return undefined;
}

export function inlineFormOf(part: Part): string | undefined {
  for (const level of levels(part.words)) {
    const form = inlineForm(level);
    if (form !== undefined) return form;
  }
  return undefined;
}

function glob(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

interface Segment {
  readonly command: RegExp;
  readonly conditions: readonly string[];
}

export interface Rule {
  readonly text: string;
  readonly segments: readonly Segment[];
}

export function parseRule(text: string): Rule | undefined {
  const segments: Segment[] = [];
  for (const piece of text.split("|")) {
    const words = piece.split(/\s+/).filter((w) => w.length > 0 && w !== "…" && w !== "...");
    const first = words.at(0);
    if (first === undefined) return undefined;
    segments.push({ command: glob(first), conditions: words.slice(1) });
  }
  return { text, segments };
}

function trimSlash(arg: string): string {
  return arg.length > 1 ? arg.replace(/\/+$/, "") || "/" : arg;
}

function segmentMatches(segment: Segment, words: readonly string[]): boolean {
  if (!segment.command.test(baseName(words.at(0) ?? ""))) return false;
  const args = words.slice(1);
  const found = letters(args);
  return segment.conditions.every((condition) => {
    if (CLUSTER.test(condition)) return [...condition.slice(1)].every((letter) => found.has(letter));
    const pattern = glob(condition);
    return args.some((arg) => pattern.test(arg) || pattern.test(trimSlash(arg)));
  });
}

function partMatches(segment: Segment, part: Part): boolean {
  return levels(part.words).some((level) => segmentMatches(segment, level));
}

/** Whether the rule matches the parts starting at `from`. */
function matchesAt(rule: Rule, parts: readonly Part[], from: number): boolean {
  return rule.segments.every((segment, offset) => {
    const part = parts[from + offset];
    if (part === undefined) return false;
    if (offset > 0 && part.sep !== "|" && part.sep !== "|&") return false;
    return partMatches(segment, part);
  });
}

/** The text of the matched parts for the first rule that matches, or undefined. */
export function findDenied(
  rules: readonly Rule[],
  parts: readonly Part[],
): { readonly text: string; readonly rule: string } | undefined {
  for (let from = 0; from < parts.length; from += 1) {
    for (const rule of rules) {
      if (!matchesAt(rule, parts, from)) continue;
      const matched = parts.slice(from, from + rule.segments.length);
      return { text: matched.map((p) => p.text).join(" | "), rule: rule.text };
    }
  }
  return undefined;
}
