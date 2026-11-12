/**
 * The checks a registry runs on each plugin definition before it uses one: the
 * normalization of the fields a plugin declares, and the rules that span all
 * plugins of a set.
 */
import { ALL_FILTER } from "./filters.ts";
import type { FlowDefinition, StepType } from "../flow/types.ts";
import { FlowError, validateFlow } from "../flow/validate.ts";
import { normalizeActionArgs, noteProperty } from "./action-schema.ts";
import { messageOf, PluginError } from "./errors.ts";
import { isRangeSyntax } from "./semver.ts";
import { END_RESULTS, isEndResult } from "./usage.ts";
import { parseTriggerRules, TriggerError } from "../trigger/rules.ts";
import type { TriggerRule } from "../trigger/types.ts";
import {
  OPERAD_PLUGIN_VERSION,
  type ActionArgsSchema,
  type ActionTypeDefinition,
  type AskRequest,
  type CommandDefinition,
  type KeyBindings,
  type MaybePromise,
  type ObjectFilterDefinition,
  type ObjectTypeDefinition,
  type ObjectViews,
  type PluginBaseContext,
  type PluginKind,
  type PluginRequires,
  type ProjectSettingsDeclaration,
  type SourceContext,
  type SourceHandle,
  type StandingContext,
  type StandingItem,
  type StepLimitDefinition,
  type StepTypeDefinition,
  type TickContext,
} from "./types.ts";
import { isRecord } from "../util.ts";

export interface NormalizedPlugin {
  readonly name: string;
  readonly kind: PluginKind;
  readonly version: string;
  readonly objects: readonly ObjectTypeDefinition[];
  readonly actions: readonly ActionTypeDefinition[];
  readonly steps: readonly StepTypeDefinition[];
  readonly flows: readonly unknown[];
  readonly commands: readonly CommandDefinition[];
  readonly views: Readonly<Record<string, ObjectViews>>;
  readonly keys: KeyBindings;
  readonly rules: readonly TriggerRule[];
  readonly onTick: ((ctx: TickContext) => MaybePromise<void>) | undefined;
  readonly standing:
    | ((ctx: StandingContext) => MaybePromise<readonly StandingItem[]>)
    | undefined;
  readonly start:
    | ((ctx: SourceContext) => MaybePromise<SourceHandle> | SourceHandle)
    | undefined;
  readonly check:
    | ((ctx: PluginBaseContext) => MaybePromise<string | void>)
    | undefined;
  readonly settingsSchema: ActionArgsSchema | undefined;
  readonly projectSettings: ProjectSettingsDeclaration | undefined;
  readonly enforces: readonly string[];
  readonly requires: PluginRequires | undefined;
}

export interface LoadedPlugin extends Omit<NormalizedPlugin, "flows"> {
  readonly flows: readonly FlowDefinition[];
}

const KINDS: readonly PluginKind[] = [
  "domain",
  "harness",
  "stage",
  "channel",
  "source",
  "action",
];

export function noteInfo(
  args: ActionArgsSchema | undefined,
): { readonly name: string | undefined; readonly required: boolean } {
  const note = noteProperty(args);
  return { name: note?.name, required: note?.required === true };
}

/** Splits `<plugin>:<action>` or `<plugin>/<action>` without splitting an id. */
export function splitActionName(
  name: string,
): { readonly plugin: string; readonly action: string } | undefined {
  const colon = name.indexOf(":");
  const slash = name.indexOf("/");
  const at = colon > 0 ? colon : slash > 0 ? slash : -1;
  if (at <= 0 || at === name.length - 1) return undefined;
  return { plugin: name.slice(0, at), action: name.slice(at + 1) };
}

/** The step param `askGraceSecs`, when the step's params carry one. */
export function askGraceOf(params: unknown): unknown {
  return isRecord(params) ? params.askGraceSecs : undefined;
}

/** The smaller of the grace seconds that are set. */
export function narrowerOf(...values: readonly unknown[]): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (typeof value !== "number") continue;
    result = result === undefined ? value : Math.min(result, value);
  }
  return result;
}

