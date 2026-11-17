/**
 * The access profile matcher. `README.md` holds the tables the tests follow.
 */

import { homedir } from "node:os";
import { posix } from "node:path";
export { isReadOnlyCommand } from "./readonly.ts";
export { COMMAND_SUMMARY_CHARS, SUMMARY_CHARS, COMMAND_NOT_SHOWN, REFUSED_IN_LOG, summarizeCall, firstErrorLine, messageSummary, secretValuesOf, type SummaryOptions } from "./summary.ts";
export { OUTWARD_REJECT_ONCE, OUTWARD_SEND_ONCE, declaredOutward, guardDeclaredOutward, guardOutward, outwardAllowed, outwardCommandWrites, outwardQuestion, personStarted, type OutwardGuardContext, type OutwardQuestionOptions } from "./outward.ts";
import type { OutwardWrite } from "@operad-io/engine";
export type { OutwardWrite } from "@operad-io/engine";
import { outwardAllowed, outwardCommandWrites } from "./outward.ts";
import { isReadOnlyCommand } from "./readonly.ts";
import { findDenied, inlineFormOf, parseRule, scan, type Part, type Rule } from "./command.ts";

/**
 * The rules of the built-in default profile. A chat and a generated step start
 * from these; a bot, a repository or a flow may add to them, never remove them
 * (ADR 0025).
 */
const DEFAULT_DENY_PATHS = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.config/gh",
  "~/.radian",
  "~/Library/Keychains",
  "~/Library/Application Support/Google/Chrome",
  "~/Library/Application Support/Firefox",
  "~/Library/Safari",
  ".git/config",
  ".git/hooks",
] as const;

const DEFAULT_DENY_COMMANDS = [
  "sudo",
  "su",
  "rm -rf /",
  "rm -rf ~",
  "mkfs",
  "dd",
  "diskutil",
  "shutdown",
  "reboot",
  "launchctl",
  "crontab -r",
  "git push --force*",
  "git push --delete",
  "curl … | sh",
  "wget … | sh",
  "pkill",
  "killall",
] as const;

const DEFAULT_ASK_COMMANDS = ["git push", "brew install", "npm install -g", "pip install", "osascript", "open"] as const;

const DEFAULT_ASK_PATHS = ["~/.zshrc", "~/.*profile"] as const;

/** Shell commands that write outside operad; a git push target is its remote and branch. */
const DEFAULT_OUTWARD_COMMANDS = [
  "git push",
  "gh pr create",
  "gh pr comment",
  "gh issue create",
  "gh issue comment",
  "gh release create",
  "curl",
  "wget",
  "mail",
  "mailx",
  "sendmail",
] as const;

/** Targets a background run may write to without asking; `owner` is the owner's own channels. */
const DEFAULT_OUTWARD_ALLOW = ["owner"] as const;

/** The access levels a chat may set, in the order a menu shows them. */
export const ACCESS_LEVELS = ["plan", "ask", "edits", "full"] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Whether a value names one of the access levels. */
export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === "string" && (ACCESS_LEVELS as readonly string[]).includes(value);
}

/**
 * A chat's profile with its level composed into it. The profile is first
 * tightened with the built-in default, so every level, `full` included, keeps
 * its deny and ask rules. The level itself only adds asks.
 */
export function withAccessLevel<T extends AccessProfile>(
  profile: T,
  level: AccessLevel,
): T & { readonly level: AccessLevel } {
  return {
    ...withDefaultAccess(profile),
    level,
    ...(level === "plan" ? { readOnly: true } : {}),
  } as T & { readonly level: AccessLevel };
}

/** A one-time permission for the exact call a person was asked about. */
export interface AccessGrant {
  readonly waitId: string;
  readonly kind: "command" | "path";
  readonly value: string;
  /** The tool the person approved; a path grant covers that tool only. */
  readonly tool?: string;
}

/**
 * A call a person allowed always, from the access profile's user layer. A
 * command entry is the exact command text and its working directory; a path
 * entry is the tool, the path and the working directory
 * (ADR 0025 D3 and D7).
 */
export interface AlwaysAllowEntry {
  readonly kind: "command" | "path";
  readonly value: string;
  readonly cwd: string;
  /** The tool a path entry names; absent for a command entry. */
  readonly tool?: string;
}

