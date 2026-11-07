/**
 * The access profile matcher. `README.md` holds the tables the tests follow.
 */

import { homedir } from "node:os";
import { posix } from "node:path";
import { findDenied, inlineFormOf, parseRule, scan, type Rule } from "./command.ts";

export interface AccessProfile {
  readonly denyPaths?: readonly string[] | undefined;
  readonly denyCommands?: readonly string[] | undefined;
}

export interface ToolCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}

export type Verdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

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
  const found: { denyPaths?: string[]; denyCommands?: string[] } = {};
  for (const field of ["denyPaths", "denyCommands"] as const) {
    const entry: unknown = Reflect.get(value, field);
    if (entry === undefined) continue;
    if (!Array.isArray(entry) || !entry.every((item): item is string => typeof item === "string")) {
      return { ok: false, message: `${field} must be an array of strings` };
    }
    found[field] = entry;
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
      return { allow: false, reason: `path "${path}" is under denyPaths entry "${entry.written}"` };
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
      return { allow: false, reason: `part "${hit.text}" is refused by denyCommands rule "${hit.rule}"` };
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
