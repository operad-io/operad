/**
 * Profiles: the `assistant` section of `config.json`, read at every use, and
 * what a profile means (its working directory, harness, skills and access
 * profile). The kernel validates the section against {@link ASSISTANT_SETTINGS}
 * when it loads; a reply reads the file again, so an edit applies at once.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { configPath, isRecord, prepareSettings, type ActionArgsSchema, type JsonValue, type ObjectStore } from "@operad-io/engine";

/** The object type of a profile. */
export const PROFILE_TYPE = "profile";

/** The profile every home has. */
export const DEFAULT_PROFILE = "default";

/** The directory of the assistant inside the operad home. */
export const ASSISTANT_DIR = "assistant";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** The JSON Schema of the `assistant` section (also shipped as `assistant.schema.json`). */
export const ASSISTANT_SETTINGS: ActionArgsSchema = {
  type: "object",
  properties: {
    profiles: {
      type: "object",
      editable: true,
      description:
        "The assistant's profiles, by name. `default` exists even when it is not written here.",
      additionalProperties: {
        type: "object",
        description: "One profile.",
        properties: {
          cwd: {
            type: "string",
            minLength: 1,
            description:
              "The working directory. Without it: ~/.operad/assistant for `default`, ~/.operad/assistant/<name> for any other. It must be inside ~/.operad/assistant or outside the operad home.",
          },
          harness: {
            type: "string",
            minLength: 1,
            description: "The harness a new chat uses when it names none.",
          },
          skills: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description:
              "Directories with a SKILL.md, given to the agent at every reply. A relative path is under the working directory.",
          },
          access: {
            type: "object",
            description:
              "Added to the default access profile: the lists are appended and readOnly can be turned on. A profile can tighten the default, never loosen it.",
            properties: {
              denyPaths: { type: "array", items: { type: "string" } },
              denyCommands: { type: "array", items: { type: "string" } },
              askCommands: { type: "array", items: { type: "string" } },
              askPaths: { type: "array", items: { type: "string" } },
              readOnly: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

/** One profile as written. */
export interface ProfileSettings {
  readonly cwd?: string;
  readonly harness?: string;
  readonly skills?: readonly string[];
  readonly access?: Readonly<Record<string, JsonValue>>;
}

/** A profile as a chat uses it. */
export interface ResolvedProfile {
  readonly name: string;
  readonly cwd: string;
  readonly harness: string | null;
  /** Absolute directories, each with a SKILL.md. */
  readonly skills: readonly string[];
  readonly access: Readonly<Record<string, JsonValue>>;
}

/** A profile that cannot be used; the message says why. */
export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/** The `assistant` working directory of a home. */
export function assistantDir(home: string): string {
  return join(home, ASSISTANT_DIR);
}

/**
 * The profiles written in the home's `config.json`, with the default one
 * added when absent. The file is read now; `fallback` (the settings the kernel
 * loaded) stands in only when the file or its section is missing.
 */
export function readProfiles(
  home: string,
  fallback: Readonly<Record<string, JsonValue>> = {},
): Readonly<Record<string, ProfileSettings>> {
  let section: unknown = fallback;
  const path = configPath(home);
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new ProfileError(`${path}: cannot read the assistant settings: ${String(error)}`);
    }
    const plugins = isRecord(parsed) ? parsed.plugins : undefined;
    const entry = isRecord(plugins) ? plugins.assistant : undefined;
    if (isRecord(entry) && entry.settings !== undefined) section = entry.settings;
  }
  const settings = prepareSettings(ASSISTANT_SETTINGS, section, "assistant");
  const profiles = isRecord(settings.profiles) ? settings.profiles : {};
  const found: Record<string, ProfileSettings> = {};
  for (const [name, value] of Object.entries(profiles)) {
    if (!NAME.test(name)) {
      throw new ProfileError(
        `profile "${name}": a name is lowercase letters, digits, "-" and "_", and starts with a letter or digit`,
      );
    }
    found[name] = value as ProfileSettings;
  }
  if (found[DEFAULT_PROFILE] === undefined) found[DEFAULT_PROFILE] = {};
  return found;
}

function expand(path: string, base: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function within(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The default access profile of the assistant: no credentials, no secrets, no
 * operad command (the agent reaches operad through its tools). Everything in
 * the operad home except the assistant's own directory is denied: the names
 * that are there now, and the ones operad keeps there. Paths are absolute, so
 * a home other than `~/.operad` is covered too.
 */
export function defaultAccess(home: string): Record<string, JsonValue> {
  const inHome = new Set(["store", "secrets", "config.json"]);
  if (existsSync(home)) {
    for (const name of readdirSync(home)) if (name !== ASSISTANT_DIR) inHome.add(name);
  }
  return {
    denyPaths: [
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
      ...[...inHome].sort().map((name) => join(home, name)),
    ],
    denyCommands: [
      "operad",
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
    ],
    askCommands: ["git push", "brew install", "npm install -g", "pip install", "osascript", "open"],
    askPaths: ["~/.zshrc", "~/.*profile"],
  };
}

function appended(base: JsonValue | undefined, extra: unknown): JsonValue[] {
  const list = Array.isArray(base) ? [...base] : [];
  if (Array.isArray(extra)) {
    for (const item of extra) if (typeof item === "string" && !list.includes(item)) list.push(item);
  }
  return list;
}

/** The access profile of a profile: the default, tightened by what the profile adds. */
export function accessFor(
  home: string,
  settings: ProfileSettings,
  repositories: readonly string[] = [],
): Record<string, JsonValue> {
  const access = defaultAccess(home);
  // A repository is reached through operad's tools (dev's verbs), never by
  // touching its files, so its path is denied to the agent.
  access.denyPaths = appended(access.denyPaths, repositories);
  const own = settings.access ?? {};
  for (const field of ["denyPaths", "denyCommands", "askCommands", "askPaths"] as const) {
    access[field] = appended(access[field], own[field]);
  }
  if (own.readOnly === true) access.readOnly = true;
  return access;
}

/** The skill directories of a profile, checked now. */
function skillDirectories(settings: ProfileSettings, cwd: string): string[] {
  return (settings.skills ?? []).map((written) => {
    const path = expand(written, cwd);
    const file = join(path, "SKILL.md");
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new ProfileError(`skill "${written}": there is no SKILL.md in ${path}`);
    }
    return path;
  });
}

/** The working directory of a profile; refused when it would put the operad home in reach. */
export function workingDirectory(home: string, name: string, settings: ProfileSettings): string {
  const root = assistantDir(home);
  const cwd =
    settings.cwd === undefined
      ? name === DEFAULT_PROFILE
        ? root
        : join(root, name)
      : expand(settings.cwd, root);
  if (within(home, cwd)) {
    throw new ProfileError(
      `profile "${name}": the working directory ${cwd} is the operad home or holds it; use a subdirectory of ${root}`,
    );
  }
  if (within(cwd, home) && !within(cwd, root)) {
    throw new ProfileError(
      `profile "${name}": the working directory ${cwd} is inside the operad home but outside ${root}`,
    );
  }
  return cwd;
}

/** The paths of the repositories dev knows, from the object store. */
export async function repositoryPaths(store: ObjectStore): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list("repo", { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      if (typeof object.data.path === "string" && object.data.path.length > 0) found.push(object.data.path);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** One profile as a chat uses it now; the working directory is not created here. */
export function resolveProfile(
  home: string,
  name: string,
  settings: ProfileSettings,
  repositories: readonly string[] = [],
): ResolvedProfile {
  const cwd = workingDirectory(home, name, settings);
  return {
    name,
    cwd,
    harness: settings.harness ?? null,
    skills: skillDirectories(settings, cwd),
    access: accessFor(home, settings, repositories),
  };
}