export function parseObjectKeyMaybe(key: string): { readonly type: string; readonly id: string } {
  const colon = key.indexOf(":");
  if (colon <= 0 || colon === key.length - 1) {
    return { type: "object", id: key };
  }
  return { type: key.slice(0, colon), id: key.slice(colon + 1) };
}

function isPluginKind(value: unknown): value is PluginKind {
  return (
    value === "domain" ||
    value === "harness" ||
    value === "stage" ||
    value === "channel" ||
    value === "source" ||
    value === "action"
  );
}

function normalizeViews(
  value: unknown,
  at: string,
  objects: readonly ObjectTypeDefinition[],
): Readonly<Record<string, ObjectViews>> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new PluginError(`${at}: must be an object`);
  }
  const known = new Set(objects.map((object) => object.name));
  const views: Record<string, ObjectViews> = {};
  for (const [type, raw] of Object.entries(value)) {
    if (!known.has(type)) {
      throw new PluginError(`${at}.${type}: the plugin declares no object type "${type}"`);
    }
    if (!isRecord(raw)) {
      throw new PluginError(`${at}.${type}: must be an object`);
    }
    if (typeof raw.row !== "function") {
      throw new PluginError(`${at}.${type}: row: must be a function`);
    }
    if (typeof raw.sections !== "function") {
      throw new PluginError(`${at}.${type}: sections: must be a function`);
    }
    if (typeof raw.load !== "function") {
      throw new PluginError(`${at}.${type}: load: must be a function`);
    }
    if (raw.showScope !== undefined && typeof raw.showScope !== "function") {
      throw new PluginError(`${at}.${type}: showScope: must be a function`);
    }
    views[type] = {
      row: raw.row as ObjectViews["row"],
      sections: raw.sections as ObjectViews["sections"],
      load: raw.load as ObjectViews["load"],
      ...(raw.showScope === undefined
        ? {}
        : { showScope: raw.showScope as NonNullable<ObjectViews["showScope"]> }),
    };
  }
  return views;
}

function normalizeProjectSettings(
  value: unknown,
  at: string,
): ProjectSettingsDeclaration | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new PluginError(`${at}: must be an object`);
  if (typeof value.repositories !== "function") {
    throw new PluginError(`${at}: repositories: must be a function of ({ store })`);
  }
  if (!Array.isArray(value.files)) {
    throw new PluginError(`${at}: files: must be an array`);
  }
  const seen = new Set<string>();
  const files = value.files.map((item: unknown, index: number) => {
    const where = `${at}: files[${index}]`;
    if (!isRecord(item)) throw new PluginError(`${where}: must be an object`);
    const { name, path } = item;
    if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new PluginError(`${where}: name: must be lowercase letters, digits and -`);
    }
    if (seen.has(name)) throw new PluginError(`${where}: name "${name}" is declared twice`);
    seen.add(name);
    if (
      typeof path !== "string" ||
      !path.endsWith(".json") ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || part === "" || part === ".")
    ) {
      throw new PluginError(
        `${where}: path: must be a relative .json path under .operad/ without ".."`,
      );
    }
    let schema: ActionArgsSchema | undefined;
    try {
      schema = normalizeActionArgs(item.schema, `${where}: schema`);
    } catch (error) {
      throw new PluginError(messageOf(error), { cause: error });
    }
    if (schema === undefined) throw new PluginError(`${where}: schema: is required`);
    return { name, path, schema };
  });
  return {
    repositories: value.repositories as ProjectSettingsDeclaration["repositories"],
    files,
  };
}

function normalizeKeys(value: unknown, at: string): KeyBindings {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new PluginError(`${at}: must be an object`);
  }
  const keys: Record<string, string> = {};
  for (const [key, target] of Object.entries(value)) {
    if (key.trim().length === 0) {
      throw new PluginError(`${at}: a key must be a non-empty string`);
    }
    if (typeof target !== "string" || target.trim().length === 0) {
      throw new PluginError(`${at}.${key}: must name an action as "<plugin>:<action>"`);
    }
    keys[key] = target;
  }
  return keys;
}