export interface AccessProfile {
  /**
   * A chat's access level. It adds asks to the profile and removes none; see
   * the level rules in `REFERENCE.md`.
   */
  readonly level?: AccessLevel | undefined;
  readonly denyPaths?: readonly string[] | undefined;
  readonly denyCommands?: readonly string[] | undefined;
  /** Command rules in the shape of `denyCommands`; a match asks a person instead of refusing. */
  readonly askCommands?: readonly string[] | undefined;
  /**
   * Paths a write asks about (`~/.zshrc`, `~/.*profile`): `*` matches within one
   * path segment, and a path under a match counts. Judged for the `write` and
   * `edit` tools, and for a `bash` redirect (`>`, `>>`) to such a path.
   */
  readonly askPaths?: readonly string[] | undefined;
  /**
   * The working directory is read-only: a write there (the `write` and `edit`
   * tools, a `bash` redirect) asks, as if the directory were in `askPaths`; a
   * `bash` command asks unless `isReadOnlyCommand` says it only reads.
   * Deny wins over it.
   */
  readonly readOnly?: boolean | undefined;
  /**
   * Directories the agent may read although `denyPaths` covers them (an
   * ancestor of one is denied): a read tool (`read`, `grep`, `find`, `ls`) or a
   * `bash` command that only reads may touch a path under one. Writes there ask,
   * and every other denied path stays denied.
   */
  readonly readPaths?: readonly string[] | undefined;
  /**
   * The MCP tools that run without asking, as `<server>.<tool>` or `<server>.*`.
   * Having the field at all (even empty) puts MCP tools under the profile: a tool
   * not listed counts as a write and asks (the MCP-tool rule in
   * `docs/backlog/operad-sandbox.md`, not in an ADR yet).
   */
  readonly allowMcp?: readonly string[] | undefined;
  /**
   * Targets a background run may write to without asking: a channel and
   * conversation (`telegram:123`), an address, a repository and branch
   * (`origin/main`), or a service. `owner` stands for the owner's own channels.
   */
  readonly outwardAllow?: readonly string[] | undefined;
  /** Shell commands that write outside operad; a git push names its remote and branch. */
  readonly outwardCommands?: readonly string[] | undefined;
  /**
   * Set by a harness on a run no person's message started. It makes an outward
   * shell command or MCP tool ask even when no other rule does, and it makes
   * the matcher ignore `alwaysAllow` (ADR 0025 D3 and D10).
   */
  readonly background?: boolean | undefined;
  /** Permissions not yet used; the caller uses one up before it lets a call through. */
  readonly grants?: readonly AccessGrant[] | undefined;
  /**
   * Calls a person answered `allow_always` for: they run without asking, and
   * only after every deny passed. The harness leaves them out in a background
   * run (`docs/backlog/operad-sandbox.md` for the background run; ADR 0025 D7
   * for the user layer).
   */
  readonly alwaysAllow?: readonly AlwaysAllowEntry[] | undefined;
}

/** The built-in default access profile every chat and generated step starts from. */
export function defaultAccess(): AccessProfile {
  return {
    denyPaths: [...DEFAULT_DENY_PATHS],
    denyCommands: [...DEFAULT_DENY_COMMANDS],
    askCommands: [...DEFAULT_ASK_COMMANDS],
    askPaths: [...DEFAULT_ASK_PATHS],
    outwardCommands: [...DEFAULT_OUTWARD_COMMANDS],
    outwardAllow: [...DEFAULT_OUTWARD_ALLOW],
  };
}

function combined(
  base: readonly string[] | undefined,
  extra: readonly string[] | undefined,
): string[] | undefined {
  if (base === undefined && extra === undefined) return undefined;
  const list = [...(base ?? [])];
  for (const entry of extra ?? []) if (!list.includes(entry)) list.push(entry);
  return list;
}

/**
 * The built-in default with `profile`'s rules added. It keeps every deny and
 * ask of the default; a field the default does not set is kept as given.
 */
export function withDefaultAccess<T extends AccessProfile>(profile?: T | undefined): T & AccessProfile {
  const base = defaultAccess();
  const denyPaths = combined(base.denyPaths, profile?.denyPaths);
  const denyCommands = combined(base.denyCommands, profile?.denyCommands);
  const askCommands = combined(base.askCommands, profile?.askCommands);
  const askPaths = combined(base.askPaths, profile?.askPaths);
  const readPaths = combined(base.readPaths, profile?.readPaths);
  const outwardCommands = combined(base.outwardCommands, profile?.outwardCommands);
  const outwardAllow = combined(base.outwardAllow, profile?.outwardAllow);
  const readOnly = base.readOnly === true || profile?.readOnly === true;
  return {
    ...(profile ?? {}),
    denyPaths,
    denyCommands,
    askCommands,
    askPaths,
    ...(readPaths === undefined ? {} : { readPaths }),
    ...(outwardCommands === undefined ? {} : { outwardCommands }),
    ...(outwardAllow === undefined ? {} : { outwardAllow }),
    ...(profile?.background === true ? { background: true } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(base.allowMcp === undefined
      ? profile?.allowMcp === undefined
        ? {}
        : { allowMcp: profile.allowMcp }
      : { allowMcp: profile?.allowMcp ?? base.allowMcp }),
  } as T & AccessProfile;
}

export interface ToolCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}

