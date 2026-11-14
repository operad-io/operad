/**
 * Settings read and written through the client API: the sections of
 * `config.json` plugins declare a schema for (global), and the files plugins
 * keep under a registered repository's `.operad/` (project).
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ActionArgsError, validateSchemaValue } from "../plugin/action-schema.ts";
import { configPath } from "../config/config.ts";
import { withLockFile } from "../platform/index.ts";
import type { JsonValue } from "../log/types.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type {
  ActionArgSchema,
  ActionArgsSchema,
  ObjectStore,
  ProjectSettingsFile,
  SettingsRepository,
} from "../plugin/types.ts";
import { isRecord } from "../util.ts";

/** The scope of a setting in `config.json`. */
export const GLOBAL_SCOPE = "global";

/** One setting, as a client lists it. */
export interface SettingInfo {
  /**
   * `<plugin>.<path>`; a project file whose name differs from its plugin adds
   * that name: `<plugin>.<file>.<path>`.
   */
  readonly name: string;
  /** `global`, or the name of the repository the file is in. */
  readonly scope: string;
  readonly value?: JsonValue | undefined;
  readonly default?: JsonValue | undefined;
  readonly description?: string | undefined;
  /** The schema's type and allowed values, so a client can offer a choice list. */
  readonly type?: string | undefined;
  readonly enum?: readonly (string | number | boolean)[] | undefined;
  readonly editable: boolean;
  readonly confirm: boolean;
}

export type SettingsErrorKind =
  | "not-found"
  | "args"
  | "not-available"
  | "confirm"
  | "ambiguous"
  /** The plugin's own check refused the change; the message is its reason. */
  | "refused";

/** A settings call refused; nothing was written. */
export class SettingsError extends Error {
  readonly kind: SettingsErrorKind;

  constructor(kind: SettingsErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SettingsError";
    this.kind = kind;
  }
}

export interface SettingsOptions {
  readonly registry: PluginRegistry;
  readonly store: ObjectStore;
  readonly home: string;
}