/** The default rules a plugin ships, checked by the same validator as the file. */
function normalizeRules(
  value: unknown,
  at: string,
): readonly TriggerRule[] {
  if (value === undefined) return [];
  try {
    return parseTriggerRules(value, `${at}: rules`);
  } catch (error) {
    if (error instanceof TriggerError) {
      throw new PluginError(error.message, { cause: error });
    }
    throw error;
  }
}

function requireNameText(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginError(`${at}: must be a non-empty string`);
  }
  return value;
}

function optionalArray(value: unknown, at: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new PluginError(`${at}: must be an array`);
  }
  return value as readonly unknown[];
}

function normalizeFilters(
  value: unknown,
  at: string,
): readonly ObjectFilterDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new PluginError(`${at}: must be an array of filters`);
  }
  const names = new Set<string>();
  const filters: ObjectFilterDefinition[] = [];
  let defaultName: string | undefined;
  value.forEach((raw: unknown, index: number) => {
    const here = `${at}[${index}]`;
    if (!isRecord(raw)) throw new PluginError(`${here}: must be an object`);
    const name = requireNameText(raw.name, `${here}: name`);
    if (name === ALL_FILTER) {
      throw new PluginError(`${here}: name: "${ALL_FILTER}" is added by the kernel`);
    }
    if (names.has(name)) {
      throw new PluginError(`${here}: name: duplicate filter "${name}"`);
    }
    names.add(name);
    if (!Array.isArray(raw.states) || raw.states.length === 0) {
      throw new PluginError(`${here}: states: must be a non-empty array of state names`);
    }
    const states: string[] = [];
    raw.states.forEach((state: unknown, stateIndex: number) => {
      if (typeof state !== "string" || state.trim().length === 0) {
        throw new PluginError(`${here}: states[${stateIndex}]: must be a non-empty string`);
      }
      if (!states.includes(state)) states.push(state);
    });
    if (raw.default !== undefined && typeof raw.default !== "boolean") {
      throw new PluginError(`${here}: default: must be a boolean`);
    }
    if (raw.default === true) {
      if (defaultName !== undefined) {
        throw new PluginError(
          `${here}: default: "${defaultName}" is already the default filter`,
        );
      }
      defaultName = name;
    }
    filters.push({ name, states, ...(raw.default === true ? { default: true } : {}) });
  });
  return filters;
}

function normalizeObjects(
  value: unknown,
  at: string,
): readonly ObjectTypeDefinition[] {
  const names = new Set<string>();
  const objects: ObjectTypeDefinition[] = [];
  optionalArray(value, at).forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new PluginError(`${at}[${index}]: must be an object`);
    }
    const name = requireNameText(entry.name, `${at}[${index}]: name`);
    if (names.has(name)) {
      throw new PluginError(`${at}: duplicate object type "${name}"`);
    }
    names.add(name);
    if (entry.prepare !== undefined && typeof entry.prepare !== "function") {
      throw new PluginError(`${at}[${index}]: prepare: must be a function`);
    }
    if (entry.resolve !== undefined && typeof entry.resolve !== "function") {
      throw new PluginError(`${at}[${index}]: resolve: must be a function`);
    }

    let fields: string[] | undefined;
    if (entry.index !== undefined) {
      if (!Array.isArray(entry.index)) {
        throw new PluginError(`${at}[${index}]: index: must be an array of field names`);
      }
      fields = [];
      entry.index.forEach((field: unknown, fieldIndex: number) => {
        if (typeof field !== "string" || field.trim().length === 0) {
          throw new PluginError(
            `${at}[${index}]: index[${fieldIndex}]: must be a non-empty string`,
          );
        }
        if (fields?.includes(field) === true) {
          throw new PluginError(
            `${at}[${index}]: index: duplicate field "${field}"`,
          );
        }
        fields?.push(field);
      });
    }

    if (
      entry.answeredAutomatically !== undefined &&
      typeof entry.answeredAutomatically !== "function"
    ) {
      throw new PluginError(
        `${at}[${index}]: answeredAutomatically: must be a function`,
      );
    }

    const filters = normalizeFilters(entry.filters, `${at}[${index}]: filters`);

    objects.push({
      name,
      ...(entry.answeredAutomatically === undefined
        ? {}
        : {
            answeredAutomatically: entry.answeredAutomatically as NonNullable<
              ObjectTypeDefinition["answeredAutomatically"]
            >,
          }),
      ...(filters === undefined ? {} : { filters }),
      ...(entry.schema === undefined ? {} : { schema: entry.schema }),
      ...(entry.resolve === undefined
        ? {}
        : {
            resolve: entry.resolve as NonNullable<
              ObjectTypeDefinition["resolve"]
            >,
          }),
      ...(entry.prepare === undefined
        ? {}
        : { prepare: entry.prepare as NonNullable<ObjectTypeDefinition["prepare"]> }),
      ...(fields === undefined ? {} : { index: fields }),
    });
  });
  return objects;
}