/**
 * What the profile says about one call. The precedence is fixed: a deny wins
 * over an ask, and an ask wins over an allow. So a call that matches
 * `denyCommands` or `denyPaths` anywhere is refused whatever `askCommands` or
 * `askPaths` say; a call that matches only those asks; every other call is
 * allowed. A caller that does not know `ask` reads it as a refusal
 * (`allow: false`), never as a pass.
 */
export type Verdict =
  | { readonly allow: true; readonly ask?: undefined }
  | {
      readonly allow: false;
      readonly ask?: undefined;
      readonly reason: string;
      /** The profile rule that refused, as the profile wrote it; never part of the call. */
      readonly rule?: string;
    }
  | {
      readonly allow: false;
      readonly ask: true;
      readonly reason: string;
      /** The `askCommands` or `askPaths` rule that matched, or `inline code` when the command hides what it runs. */
      readonly rule: string;
      /**
       * What a person is asked about: the whole command of a `bash` call, or the
       * path as the call wrote it with the `tool` that writes it.
       */
      readonly kind: "command" | "path";
      readonly value: string;
      readonly tool?: string;
      /** The outward write this question is about, when the run is a background run. */
      readonly outward?: OutwardWrite | undefined;
    };

export interface MatchOptions {
  /** What `~` means; defaults to the user's home directory. */
  readonly home?: string | undefined;
}

export type ProfileRead =
  | { readonly ok: true; readonly profile: AccessProfile }
  | { readonly ok: false; readonly message: string };

/** Reads the fields the matcher uses from an untrusted object. */
export function readProfile(value: unknown): ProfileRead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "the access profile must be an object" };
  }
  const found: { level?: AccessLevel; denyPaths?: string[]; denyCommands?: string[]; askCommands?: string[]; askPaths?: string[]; readPaths?: string[]; allowMcp?: string[]; outwardAllow?: string[]; outwardCommands?: string[]; readOnly?: boolean; background?: boolean; grants?: AccessGrant[]; alwaysAllow?: AlwaysAllowEntry[] } = {};
  const level: unknown = Reflect.get(value, "level");
  if (level !== undefined) {
    if (!isAccessLevel(level)) {
      return { ok: false, message: `level must be one of ${ACCESS_LEVELS.join(", ")}` };
    }
    found.level = level;
  }
  const readOnly: unknown = Reflect.get(value, "readOnly");
  if (readOnly !== undefined) {
    if (typeof readOnly !== "boolean") return { ok: false, message: "readOnly must be true or false" };
    found.readOnly = readOnly;
  }
  const background: unknown = Reflect.get(value, "background");
  if (background !== undefined) {
    if (typeof background !== "boolean") return { ok: false, message: "background must be true or false" };
    found.background = background;
  }
  for (const field of ["denyPaths", "denyCommands", "askCommands", "askPaths", "readPaths", "allowMcp", "outwardAllow", "outwardCommands"] as const) {
    const entry: unknown = Reflect.get(value, field);
    if (entry === undefined) continue;
    if (!Array.isArray(entry) || !entry.every((item): item is string => typeof item === "string")) {
      return { ok: false, message: `${field} must be an array of strings` };
    }
    found[field] = entry;
  }
  const alwaysAllow: unknown = Reflect.get(value, "alwaysAllow");
  if (alwaysAllow !== undefined) {
    if (!Array.isArray(alwaysAllow)) return { ok: false, message: "alwaysAllow must be an array" };
    const read: AlwaysAllowEntry[] = [];
    for (const entry of alwaysAllow) {
      if (typeof entry !== "object" || entry === null) {
        return { ok: false, message: "each alwaysAllow entry must be an object" };
      }
      const kind: unknown = Reflect.get(entry, "kind");
      const text: unknown = Reflect.get(entry, "value");
      const cwd: unknown = Reflect.get(entry, "cwd");
      const tool: unknown = Reflect.get(entry, "tool");
      if ((kind !== "command" && kind !== "path") || typeof text !== "string" || text.length === 0) {
        return { ok: false, message: "each alwaysAllow entry needs a kind (command or path) and a value" };
      }
      if (typeof cwd !== "string" || cwd.length === 0) {
        return { ok: false, message: "each alwaysAllow entry needs the working directory it was allowed in" };
      }
      if (kind === "path" && (typeof tool !== "string" || tool.length === 0)) {
        return { ok: false, message: "an alwaysAllow path entry needs the tool it was allowed for" };
      }
      read.push({
        kind,
        value: text,
        cwd,
        ...(kind === "path" ? { tool: tool as string } : {}),
      });
    }
    found.alwaysAllow = read;
  }
  const grants: unknown = Reflect.get(value, "grants");
  if (grants !== undefined) {
    if (!Array.isArray(grants)) return { ok: false, message: "grants must be an array" };
    const read: AccessGrant[] = [];
    for (const grant of grants) {
      if (typeof grant !== "object" || grant === null) {
        return { ok: false, message: "each grant must be an object" };
      }
      const waitId: unknown = Reflect.get(grant, "waitId");
      const kind: unknown = Reflect.get(grant, "kind");
      const text: unknown = Reflect.get(grant, "value");
      if (
        typeof waitId !== "string" ||
        (kind !== "command" && kind !== "path") ||
        typeof text !== "string"
      ) {
        return { ok: false, message: "each grant needs a waitId, a kind (command or path) and a value" };
      }
      const tool: unknown = Reflect.get(grant, "tool");
      if (tool !== undefined && typeof tool !== "string") {
        return { ok: false, message: "a grant's tool must be a string" };
      }
      read.push({ waitId, kind, value: text, ...(tool === undefined ? {} : { tool }) });
    }
    found.grants = read;
  }
  return { ok: true, profile: found };
}

