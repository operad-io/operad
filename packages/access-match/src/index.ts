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
  /** Permissions not yet used; the caller uses one up before it lets a call through. */
  readonly grants?: readonly AccessGrant[] | undefined;
}

export interface ToolCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}

export type Verdict = { readonly allow: true } | { readonly allow: false; readonly reason: string; /** The profile rule that refused, as the profile wrote it; never part of the call. */ readonly rule?: string };

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
  const found: { denyPaths?: string[]; denyCommands?: string[]; grants?: AccessGrant[] } = {};
  for (const field of ["denyPaths", "denyCommands"] as const) {
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

/** Whether one tool call may run under the profile. Pure and lexical. */
export function match(profile: AccessProfile, call: ToolCall, options: MatchOptions = {}): Verdict {
  const home = options.home ?? homedir();
  const entries = (profile.denyPaths ?? [])
    .filter((written) => written.length > 0)
    .map((written) => ({ written, path: normalise(written, call.cwd, home) }));
  const denied: Denied | undefined = entries.length > 0 ? { entries, cwd: call.cwd, home } : undefined;

  if (call.tool === "bash") {
    const command: unknown = call.input["command"];
    return typeof command === "string" ? checkBash(profile, command, denied) : ALLOW;
  }
  if (PATH_TOOLS.has(call.tool) && denied !== undefined) {
    const path: unknown = call.input["path"] ?? call.input["file_path"];
    if (typeof path === "string" && path.length > 0) return checkPath(denied, path);
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