function normalizeEnforces(value: unknown, at: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new PluginError(`${at}: enforces: must be an array of profile field names`);
  }
  const fields: string[] = [];
  value.forEach((field, index) => {
    if (typeof field !== "string" || field.trim().length === 0) {
      throw new PluginError(
        `${at}: enforces[${index}]: must be a non-empty string`,
      );
    }
    if (fields.includes(field)) {
      throw new PluginError(`${at}: enforces: duplicate field "${field}"`);
    }
    fields.push(field);
  });
  return fields;
}

function normalizeRequires(value: unknown, at: string): PluginRequires | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new PluginError(`${at}: requires: must be an object`);
  }
  let plugins: Record<string, string> | undefined;
  if (value.plugins !== undefined) {
    if (!isRecord(value.plugins)) {
      throw new PluginError(`${at}: requires.plugins: must be an object`);
    }
    plugins = {};
    for (const [name, range] of Object.entries(value.plugins)) {
      if (name.trim().length === 0) {
        throw new PluginError(`${at}: requires.plugins: a plugin name must be non-empty`);
      }
      if (typeof range !== "string" || !isRangeSyntax(range)) {
        throw new PluginError(
          `${at}: requires.plugins.${name}: must be a supported version range (^, ~, >= or exact)`,
        );
      }
      plugins[name] = range;
    }
  }
  let api: string | undefined;
  if (value.api !== undefined) {
    if (typeof value.api !== "string" || !isRangeSyntax(value.api)) {
      throw new PluginError(
        `${at}: requires.api: must be a supported version range (^, ~, >= or exact)`,
      );
    }
    api = value.api;
  }
  return { ...(plugins === undefined ? {} : { plugins }), ...(api === undefined ? {} : { api }) };
}

/** A step's `calls`: a list of distinct `plugin/step` names. */
function normalizeCalls(value: unknown, at: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new PluginError(`${at}: calls: must be an array`);
  }
  const seen = new Set<string>();
  for (const [index, call] of (value as readonly unknown[]).entries()) {
    if (typeof call !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(call)) {
      throw new PluginError(
        `${at}: calls[${index}]: must be a step name like "plugin/step"`,
      );
    }
    if (seen.has(call)) {
      throw new PluginError(`${at}: calls[${index}]: duplicate "${call}"`);
    }
    seen.add(call);
  }
  return [...seen];
}