const ALLOW: Verdict = { allow: true };

function normalise(path: string, cwd: string, home: string): string {
  let expanded = path;
  if (path === "~") expanded = home;
  else if (path.startsWith("~/")) expanded = `${home}${path.slice(1)}`;
  return posix.resolve(cwd, expanded);
}

function isUnder(path: string, entry: string): boolean {
  return path === entry || path.startsWith(entry === "/" ? "/" : `${entry}/`);
}

/** Whether a person allowed this exact call always; never a deny, and never another cwd. */
function alwaysAllowed(profile: AccessProfile, call: ToolCall): boolean {
  for (const entry of profile.alwaysAllow ?? []) {
    if (entry.cwd !== call.cwd) continue;
    if (entry.kind === "command") {
      if (call.tool === "bash" && call.input["command"] === entry.value) return true;
      if (call.tool === MCP_TOOL) {
        const server: unknown = call.input["server"];
        const tool: unknown = call.input["tool"];
        if (typeof server === "string" && typeof tool === "string" && mcpCallValue(server, tool) === entry.value) {
          return true;
        }
      }
      continue;
    }
    if (call.tool !== entry.tool) continue;
    const path: unknown = call.input["path"] ?? call.input["file_path"];
    if (typeof path === "string" && path === entry.value) return true;
  }
  return false;
}

interface Denied {
  readonly entries: ReadonlyArray<{ readonly written: string; readonly path: string }>;
  readonly cwd: string;
  readonly home: string;
  /** Normalised directories this call may read through a deny (`readPaths`). */
  readonly readable: readonly string[];
}

function checkPath(denied: Denied, path: string, cwd: string = denied.cwd, written: string = path): Verdict {
  const normal = normalise(path, cwd, denied.home);
  if (denied.readable.some((entry) => isUnder(normal, entry))) return ALLOW;
  for (const entry of denied.entries) {
    if (isUnder(normal, entry.path)) {
      return { allow: false, reason: `path "${written}" is under denyPaths entry "${entry.written}"`, rule: entry.written };
    }
  }
  return ALLOW;
}

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const REDIRECT = /^(?:\d*|&)(?:>>|>|<)&?/;

function pathLike(word: string): boolean {
  return word.includes("/") || word.startsWith("~") || word.startsWith(".");
}

/** The readings of one word that may be a path: itself, minus a redirect, after `=`. */
function readings(word: string, home: string): string[] {
  const unredirected = word.replace(REDIRECT, "");
  const found = [word, unredirected];
  const equals = unredirected.indexOf("=");
  if (equals !== -1) found.push(unredirected.slice(equals + 1));
  return found.filter(
    (reading, index) => reading.length > 0 && found.indexOf(reading) === index && pathLike(expandWord(reading, home).text),
  );
}

interface Expanded {
  readonly text: string;
  /** Still holds an expansion the matcher cannot resolve. */
  readonly unresolved: boolean;
  /** A simple glob character (`*`, `?`, `[`) in any component. */
  readonly glob: boolean;
  /** A simple glob character in a component before the last. */
  readonly dirGlob: boolean;
}

