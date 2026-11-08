/**
 * What `dev` asks a person to know about without a run waiting: a repository
 * whose settings are not valid, a plugin dev needs that the home does not
 * load, and a merge that left serve running older code than the main clone.
 * The pending view builds these each time, so each disappears when it is fixed.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StandingContext, StandingItem } from "@operad-io/engine";
import { isRecord } from "./model.ts";
import { listRepositories } from "./service.ts";
import { hasValidSettings, settingsProblem } from "./settings.ts";

/** A plugin dev starts steps of, so it cannot start work without it. */
export interface RequiredPlugin {
  readonly name: string;
  readonly why: string;
}

/** The plugins dev's steps run through. */
export const REQUIRED_PLUGINS: readonly RequiredPlugin[] = [
  { name: "pool", why: "runs its workers" },
];

/** The required plugins that `loaded` does not contain. */
export function missingPlugins(loaded: readonly string[]): readonly RequiredPlugin[] {
  return REQUIRED_PLUGINS.filter((plugin) => !loaded.includes(plugin.name));
}

function pluginItem(plugin: RequiredPlugin): StandingItem {
  return {
    id: `plugin:${plugin.name}`,
    prompt: `plugin ${plugin.name} is not loaded and dev ${plugin.why} through it: run \`operad plugin enable ${plugin.name}\` and restart serve; until then no new work starts`,
  };
}

/** The serve lock's start time, or undefined when no serve holds the home. */
function serveStartedAt(home: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(home, "serve.lock"), "utf8"));
    return isRecord(raw) && typeof raw.at === "number" ? raw.at : undefined;
  } catch {
    return undefined;
  }
}

function serveCodeDirectory(home: string): string {
  return join(home, "dev", "serve-code");
}

/** One followed merge that changed code serve loads. */
interface ServeCodeRecord {
  readonly at: number;
  readonly repository: string;
  readonly commit: string;
  readonly files: readonly string[];
}

/** Workspace packages whose code a serve of this home loads. */
export function loadedPackages(home: string, codeRoot: string): ReadonlySet<string> {
  const names = new Set<string>(["engine", "cli"]);
  try {
    const raw: unknown = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    const plugins = isRecord(raw) && isRecord(raw.plugins) ? raw.plugins : {};
    for (const entry of Object.values(plugins)) {
      if (!isRecord(entry) || entry.enabled === false) continue;
      const module = entry.module;
      if (typeof module === "string" && module.startsWith("@operad-io/")) {
        names.add(module.slice("@operad-io/".length));
      } else if (typeof module === "string" && (module.startsWith(".") || isAbsolute(module))) {
        // A module given as a path counts when it lies in a package of the code root.
        const inside = relative(join(codeRoot, "packages"), resolve(home, module));
        const name = inside.split(sep)[0];
        if (name !== undefined && name.length > 0 && name !== ".." && !isAbsolute(inside)) {
          names.add(name);
        }
      }
    }
  } catch {
    names.add("dev");
  }
  // Their workspace dependencies are loaded with them.
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined) break;
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(codeRoot, "packages", name, "package.json"), "utf8"),
      );
      const dependencies =
        isRecord(raw) && isRecord(raw.dependencies) ? Object.keys(raw.dependencies) : [];
      for (const dependency of dependencies) {
        if (!dependency.startsWith("@operad-io/")) continue;
        const short = dependency.slice("@operad-io/".length);
        if (!names.has(short)) {
          names.add(short);
          queue.push(short);
        }
      }
    } catch {
      // A package without a readable manifest adds nothing.
    }
  }
  return names;
}

/**
 * True when `file` is code of a loaded package or a schema serve validates
 * with. Tests, docs and the mutation records are not loaded.
 */
export function isServeCode(file: string, packages: ReadonlySet<string>): boolean {
  const parts = file.split("/");
  if (parts[0] !== "packages" || parts.length < 3) return false;
  const name = parts[1];
  if (name === undefined || !packages.has(name)) return false;
  const area = parts[2];
  if (area === "src" || area === "flows" || area === "bin") return true;
  return parts.length === 3 && (parts[2] ?? "").endsWith(".schema.json");
}

export interface ServeCodeMerge {
  readonly home: string;
  /** The repository whose clone serve runs from. */
  readonly codeRoot: string;
  /** The repository the merge landed in. */
  readonly repository: { readonly name: string; readonly path: string };
  readonly from: string;
  readonly to: string;
  readonly files: readonly string[];
  readonly at: number;
}

/** Remembers a followed merge when it changed code serve has loaded. */
export function recordServeCode(merge: ServeCodeMerge): boolean {
  if (merge.from === merge.to) return false;
  if (merge.repository.path !== merge.codeRoot) return false;
  const packages = loadedPackages(merge.home, merge.codeRoot);
  const files = merge.files.filter((file) => isServeCode(file, packages));
  if (files.length === 0) return false;
  const directory = serveCodeDirectory(merge.home);
  mkdirSync(directory, { recursive: true });
  const record: ServeCodeRecord = {
    at: merge.at,
    repository: merge.repository.name,
    commit: merge.to,
    files,
  };
  const file = join(directory, `${merge.at}-${merge.to.slice(0, 12)}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, file);
  return true;
}

function serveCodeRecords(home: string): readonly ServeCodeRecord[] {
  const directory = serveCodeDirectory(home);
  if (!existsSync(directory)) return [];
  const records: ServeCodeRecord[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (
        isRecord(raw) &&
        typeof raw.at === "number" &&
        typeof raw.repository === "string" &&
        typeof raw.commit === "string"
      ) {
        records.push({
          at: raw.at,
          repository: raw.repository,
          commit: raw.commit,
          files: Array.isArray(raw.files) ? raw.files.map(String) : [],
        });
      }
    } catch {
      // A torn record says nothing.
    }
  }
  return records.sort((left, right) => left.at - right.at);
}

/** Records older than the running serve are forgotten. */
function forgetOldRecords(home: string, startedAt: number): void {
  const directory = serveCodeDirectory(home);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const at = Number(name.split("-")[0]);
    if (Number.isFinite(at) && at < startedAt) {
      rmSync(join(directory, name), { force: true });
    }
  }
}

function olderCodeItem(home: string): StandingItem | undefined {
  const startedAt = serveStartedAt(home);
  if (startedAt === undefined) return undefined;
  const newer = serveCodeRecords(home).filter((record) => record.at > startedAt);
  const latest = newer[newer.length - 1];
  if (latest === undefined) {
    forgetOldRecords(home, startedAt);
    return undefined;
  }
  return {
    id: "serve-older",
    prompt: `serve runs older code than main: restart it when no check runs (merged ${latest.commit.slice(0, 7)} in ${latest.repository})`,
  };
}

/** The `standing` hook of the dev plugin. */
export async function devStanding(ctx: StandingContext): Promise<readonly StandingItem[]> {
  const items: StandingItem[] = [];
  for (const repository of await listRepositories(ctx.store)) {
    const problem = settingsProblem(repository.path);
    if (problem === undefined) continue;
    items.push({
      id: `settings:${repository.name}`,
      prompt: hasValidSettings(repository.path)
        ? `the repository settings are not valid: ${problem}; the last valid settings are in use (repository ${repository.name})`
        : `the repository settings are not valid: ${problem}; no valid settings were read before, so nothing starts in it until the file is fixed (repository ${repository.name})`,
    });
  }
  for (const plugin of missingPlugins(ctx.loaded)) items.push(pluginItem(plugin));
  const older = olderCodeItem(ctx.home);
  if (older !== undefined) items.push(older);
  return items;
}