function normalizeSteps(
  value: unknown,
  at: string,
): readonly StepTypeDefinition[] {
  const names = new Set<string>();
  const steps: StepTypeDefinition[] = [];
  optionalArray(value, at).forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new PluginError(`${at}[${index}]: must be an object`);
    }
    const name = requireNameText(entry.name, `${at}[${index}]: name`);
    if (names.has(name)) {
      throw new PluginError(`${at}: duplicate step "${name}"`);
    }
    names.add(name);

    const rawResults = entry.results;
    if (!Array.isArray(rawResults)) {
      throw new PluginError(`${at}[${index}]: results: must be an array`);
    }
    const results = rawResults as readonly unknown[];
    const seen = new Set<string>();
    const normalizedResults: string[] = [];
    results.forEach((result, resultIndex) => {
      if (typeof result !== "string" || result.trim().length === 0) {
        throw new PluginError(
          `${at}[${index}]: results[${resultIndex}]: must be a non-empty string`,
        );
      }
      if (seen.has(result)) {
        throw new PluginError(
          `${at}: step "${name}": duplicate result "${result}"`,
        );
      }
      seen.add(result);
      normalizedResults.push(result);
    });

    if (typeof entry.run !== "function") {
      throw new PluginError(`${at}[${index}]: run: must be a function`);
    }
    steps.push({
      name,
      results: normalizedResults,
      ...(entry.calls === undefined
        ? {}
        : { calls: normalizeCalls(entry.calls, `${at}[${index}]`) }),
      ...(entry.grants === undefined
        ? {}
        : { grants: normalizeFlag(entry.grants, "grants", `${at}[${index}]`) }),
      ...(entry.callsNamedByData === undefined
        ? {}
        : {
            callsNamedByData: normalizeFlag(
              entry.callsNamedByData,
              "callsNamedByData",
              `${at}[${index}]`,
            ),
          }),
      ...(entry.resumable === undefined
        ? {}
        : { resumable: normalizeResumable(entry.resumable, `${at}[${index}]`) }),
      ...(entry.enforces === undefined
        ? {}
        : { enforces: normalizeEnforces(entry.enforces, `${at}[${index}]`) }),
      ...(entry.timeoutSecs === undefined
        ? {}
        : { timeoutSecs: normalizeTimeoutSecs(entry.timeoutSecs, `${at}[${index}]`) }),
      ...(entry.limit === undefined
        ? {}
        : { limit: normalizeLimit(entry.limit, `${at}[${index}]`, name) }),
      run: entry.run as StepTypeDefinition["run"],
    });
  });
  return steps;
}

function normalizeActions(
  value: unknown,
  at: string,
): readonly ActionTypeDefinition[] {
  const names = new Set<string>();
  const actions: ActionTypeDefinition[] = [];
  optionalArray(value, at).forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new PluginError(`${at}[${index}]: must be an object`);
    }
    const name = requireNameText(entry.name, `${at}[${index}]: name`);
    const on = requireNameText(entry.on, `${at}[${index}]: on`);
    const key = `${name}\u0000${on}`;
    if (names.has(key)) {
      throw new PluginError(
        `${at}: duplicate action "${name}" on object type "${on}"`,
      );
    }
    names.add(key);

    if (typeof entry.when !== "function") {
      throw new PluginError(`${at}[${index}]: when: must be a function`);
    }
    if (typeof entry.run !== "function") {
      throw new PluginError(`${at}[${index}]: run: must be a function`);
    }
    if (entry.note !== undefined) {
      throw new PluginError(
        `${at}[${index}]: note: is no longer a field; declare a string property with role "note" in args`,
      );
    }

    let args: ActionArgsSchema | undefined;
    try {
      args = normalizeActionArgs(entry.args, `${at}[${index}]: args`);
    } catch (error) {
      throw new PluginError(messageOf(error), {
        cause: error,
      });
    }

    const confirm = entry.confirm;
    if (confirm !== undefined && typeof confirm !== "boolean") {
      throw new PluginError(`${at}[${index}]: confirm: must be a boolean`);
    }
    if (
      entry.creates !== undefined &&
      (typeof entry.creates !== "string" || entry.creates.length === 0)
    ) {
      throw new PluginError(`${at}[${index}]: creates: must be a non-empty string`);
    }
    actions.push({
      name,
      on,
      ...(typeof entry.creates === "string" ? { creates: entry.creates } : {}),
      ...(args === undefined ? {} : { args }),
      ...(confirm === undefined ? {} : { confirm }),
      ...(entry.ends === true ? { ends: true } : {}),
      when: entry.when as ActionTypeDefinition["when"],
      ...(typeof entry.rank === "function"
        ? { rank: entry.rank as NonNullable<ActionTypeDefinition["rank"]> }
        : {}),
      ...(typeof entry.argsFor === "function"
        ? { argsFor: entry.argsFor as NonNullable<ActionTypeDefinition["argsFor"]> }
        : {}),
      ...(typeof entry.settled === "function"
        ? { settled: entry.settled as NonNullable<ActionTypeDefinition["settled"]> }
        : {}),
      ...(typeof entry.why === "function"
        ? { why: entry.why as NonNullable<ActionTypeDefinition["why"]> }
        : {}),
      run: entry.run as ActionTypeDefinition["run"],
    });
  });
  return actions;
}

