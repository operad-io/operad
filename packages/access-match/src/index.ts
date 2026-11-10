/**
 * The access profile matcher. `README.md` holds the tables the tests follow.
 */

import { homedir } from "node:os";
import { posix } from "node:path";
export { COMMAND_SUMMARY_CHARS, SUMMARY_CHARS, COMMAND_NOT_SHOWN, REFUSED_IN_LOG, summarizeCall, firstErrorLine, messageSummary, secretValuesOf, type SummaryOptions } from "./summary.ts";
import { findDenied, inlineFormOf, parseRule, scan, type Rule } from "./command.ts";

/** A one-time permission for the exact call a person was asked about. */
export interface AccessGrant {
  readonly waitId: string;
  readonly kind: "command" | "path";
  readonly value: string;
  /** The tool the person approved; a path grant covers that tool only. */
  readonly tool?: string;
}

export interface AccessProfile {
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
   * tools, a `bash` redirect) asks, as if the directory were in `askPaths`.
   * Deny wins over it.
   */
  readonly readOnly?: boolean | undefined;
  /** Permissions not yet used; the caller uses one up before it lets a call through. */
  readonly grants?: readonly AccessGrant[] | undefined;
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
  const found: { denyPaths?: string[]; denyCommands?: string[]; askCommands?: string[]; askPaths?: string[]; readOnly?: boolean; grants?: AccessGrant[] } = {};
  const readOnly: unknown = Reflect.get(value, "readOnly");
  if (readOnly !== undefined) {
    if (typeof readOnly !== "boolean") return { ok: false, message: "readOnly must be true or false" };
    found.readOnly = readOnly;
  }
  for (const field of ["denyPaths", "denyCommands", "askCommands", "askPaths"] as const) {
    const entry: unknown = Reflect.get(value, field);
    if (entry === undefined) continue;
    if (!Array.isArray(entry) || !entry.every((item): item is string => typeof item === "string")) {
      return { ok: false, message: `${field} must be an array of strings` };
    }
    found[field] = entry;
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

interface Denied {
  readonly entries: ReadonlyArray<{ readonly written: string; readonly path: string }>;
  readonly cwd: string;
  readonly home: string;
}

function checkPath(denied: Denied, path: string): Verdict {
  const normal = normalise(path, denied.cwd, denied.home);
  for (const entry of denied.entries) {
    if (isUnder(normal, entry.path)) {
      return { allow: false, reason: `path "${path}" is under denyPaths entry "${entry.written}"`, rule: entry.written };
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
function readings(word: string): string[] {
  const unredirected = word.replace(REDIRECT, "");
  const found = [word, unredirected];
  const equals = unredirected.indexOf("=");
  if (equals !== -1) found.push(unredirected.slice(equals + 1));
  return found.filter((reading, index) => reading.length > 0 && found.indexOf(reading) === index && pathLike(reading));
}

function checkBash(profile: AccessProfile, command: string, denied: Denied | undefined): Verdict {
  const rules = (profile.denyCommands ?? [])
    .map((text) => parseRule(text))
    .filter((rule): rule is Rule => rule !== undefined);
  const { parts, substitution } = scan(command);

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
    for (const part of parts) {
      for (const word of part.words) {
        for (const reading of readings(word)) {
          const verdict = checkPath(denied, reading);
          if (!verdict.allow) return verdict;
        }
      }
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
 * set (`operad-sandbox.md` decision 4).
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
    for (const part of parts) {
      part.words.forEach((word, index) => {
        const target = redirectTarget(word, part.words.at(index + 1));
        if (target === undefined) return;
        const hit = askedRule(asked, normalise(target, cwd, home));
        if (hit !== undefined && found === undefined) found = { target, rule: hit };
      });
    }
    if (found !== undefined) return ask(`command "${command}" writes "${found.target}", which is under askPaths entry "${found.rule}"`, found.rule);
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

/**
 * Whether one tool call may run under the profile. Pure and lexical. Deny wins
 * over ask and ask over allow: the deny rules and paths are checked first, and
 * `askCommands` only when nothing denied the call.
 */
export function match(given: AccessProfile, call: ToolCall, options: MatchOptions = {}): Verdict {
  const home = options.home ?? homedir();
  // A read-only working directory is a directory whose writes ask.
  const profile: AccessProfile =
    given.readOnly === true ? { ...given, askPaths: [...(given.askPaths ?? []), call.cwd] } : given;
  const entries = (profile.denyPaths ?? [])
    .filter((written) => written.length > 0)
    .map((written) => ({ written, path: normalise(written, call.cwd, home) }));
  const denied: Denied | undefined = entries.length > 0 ? { entries, cwd: call.cwd, home } : undefined;

  if (call.tool === "bash") {
    const command: unknown = call.input["command"];
    if (typeof command !== "string") return ALLOW;
    const verdict = checkBash(profile, command, denied);
    return verdict.allow ? askBash(profile, command, askedPaths(profile, call.cwd, home), call.cwd, home) : verdict;
  }
  if (PATH_TOOLS.has(call.tool)) {
    const path: unknown = call.input["path"] ?? call.input["file_path"];
    if (typeof path === "string" && path.length > 0) {
      if (denied !== undefined) {
        const verdict = checkPath(denied, path);
        if (!verdict.allow) return verdict;
      }
      // Ask comes after deny: a write to a path that is asked about asks.
      const asked = call.tool === "write" || call.tool === "edit" ? askedPaths(profile, call.cwd, home) : undefined;
      const hit = asked === undefined ? undefined : askedRule(asked, normalise(path, call.cwd, home));
      if (hit !== undefined) {
        return { allow: false, ask: true, reason: `path "${path}" is under askPaths entry "${hit}"`, rule: hit, kind: "path", value: path, tool: call.tool };
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