/** Hooks a test uses to stop a write between its two steps. */
export interface AtomicWriteHooks {
  /** Called once the temporary file is complete, before it replaces the target. */
  readonly beforeRename?: (() => Promise<void> | void) | undefined;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Writes a file by writing a temporary file in the same directory and renaming
 * it over the target, so a crash leaves the old file whole.
 */
export async function writeFileAtomic(
  path: string,
  text: string,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const mode = await stat(path).then(
    (info) => info.mode & 0o777,
    () => undefined,
  );
  try {
    const handle = await open(temp, "w");
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== undefined) await chmod(temp, mode);
    await hooks.beforeRename?.();
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface Leaf {
  /** The dotted path inside the file's JSON. */
  readonly path: readonly string[];
  readonly schema: ActionArgSchema;
}

/** The settings a schema offers: each property that is not a group of properties. */
function leaves(schema: ActionArgsSchema): Leaf[] {
  const found: Leaf[] = [];
  const walk = (node: ActionArgSchema, path: readonly string[]): void => {
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      const here = [...path, name];
      if (property.properties !== undefined && property.editable !== true) {
        walk(property, here);
      } else {
        found.push({ path: here, schema: property });
      }
    }
  };
  walk(schema, []);
  return found;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Sets a value in place, keeping the order of the keys already there. */
function setAt(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (isRecord(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    }
  }
  const last = path[path.length - 1];
  if (last !== undefined) node[last] = value;
}

interface JsonFile {
  readonly value: Record<string, unknown>;
  readonly indent: string;
  readonly newline: boolean;
}

async function readJsonFile(path: string, absent: () => Record<string, unknown>): Promise<JsonFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { value: absent(), indent: "  ", newline: true };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SettingsError("args", `${path}: invalid JSON: ${String(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new SettingsError("args", `${path}: must be a JSON object`);
  }
  const match = /^[ \t]+(?=")/m.exec(text);
  return {
    value: parsed,
    indent: match?.[0] ?? "  ",
    newline: text.endsWith("\n"),
  };
}

function render(file: JsonFile): string {
  return `${JSON.stringify(file.value, null, file.indent)}${file.newline ? "\n" : ""}`;
}

interface Place {
  readonly scope: string;
  readonly prefix: string;
  readonly schema: ActionArgsSchema;
  /** The file, and where the plugin's settings are inside it. */
  readonly file: string;
  readonly inside: readonly string[];
  readonly fresh: () => Record<string, unknown>;
  /** A project file's repository and the plugin's own hooks for it. */
  readonly project?: {
    readonly repository: SettingsRepository;
    readonly file: ProjectSettingsFile;
  };
}

/** The plugin's own check of the file as it would be written; refuses with its reason. */
async function runCheck(place: Place, value: unknown): Promise<void> {
  const project = place.project;
  const check = project?.file.check;
  if (project === undefined || check === undefined || !isRecord(value)) return;
  const reason = await check({ repository: project.repository, value });
  if (reason !== undefined) throw new SettingsError("refused", reason);
}

async function readPlace(place: Place): Promise<unknown> {
  try {
    const file = await readJsonFile(place.file, place.fresh);
    const stored = valueAt(file.value, place.inside);
    const project = place.project;
    const derived = project?.file.derived;
    if (project !== undefined && derived !== undefined) {
      return {
        ...(isRecord(stored) ? stored : {}),
        ...(await derived({ repository: project.repository, value: file.value })),
      };
    }
    return stored;
  } catch (error) {
    if (error instanceof SettingsError) return undefined;
    throw error;
  }
}

async function places(
  options: SettingsOptions,
  scope: string | undefined,
): Promise<Place[]> {
  const found: Place[] = [];
  const declarations = options.registry.settingsDeclarations();
  if (scope === undefined || scope === GLOBAL_SCOPE) {
    for (const declaration of declarations) {
      if (declaration.schema === undefined) continue;
      found.push({
        scope: GLOBAL_SCOPE,
        prefix: declaration.plugin,
        schema: declaration.schema,
        file: configPath(options.home),
        inside: ["plugins", declaration.plugin, "settings"],
        fresh: () => ({}),
      });
    }
  }
  if (scope === GLOBAL_SCOPE) {
    checkAmbiguous(found);
    return found;
  }

  let named = false;
  const known: string[] = [];
  for (const declaration of declarations) {
    const project = declaration.project;
    if (project === undefined) continue;
    const repositories = await project.repositories({ store: options.store });
    for (const repository of repositories) {
      if (!known.includes(repository.name)) known.push(repository.name);
      if (scope !== undefined && repository.name !== scope) continue;
      named = true;
      for (const file of project.files) {
        found.push({
          scope: repository.name,
          prefix:
            file.name === declaration.plugin
              ? declaration.plugin
              : `${declaration.plugin}.${file.name}`,
          schema: file.schema,
          file: join(repository.path, ".operad", file.path),
          inside: [],
          fresh: () => ({}),
          project: { repository, file },
        });
      }
    }
  }
  if (scope !== undefined && !named) {
    throw new SettingsError(
      "not-found",
      known.length === 0
        ? `no registered repository "${scope}", and none is registered`
        : `no registered repository "${scope}"; registered: ${known.join(", ")}`,
    );
  }
  checkAmbiguous(found);
  return found;
}

function declaredAt(place: Place): string {
  return place.scope === GLOBAL_SCOPE
    ? `the global settings of "${place.prefix}"`
    : `"${place.file}" (${place.prefix})`;
}

/** Refuses names two places in one scope would both claim, before either wins. */
function checkAmbiguous(places: readonly Place[]): void {
  const byScope = new Map<string, Map<string, Place>>();
  for (const place of places) {
    let names = byScope.get(place.scope);
    if (names === undefined) {
      names = new Map();
      byScope.set(place.scope, names);
    }
    for (const leaf of leaves(place.schema)) {
      const name = `${place.prefix}.${leaf.path.join(".")}`;
      const earlier = names.get(name);
      if (earlier !== undefined) {
        throw new SettingsError(
          "ambiguous",
          `setting "${name}" is declared twice in ${
            place.scope === GLOBAL_SCOPE
              ? "the global scope"
              : `repository "${place.scope}"`
          }: ${declaredAt(earlier)} and ${declaredAt(place)}`,
        );
      }
      names.set(name, place);
    }
  }
}

function infoOf(place: Place, leaf: Leaf, section: unknown): SettingInfo {
  const current = valueAt(section, leaf.path) ?? leaf.schema.default;
  return {
    name: `${place.prefix}.${leaf.path.join(".")}`,
    scope: place.scope,
    ...(current === undefined ? {} : { value: current as JsonValue }),
    ...(leaf.schema.default === undefined
      ? {}
      : { default: leaf.schema.default as JsonValue }),
    ...(leaf.schema.description === undefined
      ? {}
      : { description: leaf.schema.description }),
    ...(leaf.schema.type === undefined ? {} : { type: leaf.schema.type }),
    ...(leaf.schema.enum === undefined ? {} : { enum: leaf.schema.enum }),
    editable: leaf.schema.editable === true,
    confirm: leaf.schema.confirm === true,
  };
}

/** Every setting in a scope (all scopes when omitted), with its current value. */
export async function listSettings(
  options: SettingsOptions,
  scope?: string | undefined,
): Promise<SettingInfo[]> {
  const infos: SettingInfo[] = [];
  for (const place of await places(options, scope)) {
    const section = await readPlace(place);
    for (const leaf of leaves(place.schema)) {
      infos.push(infoOf(place, leaf, section));
    }
  }
  return infos;
}

export interface SetOptions {
  readonly scope?: string | undefined;
  readonly confirmed?: boolean | undefined;
  readonly hooks?: AtomicWriteHooks | undefined;
}

/** Changes one setting; refuses, writing nothing, when the value does not fit. */
export async function setSetting(
  options: SettingsOptions,
  name: string,
  value: unknown,
  set: SetOptions = {},
): Promise<SettingInfo> {
  const scope = set.scope ?? GLOBAL_SCOPE;
  let match: { readonly place: Place; readonly leaf: Leaf } | undefined;
  // A name deeper than an editable setting that holds a map or an object
  // changes one entry of it: `bot.bots.<name>` or `bot.bots.<name>.<field>`.
  let deeper: { readonly place: Place; readonly leaf: Leaf; readonly sub: string[] } | undefined;
  for (const place of await places(options, scope)) {
    const prefix = `${place.prefix}.`;
    if (!name.startsWith(prefix)) continue;
    const path = name.slice(prefix.length);
    const found = leaves(place.schema);
    const leaf = found.find((item) => item.path.join(".") === path);
    if (leaf !== undefined) {
      match = { place, leaf };
      break;
    }
    if (deeper === undefined) {
      const parent = found.find(
        (item) =>
          item.schema.editable === true && path.startsWith(`${item.path.join(".")}.`),
      );
      if (parent !== undefined) {
        deeper = {
          place,
          leaf: parent,
          sub: path.slice(parent.path.join(".").length + 1).split("."),
        };
      }
    }
  }
  if (match === undefined && deeper !== undefined) {
    return setEntry(deeper.place, deeper.leaf, deeper.sub, name, value, scope, set);
  }
  if (match === undefined) {
    throw new SettingsError(
      "not-found",
      scope === GLOBAL_SCOPE
        ? `no setting "${name}"`
        : `no setting "${name}" for repository "${scope}"`,
    );
  }
  const { place, leaf } = match;

  if (leaf.schema.editable !== true) {
    throw new SettingsError("not-available", `setting "${name}" cannot be changed here`);
  }
  try {
    validateSchemaValue(leaf.schema, value, name, "value");
  } catch (error) {
    if (error instanceof ActionArgsError) {
      throw new SettingsError("args", error.message.replace(": args.", ": "), {
        cause: error,
      });
    }
    throw error;
  }
  if (leaf.schema.confirm === true && set.confirmed !== true) {
    throw new SettingsError(
      "confirm",
      `setting "${name}" needs confirmation`,
    );
  }

  return withLockFile(`${place.file}.lock`, async () => {
    const file = await readJsonFile(place.file, place.fresh);
    if (place.scope === GLOBAL_SCOPE) {
      const plugins = file.value.plugins;
      const plugin = place.inside[1] ?? "";
      if (!isRecord(plugins)) {
        throw new SettingsError(
          "args",
          `${place.file}: plugins must be an object keyed by plugin name to change a setting`,
        );
      }
      const entry = plugins[plugin];
      if (typeof entry === "string") {
        plugins[plugin] = { module: entry, enabled: true };
      } else if (!isRecord(entry)) {
        throw new SettingsError(
          "not-found",
          `${place.file}: plugin "${plugin}" is not listed`,
        );
      }
    }
    setAt(file.value, [...place.inside, ...leaf.path], value);
    try {
      validateSchemaValue(
        place.schema,
        valueAt(file.value, place.inside),
        name,
        "settings",
      );
    } catch (error) {
      if (error instanceof ActionArgsError) {
        throw new SettingsError("args", error.message.replace(": args.", ": "), {
          cause: error,
        });
      }
      throw error;
    }
    await runCheck(place, valueAt(file.value, place.inside));
    await writeFileAtomic(place.file, render(file), set.hooks);

    return infoOf(place, leaf, valueAt(file.value, place.inside));
  });
}

const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** The schema of the entry `sub` names inside a setting, when the schema declares one. */
function entrySchema(
  schema: ActionArgSchema,
  sub: readonly string[],
): ActionArgSchema | undefined {
  let node: ActionArgSchema | undefined = schema;
  for (const key of sub) {
    // Never a key that names something every object inherits.
    if (key.length === 0 || UNSAFE_KEYS.has(key) || node === undefined) return undefined;
    const next: ActionArgSchema | undefined = node.properties?.[key];
    node =
      next ??
      (typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
  }
  return node;
}

function refuseArgs(error: unknown): never {
  if (error instanceof ActionArgsError) {
    throw new SettingsError("args", error.message.replace(": args.", ": "), {
      cause: error,
    });
  }
  throw error;
}

/**
 * Changes one entry inside an editable setting, under the same rules as the
 * setting (editable, confirm, schema). The file is read and written under its
 * lock, so another entry changed meanwhile is kept. `null` removes the entry.
 */
async function setEntry(
  place: Place,
  parent: Leaf,
  sub: readonly string[],
  name: string,
  value: unknown,
  scope: string,
  set: SetOptions,
): Promise<SettingInfo> {
  const schema = entrySchema(parent.schema, sub);
  if (schema === undefined) {
    throw new SettingsError(
      "not-found",
      scope === GLOBAL_SCOPE
        ? `no setting "${name}"`
        : `no setting "${name}" for repository "${scope}"`,
    );
  }
  const remove = value === null;
  if (!remove) {
    try {
      validateSchemaValue(schema, value, name, "value");
    } catch (error) {
      refuseArgs(error);
    }
  }
  if (parent.schema.confirm === true && set.confirmed !== true) {
    throw new SettingsError("confirm", `setting "${name}" needs confirmation`);
  }
  const path = [...parent.path, ...sub];
  const leaf: Leaf = {
    path,
    schema: { ...schema, editable: true, confirm: parent.schema.confirm === true },
  };
  return withLockFile(`${place.file}.lock`, async () => {
    const file = await readJsonFile(place.file, place.fresh);
    if (place.scope === GLOBAL_SCOPE) {
      const plugins = file.value.plugins;
      const plugin = place.inside[1] ?? "";
      if (!isRecord(plugins)) {
        throw new SettingsError(
          "args",
          `${place.file}: plugins must be an object keyed by plugin name to change a setting`,
        );
      }
      const entry = plugins[plugin];
      if (typeof entry === "string") {
        plugins[plugin] = { module: entry, enabled: true };
      } else if (!isRecord(entry)) {
        throw new SettingsError(
          "not-found",
          `${place.file}: plugin "${plugin}" is not listed`,
        );
      }
    }
    if (remove) {
      const holder = valueAt(valueAt(file.value, place.inside), path.slice(0, -1));
      const last = path[path.length - 1];
      if (isRecord(holder) && last !== undefined) delete holder[last];
    } else {
      setAt(file.value, [...place.inside, ...path], value);
    }
    try {
      validateSchemaValue(place.schema, valueAt(file.value, place.inside), name, "settings");
    } catch (error) {
      refuseArgs(error);
    }
    await runCheck(place, valueAt(file.value, place.inside));
    await writeFileAtomic(place.file, render(file), set.hooks);
    return infoOf(place, leaf, valueAt(file.value, place.inside));
  });
}