function normalizeCommands(
  value: unknown,
  at: string,
): readonly CommandDefinition[] {
  const names = new Set<string>();
  const commands: CommandDefinition[] = [];
  optionalArray(value, at).forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new PluginError(`${at}[${index}]: must be an object`);
    }
    const name = requireNameText(entry.name, `${at}[${index}]: name`);
    if (names.has(name)) {
      throw new PluginError(`${at}: duplicate command "${name}"`);
    }
    names.add(name);

    if (typeof entry.args !== "string") {
      throw new PluginError(`${at}[${index}]: args: must be a string`);
    }
    if (typeof entry.run !== "function") {
      throw new PluginError(`${at}[${index}]: run: must be a function`);
    }
    commands.push({
      name,
      args: entry.args,
      run: entry.run as CommandDefinition["run"],
    });
  });
  return commands;
}

export function normalizePlugin(raw: unknown, index: number): NormalizedPlugin {
  if (!isRecord(raw)) {
    throw new PluginError(`plugin[${index}]: must be an object`);
  }
  const name = requireNameText(raw.name, `plugin[${index}]: name`);
  const at = `plugin "${name}"`;

  if (raw.operadPlugin !== OPERAD_PLUGIN_VERSION) {
    throw new PluginError(
      `${at}: operadPlugin: expected ${OPERAD_PLUGIN_VERSION}, got ${JSON.stringify(raw.operadPlugin)}`,
    );
  }

  const kind = raw.kind;
  if (!isPluginKind(kind)) {
    throw new PluginError(
      `${at}: kind: must be one of ${KINDS.map((item) => `"${item}"`).join(", ")}`,
    );
  }

  const version = requireNameText(raw.version, `${at}: version`);

  let onTick: ((ctx: TickContext) => MaybePromise<void>) | undefined;
  if (raw.onTick !== undefined) {
    if (typeof raw.onTick !== "function") {
      throw new PluginError(`${at}: onTick: must be a function`);
    }
    onTick = raw.onTick as (ctx: TickContext) => MaybePromise<void>;
  }

  let standing: NormalizedPlugin["standing"];
  if (raw.standing !== undefined) {
    if (typeof raw.standing !== "function") {
      throw new PluginError(`${at}: standing: must be a function`);
    }
    standing = raw.standing as NormalizedPlugin["standing"];
  }

  let check:
    | ((ctx: PluginBaseContext) => MaybePromise<string | void>)
    | undefined;
  if (raw.check !== undefined) {
    if (typeof raw.check !== "function") {
      throw new PluginError(`${at}: check: must be a function`);
    }
    check = raw.check as (
      ctx: PluginBaseContext,
    ) => MaybePromise<string | void>;
  }

  let start: NormalizedPlugin["start"];
  if (raw.start !== undefined) {
    if (typeof raw.start !== "function") {
      throw new PluginError(`${at}: start: must be a function`);
    }
    start = raw.start as NormalizedPlugin["start"];
  }

  const objects = normalizeObjects(raw.objects, `${at}: objects`);

  let settingsSchema: ActionArgsSchema | undefined;
  try {
    settingsSchema = normalizeActionArgs(raw.settings, `${at}: settings`);
  } catch (error) {
    throw new PluginError(messageOf(error), { cause: error });
  }

  const projectSettings = normalizeProjectSettings(
    raw.projectSettings,
    `${at}: projectSettings`,
  );

  return {
    name,
    kind,
    version,
    objects,
    actions: normalizeActions(raw.actions, `${at}: actions`),
    steps: checkHarnessResults(
      normalizeSteps(raw.steps, `${at}: steps`),
      kind,
      at,
    ),
    flows: optionalArray(raw.flows, `${at}: flows`),
    commands: normalizeCommands(raw.commands, `${at}: commands`),
    views: normalizeViews(raw.views, `${at}: views`, objects),
    keys: normalizeKeys(raw.keys, `${at}: keys`),
    rules: normalizeRules(raw.rules, at),
    onTick,
    standing,
    start,
    check,
    settingsSchema,
    projectSettings,
    enforces: normalizeEnforces(raw.enforces, `${at}: enforces`) ?? [],
    requires: normalizeRequires(raw.requires, at),
  };
}