const GLOB_META = /[*?[{]|[@!+]\(/;

/** Expands `~`, `$HOME` and `${HOME}` to `home`; reports what else a shell would still expand. */
function expandWord(word: string, home: string): Expanded {
  let text = word;
  if (text === "~") text = home;
  else if (text.startsWith("~/")) text = `${home}${text.slice(1)}`;
  text = text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, () => home);
  const tilde = text.startsWith("~");
  const meta = text.search(GLOB_META);
  // A `..` after a glob can climb out of whatever the glob matched, so the literal prefix says nothing.
  const climbs = meta !== -1 && /(^|\/)\.\.(\/|$)/.test(text.slice(meta));
  const unresolved = tilde || climbs || /\$[A-Za-z0-9_{(@*#?$!-]|`/.test(text);
  return { text, unresolved, glob: meta !== -1, dirGlob: meta !== -1 };
}

/**
 * A glob word is judged by the literal text before its first metacharacter,
 * not by evaluating the pattern: refused when a denied entry starts with that
 * prefix or the prefix starts with a denied entry.
 */
function checkGlob(denied: Denied, text: string, cwd: string, written: string): Verdict {
  const prefix = text.slice(0, text.search(GLOB_META));
  const absolute = posix.normalize(prefix.startsWith("/") ? prefix : `${cwd}/${prefix}`);
  if (denied.readable.some((entry) => isUnder(absolute, entry))) return ALLOW;
  for (const entry of denied.entries) {
    if (entry.path.startsWith(absolute) || absolute.startsWith(entry.path)) {
      return { allow: false, reason: `path "${written}" can match a path under denyPaths entry "${entry.written}"`, rule: entry.written };
    }
  }
  return ALLOW;
}

const CD_GLOB = /[*?[\]{]|[@!+]\(/;

/**
 * Words that can change the shell's directory in a way the matcher does not
 * model: compound commands, function and script runners, wrappers and the
 * directory stack. A part that starts with one makes the directory unknown.
 */
const UNMODELLED = new Set([
  "{", "}", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select",
  "function", "time", "coproc", "!", "[[", "eval", "source", ".", "exec", "builtin", "command", "env", "pushd", "popd", "trap",
]);

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface BashWord {
  readonly word: string;
  readonly next: string | undefined;
  /** Position in its part; 0 is the command name. */
  readonly index: number;
  /** The directory relative paths of this word mean; undefined once the directory is unknown. */
  readonly dir: string | undefined;
}

/**
 * The words of a command with the directory each is read in, and whether a
 * `cd` target could not be resolved. Only a plain top-level `cd <path>` in a
 * chain is modelled; anything else that can change the directory makes it
 * unknown for the rest of the command (`README.md`).
 */
function bashWords(parts: readonly Part[], cwd: string, home: string): { words: BashWord[]; unresolvedCd: boolean } {
  const words: BashWord[] = [];
  let dir: string | undefined = cwd;
  let unresolvedCd = false;
  parts.forEach((part, at) => {
    const here = dir;
    part.words.forEach((word, index) => words.push({ word, next: part.words.at(index + 1), index, dir: here }));
    if (dir === undefined) return;
    if (part.sep === "(" || part.sep === ")") {
      dir = undefined;
      return;
    }
    let start = 0;
    while (start < part.words.length && ASSIGNMENT_WORD.test(part.words.at(start) ?? "")) start += 1;
    if (part.words.some((word) => word.startsWith("CDPATH=") || word === "CDPATH")) {
      dir = undefined;
      return;
    }
    const name = part.words.at(start) ?? "";
    if (UNMODELLED.has(name)) {
      dir = undefined;
      return;
    }
    if (name !== "cd") return;
    // A cd in a pipeline or in the background runs in a subshell.
    const after = parts.at(at + 1)?.sep;
    if (part.sep === "|" || part.sep === "|&" || part.sep === "&" || after === "|" || after === "|&" || after === "&") {
      dir = undefined;
      return;
    }
    const operands = part.words.slice(start + 1).filter((word) => word !== "--" && !/^-[LPe@]+$/.test(word));
    const target = operands.at(0);
    if (target === undefined || target === "-") {
      dir = undefined;
      return;
    }
    const expanded = expandWord(target, home);
    if (expanded.unresolved || CD_GLOB.test(expanded.text)) {
      unresolvedCd = true;
      dir = undefined;
      return;
    }
    dir = posix.resolve(dir, expanded.text);
  });
  return { words, unresolvedCd };
}

function checkBash(profile: AccessProfile, command: string, denied: Denied | undefined): Verdict {
  const rules = (profile.denyCommands ?? [])
    .map((text) => parseRule(text))
    .filter((rule): rule is Rule => rule !== undefined);
  const { parts, substitution, extglob, ansiC } = scan(command);

  if ((profile.denyCommands ?? []).length > 0) {
    if (substitution !== undefined) {
      return {
        allow: false,
        reason: `command "${command}" runs inline code (${substitution}); it is refused while denyCommands is set`,
      };
    }
    for (const part of parts) {
      const form = inlineFormOf(part);
      if (form !== undefined) {
        return {
          allow: false,
          reason: `part "${part.text}" runs inline code (${form}); it is refused while denyCommands is set`,
        };
      }
    }
    const hit = findDenied(rules, parts);
    if (hit !== undefined) {
      return { allow: false, reason: `part "${hit.text}" is refused by denyCommands rule "${hit.rule}"`, rule: hit.rule };
    }
  }

  if (denied !== undefined) {
    const { words, unresolvedCd } = bashWords(parts, denied.cwd, denied.home);
    let unresolved = unresolvedCd ? "a cd target" : substitution === undefined ? undefined : `a command substitution (${substitution})`;
    if (extglob) unresolved ??= "an extended glob";
    if (ansiC) unresolved ??= "a $'…' word with escapes";
    for (const { word, index, dir } of words) {
      if (dir === undefined && (index > 0 ? !word.startsWith("-") : word.includes("/")) && !expandWord(word, denied.home).text.startsWith("/")) {
        unresolved ??= `"${word}" after a directory change it cannot follow`;
      }
      for (const reading of readings(word, denied.home)) {
        const expanded = expandWord(reading, denied.home);
        if (expanded.unresolved) {
          unresolved ??= `"${reading}"`;
          continue;
        }
        const verdict = expanded.glob
          ? checkGlob(denied, expanded.text, dir ?? denied.cwd, reading)
          : checkPath(denied, expanded.text, dir ?? denied.cwd, reading);
        if (!verdict.allow) return verdict;
      }
    }
    // A deny wins over this ask: it is only reached when no path was denied.
    if (unresolved !== undefined) {
      return {
        allow: false,
        ask: true,
        reason: `command "${command}" uses ${unresolved}, which holds a shell expansion that cannot be matched against denyPaths; it asks`,
        rule: "inline code",
        kind: "command",
        value: command,
      };
    }
  }
  return ALLOW;
}

interface AskedPaths {
  readonly entries: ReadonlyArray<{ readonly written: string; readonly pattern: RegExp }>;
}

/** The `askPaths` entries as patterns over normalised paths; `*` stays within a segment. */
function askedPaths(profile: AccessProfile, cwd: string, home: string): AskedPaths | undefined {
  const entries = (profile.askPaths ?? [])
    .filter((written) => written.length > 0)
    .map((written) => {
      const source = normalise(written, cwd, home)
        .split("*")
        .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      return { written, pattern: new RegExp(`^${source}(?:/.*)?$`) };
    });
  return entries.length > 0 ? { entries } : undefined;
}

function askedRule(asked: AskedPaths, normal: string): string | undefined {
  return asked.entries.find((entry) => entry.pattern.test(normal))?.written;
}

/** The path a word or the word after it redirects output to, if it does. */
function redirectTarget(word: string, next: string | undefined): string | undefined {
  const match = /^(?:\d*|&)>>?(.*)$/.exec(word);
  if (match === null) return undefined;
  const glued = match[1] ?? "";
  const target = glued.length > 0 ? glued : next;
  return target !== undefined && target.length > 0 && !target.startsWith("&") ? target : undefined;
}

/**
 * The ask verdict of a command, when no deny applied. A command that hides what
 * it runs (inline code) cannot be matched, so it asks while `askCommands` is
 * set (ADR 0025 D3).
 */
function askBash(profile: AccessProfile, command: string, asked: AskedPaths | undefined, cwd: string, home: string): Verdict {
  const texts = profile.askCommands ?? [];
  let found: { readonly target: string; readonly rule: string } | undefined;
  if (texts.length === 0 && asked === undefined) return ALLOW;
  const rules = texts.map((text) => parseRule(text)).filter((rule): rule is Rule => rule !== undefined);
  const { parts, substitution } = scan(command);
  const ask = (reason: string, rule: string): Verdict => ({ allow: false, ask: true, reason, rule, kind: "command", value: command });
  if (asked !== undefined) {
    // Only a redirect writes by itself: a word after `>` or `>>`, or glued to it.
    const walked = bashWords(parts, cwd, home);
    let unresolved: string | undefined;
    let redirects = false;
    for (const { word, next, dir } of walked.words) {
      const target = redirectTarget(word, next);
      if (target === undefined) continue;
      redirects = true;
      const expanded = expandWord(target, home);
      if (expanded.unresolved || expanded.dirGlob) {
        unresolved ??= `"${target}"`;
        continue;
      }
      if (dir === undefined && !expanded.text.startsWith("/")) {
        unresolved ??= `"${target}"`;
        continue;
      }
      const hit = askedRule(asked, normalise(expanded.text, dir ?? cwd, home));
      if (hit !== undefined && found === undefined) found = { target, rule: hit };
    }
    if (found !== undefined) return ask(`command "${command}" writes "${found.target}", which is under askPaths entry "${found.rule}"`, found.rule);
    if (redirects && walked.unresolvedCd) unresolved ??= "a cd target";
    if (redirects && substitution !== undefined) unresolved ??= `a command substitution (${substitution})`;
    if (unresolved !== undefined) {
      return ask(`command "${command}" writes to ${unresolved}, which holds a shell expansion that cannot be matched against askPaths; it asks`, "inline code");
    }
  }
  if (texts.length === 0) return ALLOW;
  if (substitution !== undefined) {
    return ask(`command "${command}" runs inline code (${substitution}); it asks while askCommands is set`, "inline code");
  }
  for (const part of parts) {
    const form = inlineFormOf(part);
    if (form !== undefined) {
      return ask(`part "${part.text}" runs inline code (${form}); it asks while askCommands is set`, "inline code");
    }
  }
  const hit = findDenied(rules, parts);
  if (hit !== undefined) return ask(`part "${hit.text}" matches askCommands rule "${hit.rule}"`, hit.rule);
  return ALLOW;
}

/** The tool name of a call to an MCP server's tool; its input has `server` and `tool`. */
export const MCP_TOOL = "mcp";

/** The words a person is asked about, and a one-time permission covers, for an MCP tool. */
export function mcpCallValue(server: string, tool: string): string {
  return `mcp ${server}.${tool}`;
}

function matchMcp(profile: AccessProfile, call: ToolCall): Verdict {
  // Only the field's presence puts MCP tools under the profile.
  if (profile.allowMcp === undefined) return ALLOW;
  const server: unknown = call.input["server"];
  const tool: unknown = call.input["tool"];
  if (typeof server !== "string" || typeof tool !== "string") {
    return { allow: false, reason: "an MCP call that names no server and tool cannot be checked" };
  }
  const allowed = profile.allowMcp;
  if (allowed.includes(`${server}.${tool}`) || allowed.includes(`${server}.*`)) return ALLOW;
  return {
    allow: false,
    ask: true,
    reason: `MCP tool "${server}.${tool}" is not on the allowed list; a tool nobody listed counts as a write and asks`,
    rule: "unknown MCP tool",
    kind: "command",
    value: mcpCallValue(server, tool),
  };
}

/**
 * Whether one tool call may run under the profile. Pure and lexical. Deny wins
 * over ask and ask over allow: the deny rules and paths are checked first, and
 * `askCommands` only when nothing denied the call.
 */
/**
 * Whether the level alone makes a write ask. A level never lifts an ask from
 * the profile; the caller checks the profile's own asks first.
 */
function levelAsksWrite(level: AccessLevel | undefined, normal: string, cwd: string): boolean {
  if (level === "ask") return true;
  if (level === "edits") return !isUnder(normal, posix.resolve(cwd));
  return false;
}

export function match(given: AccessProfile, call: ToolCall, options: MatchOptions = {}): Verdict {
  const home = options.home ?? homedir();
  // A read-only working directory is a directory whose writes ask.
  // A directory that may be read is one whose writes ask.
  const readPaths = (given.readPaths ?? []).filter((written) => written.length > 0);
  const readOnly = given.readOnly === true || given.level === "plan";
  const asking = [...(readOnly ? [call.cwd] : []), ...readPaths];
  const profile: AccessProfile =
    asking.length > 0 ? { ...given, askPaths: [...(given.askPaths ?? []), ...asking] } : given;
  const entries = (profile.denyPaths ?? [])
    .filter((written) => written.length > 0)
    .map((written) => ({ written, path: normalise(written, call.cwd, home) }));
  // Only a call that reads may go through a deny by way of `readPaths`.
  const reads =
    call.tool === "bash"
      ? typeof call.input["command"] === "string" && isReadOnlyCommand(call.input["command"])
      : call.tool === "read" || call.tool === "grep" || call.tool === "find" || call.tool === "ls";
  const readable = reads ? readPaths.map((written) => normalise(written, call.cwd, home)) : [];
  const denied: Denied | undefined = entries.length > 0 ? { entries, cwd: call.cwd, home, readable } : undefined;

  if (call.tool === "bash") {
    const command: unknown = call.input["command"];
    if (typeof command !== "string") return ALLOW;
    const verdict = checkBash(profile, command, denied);
    // A deny stays a deny; only an ask can be lifted by an always-allowed entry.
    if (!verdict.allow && verdict.ask !== true) return verdict;
    // A background run ignores the user layer; see ADR 0025 D3 and D10.
    if (given.background !== true && alwaysAllowed(profile, call)) return ALLOW;
    // An outward write not on the allowlist asks even without a matching rule.
    const outward =
      given.background === true
        ? outwardCommandWrites(profile, command).find((write) => !outwardAllowed(profile, write))
        : undefined;
    const withOutward = (found: Verdict): Verdict =>
      found.ask === true && outward !== undefined ? { ...found, outward } : found;
    if (!verdict.allow) return withOutward(verdict);
    const asked = askBash(profile, command, askedPaths(profile, call.cwd, home), call.cwd, home);
    if (!asked.allow) return withOutward(asked);
    // A read-only directory runs only commands known to read.
    if (readOnly && !isReadOnlyCommand(command)) {
      return withOutward({ allow: false, ask: true, reason: "the working directory is read-only and this command is not known to only read", rule: "readOnly", kind: "command", value: command });
    }
    // The level asks about a command not known to only read.
    if ((given.level === "ask" || given.level === "edits") && !isReadOnlyCommand(command)) {
      return withOutward({
        allow: false,
        ask: true,
        reason: `the chat's access level "${given.level}" asks about a command not known to only read`,
        rule: "level",
        kind: "command",
        value: command,
      });
    }
    if (outward !== undefined) {
      return {
        allow: false,
        ask: true,
        reason: `the command writes outside operad to "${outward.target}" and the run was not started by a person`,
        rule: "outward",
        kind: "command",
        value: command,
        outward,
      };
    }
    return asked;
  }
  if (call.tool === MCP_TOOL) {
    // An allow_always answer to an unlisted tool is its exact command entry.
    if (given.background !== true && alwaysAllowed(profile, call)) return ALLOW;
    const found = matchMcp(profile, call);
    if (given.background === true && found.ask === true) {
      const write: OutwardWrite = {
        kind: "service",
        target: found.value,
        content: `the MCP tool "${String(call.input["server"])}.${String(call.input["tool"])}"`,
      };
      if (!outwardAllowed(profile, write)) return { ...found, outward: write };
    }
    return found;
  }
  if (PATH_TOOLS.has(call.tool)) {
    const path: unknown = call.input["path"] ?? call.input["file_path"];
    if (typeof path === "string" && path.length > 0) {
      if (denied !== undefined) {
        const verdict = checkPath(denied, path);
        if (!verdict.allow) return verdict;
      }
      // An always-allowed entry lifts the ask, never a deny.
      if (given.background !== true && alwaysAllowed(profile, call)) return ALLOW;
      // Ask comes after deny: a write to a path that is asked about asks.
      const normal = normalise(path, call.cwd, home);
      const asked = call.tool === "write" || call.tool === "edit" ? askedPaths(profile, call.cwd, home) : undefined;
      const hit = asked === undefined ? undefined : askedRule(asked, normal);
      if (hit !== undefined) {
        return { allow: false, ask: true, reason: `path "${path}" is under askPaths entry "${hit}"`, rule: hit, kind: "path", value: path, tool: call.tool };
      }
      if ((call.tool === "write" || call.tool === "edit") && levelAsksWrite(given.level, normal, call.cwd)) {
        return {
          allow: false,
          ask: true,
          reason: `the chat's access level "${given.level}" asks about this write`,
          rule: "level",
          kind: "path",
          value: path,
          tool: call.tool,
        };
      }
    }
  }
  return ALLOW;
}

/**
 * The unused grant that covers this exact call, if any. A command grant covers
 * a bash call whose command equals the value character for character; a path
 * grant covers a path tool call whose path names the same file. The caller must
 * use the grant up before it lets the call run, and match as usual afterwards.
 */
export function findGrant(profile: AccessProfile, call: ToolCall, options: MatchOptions = {}): AccessGrant | undefined {
  const home = options.home ?? homedir();
  for (const grant of profile.grants ?? []) {
    if (grant.kind === "command") {
      if (call.tool === "bash" && call.input["command"] === grant.value) return grant;
      if (call.tool === MCP_TOOL && mcpCallValue(String(call.input["server"]), String(call.input["tool"])) === grant.value) return grant;
      continue;
    }
    // A path grant covers the tool the person approved and no other.
    if (!PATH_TOOLS.has(call.tool) || grant.tool !== call.tool) continue;
    const path: unknown = call.input["path"] ?? call.input["file_path"];
    if (
      typeof path === "string" &&
      path.length > 0 &&
      normalise(path, call.cwd, home) === normalise(grant.value, call.cwd, home)
    ) {
      return grant;
    }
  }
  return undefined;
}