/** A harness step type ends only in the standard end results. */
function checkHarnessResults(
  steps: readonly StepTypeDefinition[],
  kind: string,
  at: string,
): readonly StepTypeDefinition[] {
  if (kind !== "harness") return steps;
  for (const step of steps) {
    for (const result of step.results) {
      if (!isEndResult(result)) {
        throw new PluginError(
          `${at}: step "${step.name}": result "${result}" is not an end result; a harness step ends in ${END_RESULTS.join(", ")}`,
        );
      }
    }
  }
  return steps;
}

function normalizeLimit(
  value: unknown,
  at: string,
  step: string,
): StepLimitDefinition {
  const where = at.replace(/: steps\[\d+\]$/, "");
  const fail = (message: string): never => {
    throw new PluginError(`${where}: step "${step}": limit: ${message}`);
  };
  if (!isRecord(value)) return fail("must be { key, concurrent }");
  for (const field of Object.keys(value)) {
    if (field !== "key" && field !== "concurrent") {
      return fail(`unknown field "${field}"; expected key and concurrent`);
    }
  }
  if (typeof value.key !== "function") {
    return fail("key: must be a function of (params, settings)");
  }
  if (typeof value.concurrent !== "function") {
    return fail("concurrent: must be a function of (params, settings)");
  }
  return {
    key: value.key as StepLimitDefinition["key"],
    concurrent: value.concurrent as StepLimitDefinition["concurrent"],
  };
}

function normalizeTimeoutSecs(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PluginError(`${at}: timeoutSecs: must be a positive number of seconds`);
  }
  return value;
}

/**
 * What is wrong with the one-time permission a question asks for, if anything.
 * It is found before the person is asked: a permission that could never be
 * used, or that any answer would give, must not be offered.
 */
export function grantRequestProblem(
  request: AskRequest,
  grants: boolean | undefined,
): string | undefined {
  const resume: unknown = request.resume;
  if (!isRecord(resume) || resume.grant === undefined) return undefined;
  const grant: unknown = resume.grant;
  if (grants === false) {
    return "resume.grant: this step cannot enforce a one-time permission, so it cannot ask for one";
  }
  if (
    !isRecord(grant) ||
    (grant.kind !== "command" && grant.kind !== "path") ||
    typeof grant.value !== "string" ||
    grant.value.length === 0
  ) {
    return 'resume.grant: must be { kind: "command" | "path", value, choice?, tool? }';
  }
  if (grant.kind === "path" && (typeof grant.tool !== "string" || grant.tool.length === 0)) {
    return "resume.grant.tool: a path grant names the tool the person approves (such as write)";
  }
  const choices = request.choices ?? [];
  if (choices.length > 0) {
    if (typeof grant.choice !== "string") {
      return "resume.grant.choice: a grant needs the choice that approves it";
    }
    if (!choices.includes(grant.choice)) {
      return "resume.grant.choice: must be one of the choices";
    }
  } else if (grant.choice !== undefined && typeof grant.choice !== "string") {
    return "resume.grant.choice: must be a string";
  }
  return undefined;
}

function normalizeFlag(value: unknown, field: string, at: string): boolean {
  if (typeof value !== "boolean") {
    throw new PluginError(`${at}: ${field}: must be true or false`);
  }
  return value;
}

function normalizeResumable(value: unknown, at: string): boolean {
  return normalizeFlag(value, "resumable", at);
}

export function collectStepTypes(plugins: readonly NormalizedPlugin[]): readonly StepType[] {
  return plugins.flatMap((plugin) =>
    plugin.steps.map((step) => ({
      name: `${plugin.name}/${step.name}`,
      results: step.results,
      ...(step.resumable === undefined ? {} : { resumable: step.resumable }),
      ...(step.enforces === undefined ? {} : { enforces: step.enforces }),
      ...(step.timeoutSecs === undefined ? {} : { timeoutSecs: step.timeoutSecs }),
    })),
  );
}

export function validatePluginSet(plugins: readonly NormalizedPlugin[]): void {
  const names = new Set<string>();
  const objects = new Set<string>();

  for (const plugin of plugins) {
    if (names.has(plugin.name)) {
      throw new PluginError(`plugin "${plugin.name}": duplicate plugin name`);
    }
    names.add(plugin.name);

    for (const object of plugin.objects) {
      if (objects.has(object.name)) {
        throw new PluginError(
          `plugin "${plugin.name}": object "${object.name}": another plugin already owns it`,
        );
      }
      objects.add(object.name);
    }
  }

  for (const plugin of plugins) {
    for (const action of plugin.actions) {
      if (!objects.has(action.on)) {
        throw new PluginError(
          `plugin "${plugin.name}": action "${action.name}": on: unknown object type "${action.on}"`,
        );
      }
    }
  }

  const verbs = new Map<string, string[]>();
  for (const plugin of plugins) {
    for (const command of plugin.commands) {
      const owners = verbs.get(command.name);
      if (owners === undefined) {
        verbs.set(command.name, [plugin.name]);
      } else {
        owners.push(plugin.name);
      }
    }
  }
  for (const [verb, owners] of verbs) {
    if (owners.length > 1) {
      throw new PluginError(
        `command "${verb}": declared by plugins ${owners.map((owner) => `"${owner}"`).join(", ")}`,
      );
    }
  }
}

export function validateFlows(
  plugins: readonly NormalizedPlugin[],
  stepTypes: readonly StepType[],
): readonly LoadedPlugin[] {
  return plugins.map((plugin) => {
    const flows: FlowDefinition[] = [];
    const names = new Set<string>();
    for (const raw of plugin.flows) {
      let flow: FlowDefinition;
      try {
        flow = validateFlow(raw, stepTypes);
      } catch (error) {
        if (error instanceof FlowError) {
          throw new PluginError(`plugin "${plugin.name}": ${error.message}`, {
            cause: error,
          });
        }
        throw error;
      }
      if (names.has(flow.name)) {
        throw new PluginError(
          `plugin "${plugin.name}": flows: duplicate flow "${flow.name}"`,
        );
      }
      names.add(flow.name);
      flows.push(flow);
    }
    return { ...plugin, flows };
  });
}

/** A plugin's default rule must start a flow some loaded plugin declares. */
export function validateRuleFlows(plugins: readonly LoadedPlugin[]): void {
  const flowNames = new Set(
    plugins.flatMap((plugin) => plugin.flows.map((flow) => flow.name)),
  );
  for (const plugin of plugins) {
    for (const [index, rule] of plugin.rules.entries()) {
      if (!flowNames.has(rule.start.flow)) {
        throw new PluginError(
          `plugin "${plugin.name}": rules: rule ${index}: start.flow: unknown flow "${rule.start.flow}"`,
        );
      }
    }
  }
}
