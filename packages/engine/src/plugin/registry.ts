import { join } from "node:path";
import { ALL_FILTER } from "./filters.ts";
import type { FlowDefinition, StepType } from "../flow/types.ts";
import { loadFlow as loadFlowFile } from "../flow/load.ts";
import { FlowError, validateFlow } from "../flow/validate.ts";
import type { JsonValue } from "../log/types.ts";
import { normalizeActionArgs, noteProperty, validateActionArgs } from "./action-schema.ts";
import { AccessError, AskTimeoutError, messageOf, PluginError, StartRefusedError } from "./errors.ts";
import { defaultOperadHome } from "./home.ts";
import { createPluginLogger } from "./logger.ts";
import { FileSecretStore } from "./secrets.ts";
import { isRangeSyntax, satisfiesRange } from "./semver.ts";
import { END_RESULTS, isEndResult } from "./usage.ts";
import { prepareSettings } from "./settings.ts";
import { MemoryPluginStore } from "./store.ts";
import {
  OPERAD_PLUGIN_VERSION,
  PLUGIN_API_VERSION,
  type ActionArgsSchema,
  type ActionContext,
  type ActionRun,
  type ActionRunOptions,
  type ActionTypeDefinition,
  type Actor,
  type Answer,
  type CommandContext,
  type CommandDefinition,
  type CommandRun,
  type CommandRunOptions,
  type FactInput,
  type FactWriter,
  type MaybePromise,
  type ObjectFilterDefinition,
  type ObjectTypeDefinition,
  type RunLookup,
  type ObjectViews,
  type KeyBindings,
  type PendingActionView,
  type PendingEntry,
  type StandingContext,
  type StandingItem,
  type PluginBaseContext,
  type PluginCheck,
  type PluginKind,
  type PluginRequires,
  type PluginStepResult,
  type PluginStore,
  type ResolvedCommand,
  type RunControl,
  type SecretStore,
  type SourceContext,
  type SourceHandle,
  type StartRunRequest,
  MAX_ASK_GRACE_SECS,
  type AskAnswer,
  type AskRequest,
  type StepContext,
  type StepRunOptions,
  type StepLimitDefinition,
  type StepTypeDefinition,
  type TickContext,
  type WaitingRun,
} from "./types.ts";
import type {
  SourceEvent,
  StepEvent,
  TriggerEvent,
  TriggerRule,
} from "../trigger/types.ts";
import { parseTriggerRules, TriggerError } from "../trigger/rules.ts";

/** Options for building a registry from plugin definitions. */
export interface PluginRegistryOptions {
  readonly home?: string | undefined;
  readonly cwd?: string | undefined;
  readonly store?: PluginStore | undefined;
  readonly storeRoot?: string | undefined;
  readonly clock?: (() => number) | undefined;
  /** The person's key overrides; a key here wins over every plugin default. */
  readonly keys?: KeyBindings | undefined;
  /** Verbs the kernel itself owns; a plugin cannot take them as a short form. */
  readonly kernelVerbs?: readonly string[] | undefined;
  /** Where load-time and runtime plugin errors go. Defaults to stderr. */
  readonly onLog?: ((message: string) => void) | undefined;
  /** Called when a plugin's `onTick` asks the kernel to start a run. */
  readonly onStartRun?:
    | ((request: StartRunRequest) => MaybePromise<void>)
    | undefined;
  /** Answers a person wait for an action; the action calls `ctx.answer`. */
  readonly onAnswer?:
    | ((
        runId: string,
        choice: string,
        note: string | undefined,
        actor: Actor,
      ) => MaybePromise<void>)
    | undefined;
  /** Cancels one run when a plugin action asks; the kernel writes the input. */
  readonly onCancelRun?: ((runId: string) => MaybePromise<void>) | undefined;
  /** The specifier each definition was loaded from, aligned with it. */
  readonly sources?: readonly (string | undefined)[] | undefined;
  /** The raw config section of each plugin, keyed by plugin name. */
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
  /** Plugins the config switched off; a dependent is refused with the reason. */
  readonly disabled?: readonly string[] | undefined;
  /** Whether to resolve `requires` against the loaded plugins. */
  readonly requireDependencies?: boolean | undefined;
  /** Whether to validate each plugin's settings section. */
  readonly validateSettings?: boolean | undefined;
  /** The routing rules, given to source plugins. */
  readonly rules?: readonly TriggerRule[] | undefined;
  /** Called when a source plugin sends an event. */
  readonly onSourceEvent?:
    | ((event: TriggerEvent, plugin: string) => MaybePromise<void>)
    | undefined;
}

/** A plugin the registry left out, and the line that says why. */
export interface PluginRefusal {
  readonly plugin: string;
  readonly message: string;
}

interface NormalizedPlugin {
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
  readonly enforces: readonly string[];
  readonly requires: PluginRequires | undefined;
}

interface LoadedPlugin extends Omit<NormalizedPlugin, "flows"> {
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

/** One action a client may offer, with what it needs from the person. */
export interface ActionInfo {
  readonly plugin: string;
  readonly action: string;
  /** The object type the action works on. */
  readonly on: string;
  /** Addressed as `<plugin>:<action>`. */
  readonly name: string;
  /** The person's input, as a JSON Schema object. */
  readonly args?: ActionArgsSchema | undefined;
  /** The name of the note property, when the schema declares one. */
  readonly note?: string | undefined;
  readonly noteRequired: boolean;
  readonly confirm: boolean;
}

/** Where a key binding came from. */
export interface KeyBinding {
  readonly key: string;
  readonly plugin: string;
  readonly action: string;
  readonly name: string;
  readonly source: "plugin" | "user";
}

function noteInfo(
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
function askGraceOf(params: unknown): unknown {
  return isRecord(params) ? params.askGraceSecs : undefined;
}

/** The smaller of the grace seconds that are set. */
function narrowerOf(...values: readonly unknown[]): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (typeof value !== "number") continue;
    result = result === undefined ? value : Math.min(result, value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObjectKeyMaybe(key: string): { readonly type: string; readonly id: string } {
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

function requireName(value: unknown, at: string): string {
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
    const name = requireName(raw.name, `${here}: name`);
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
    const name = requireName(entry.name, `${at}[${index}]: name`);
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

    const filters = normalizeFilters(entry.filters, `${at}[${index}]: filters`);

    objects.push({
      name,
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
    const name = requireName(entry.name, `${at}[${index}]: name`);
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
    const name = requireName(entry.name, `${at}[${index}]: name`);
    const on = requireName(entry.on, `${at}[${index}]: on`);
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
    actions.push({
      name,
      on,
      ...(args === undefined ? {} : { args }),
      ...(confirm === undefined ? {} : { confirm }),
      when: entry.when as ActionTypeDefinition["when"],
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
    const name = requireName(entry.name, `${at}[${index}]: name`);
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

function normalizePlugin(raw: unknown, index: number): NormalizedPlugin {
  if (!isRecord(raw)) {
    throw new PluginError(`plugin[${index}]: must be an object`);
  }
  const name = requireName(raw.name, `plugin[${index}]: name`);
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

  const version = requireName(raw.version, `${at}: version`);

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
function grantRequestProblem(
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

function collectStepTypes(plugins: readonly NormalizedPlugin[]): readonly StepType[] {
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

function validatePluginSet(plugins: readonly NormalizedPlugin[]): void {
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

function validateFlows(
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
function validateRuleFlows(plugins: readonly LoadedPlugin[]): void {
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

/**
 * Holds the loaded plugins and gives the kernel the three entry points it
 * needs: run a step, dispatch a command, and compute the pending view. The
 * registry validates every plugin before the first one can be used.
 */
export class PluginRegistry {
  readonly home: string;
  readonly store: PluginStore;

  private readonly cwd: string;
  /** Runs whose missing object was already logged, so a poll does not repeat it. */
  private readonly reportedMissing = new Set<string>();
  private readonly kernelVerbs: ReadonlySet<string>;
  private readonly onLog: (message: string) => void;
  private readonly onStartRun:
    | ((request: StartRunRequest) => MaybePromise<void>)
    | undefined;
  private readonly onAnswer:
    | ((
        runId: string,
        choice: string,
        note: string | undefined,
        actor: Actor,
      ) => MaybePromise<void>)
    | undefined;
  private readonly onCancelRun:
    | ((runId: string) => MaybePromise<void>)
    | undefined;
  private readonly rules: readonly TriggerRule[];
  private readonly onSourceEvent:
    | ((event: TriggerEvent, plugin: string) => MaybePromise<void>)
    | undefined;
  private readonly plugins: readonly LoadedPlugin[];
  private readonly byName: ReadonlyMap<string, LoadedPlugin>;
  private readonly viewByType: ReadonlyMap<string, { readonly plugin: LoadedPlugin; readonly views: ObjectViews }>;
  private readonly actionInfos: readonly ActionInfo[];
  private readonly bindingByKey: ReadonlyMap<string, KeyBinding>;
  private readonly sourceByPlugin: ReadonlyMap<string, string>;
  private readonly stepIndex: ReadonlyMap<
    string,
    { readonly plugin: LoadedPlugin; readonly step: StepTypeDefinition }
  >;
  private readonly starts: StartRunRequest[] = [];
  private readonly refusalList: PluginRefusal[] = [];
  private readonly settingsByPlugin: ReadonlyMap<
    string,
    Readonly<Record<string, JsonValue>>
  >;
  private readonly disabledNames: ReadonlySet<string>;

  constructor(
    definitions: readonly unknown[],
    options: PluginRegistryOptions = {},
  ) {
    this.home = options.home ?? defaultOperadHome();
    this.cwd = options.cwd ?? process.cwd();
    this.kernelVerbs = new Set(options.kernelVerbs ?? []);
    this.onLog = options.onLog ?? ((message) => console.error(message));
    this.onStartRun = options.onStartRun;
    this.onAnswer = options.onAnswer;
    this.onCancelRun = options.onCancelRun;
    this.rules = options.rules ?? [];
    this.onSourceEvent = options.onSourceEvent;

    const clock = options.clock ?? (() => Date.now());
    this.store =
      options.store ??
      new MemoryPluginStore({
        root: options.storeRoot ?? join(this.home, "store"),
        clock,
      });

    const normalized = definitions.map((definition, index) =>
      normalizePlugin(definition, index),
    );
    const sourceMap = new Map<string, string>();
    for (const [index, plugin] of normalized.entries()) {
      const source = options.sources?.[index];
      if (source !== undefined) sourceMap.set(plugin.name, source);
    }
    this.sourceByPlugin = sourceMap;
    this.disabledNames = new Set(options.disabled ?? []);

    const settingsByPlugin = new Map<
      string,
      Readonly<Record<string, JsonValue>>
    >();
    const refused = new Set<string>();
    const refuse = (plugin: string, message: string): void => {
      if (refused.has(plugin)) return;
      refused.add(plugin);
      const line = message.startsWith(`plugin "${plugin}":`)
        ? message
        : `plugin "${plugin}": ${message}`;
      this.refusalList.push({ plugin, message: line });
      this.log(line);
    };

    for (const plugin of normalized) {
      if (plugin.settingsSchema === undefined || options.validateSettings === false) {
        settingsByPlugin.set(plugin.name, Object.freeze({}));
        continue;
      }
      try {
        settingsByPlugin.set(
          plugin.name,
          prepareSettings(
            plugin.settingsSchema,
            options.settings?.[plugin.name],
            plugin.name,
          ),
        );
      } catch (error) {
        refuse(plugin.name, messageOf(error));
      }
    }

    if (options.requireDependencies !== false) {
      const versions = new Map(normalized.map((plugin) => [plugin.name, plugin.version]));
      for (const plugin of normalized) {
        if (refused.has(plugin.name)) continue;
        const api = plugin.requires?.api;
        if (api === undefined) continue;
        let ok: boolean;
        try {
          ok = satisfiesRange(PLUGIN_API_VERSION, api);
        } catch (error) {
          refuse(plugin.name, `requires api "${api}": ${messageOf(error)}`);
          continue;
        }
        if (!ok) {
          refuse(
            plugin.name,
            `requires api "${api}", but this engine provides ${PLUGIN_API_VERSION}`,
          );
        }
      }

      let changed = true;
      while (changed) {
        changed = false;
        for (const plugin of normalized) {
          if (refused.has(plugin.name)) continue;
          for (const [dependency, range] of Object.entries(
            plugin.requires?.plugins ?? {},
          )) {
            let reason: string | undefined;
            if (refused.has(dependency)) {
              reason = `requires plugin "${dependency}" "${range}", but "${dependency}" was refused`;
            } else if (this.disabledNames.has(dependency)) {
              reason = `requires plugin "${dependency}" "${range}", but "${dependency}" is disabled`;
            } else {
              const version = versions.get(dependency);
              if (version === undefined) {
                reason = `requires plugin "${dependency}" "${range}", but "${dependency}" is not loaded`;
              } else {
                let ok: boolean;
                try {
                  ok = satisfiesRange(version, range);
                } catch {
                  ok = false;
                }
                if (!ok) {
                  reason = `requires plugin "${dependency}" "${range}", but "${dependency}" is ${version}`;
                }
              }
            }
            if (reason !== undefined) {
              refuse(plugin.name, reason);
              changed = true;
              break;
            }
          }
        }
      }
    }

    this.settingsByPlugin = settingsByPlugin;
    const kept = normalized.filter((plugin) => !refused.has(plugin.name));
    validatePluginSet(kept);
    for (const plugin of kept) {
      for (const command of plugin.commands) {
        if (this.kernelVerbs.has(command.name)) {
          throw new PluginError(
            `plugin "${plugin.name}": command "${command.name}" clashes with the kernel verb "${command.name}"`,
          );
        }
      }
    }
    if (typeof this.store.declare === "function") {
      for (const plugin of kept) {
        for (const object of plugin.objects) {
          this.store.declare(object.name, object.index ?? []);
        }
      }
    }
    const stepTypes = collectStepTypes(kept);
    this.plugins = validateFlows(kept, stepTypes);
    validateRuleFlows(this.plugins);

    this.byName = new Map(this.plugins.map((plugin) => [plugin.name, plugin]));

    const viewByType = new Map<
      string,
      { readonly plugin: LoadedPlugin; readonly views: ObjectViews }
    >();
    const actionInfos: ActionInfo[] = [];
    for (const plugin of this.plugins) {
      for (const [type, views] of Object.entries(plugin.views)) {
        viewByType.set(type, { plugin, views });
      }
      for (const action of plugin.actions) {
        const note = noteInfo(action.args);
        actionInfos.push({
          plugin: plugin.name,
          action: action.name,
          on: action.on,
          name: `${plugin.name}:${action.name}`,
          ...(action.args === undefined ? {} : { args: action.args }),
          ...(note.name === undefined ? {} : { note: note.name }),
          noteRequired: note.required,
          confirm: action.confirm === true,
        });
      }
    }
    this.viewByType = viewByType;
    this.actionInfos = actionInfos;
    this.bindingByKey = this.resolveKeys(options.keys ?? {});

    const stepIndex = new Map<
      string,
      { readonly plugin: LoadedPlugin; readonly step: StepTypeDefinition }
    >();
    for (const plugin of this.plugins) {
      for (const step of plugin.steps) {
        stepIndex.set(`${plugin.name}/${step.name}`, { plugin, step });
      }
    }
    this.stepIndex = stepIndex;
  }

  /** Every action the loaded plugins declare, addressed as `plugin:action`. */
  actions(): readonly ActionInfo[] {
    return this.actionInfos;
  }

  /** The default and user key bindings in force, by key. */
  keyBindings(): readonly KeyBinding[] {
    return [...this.bindingByKey.values()];
  }

  /** The views a plugin gives an object type, or undefined. */
  viewsFor(
    type: string,
  ): { readonly plugin: string; readonly views: ObjectViews } | undefined {
    const found = this.viewByType.get(type);
    return found === undefined
      ? undefined
      : { plugin: found.plugin.name, views: found.views };
  }

  /** The definition of one action, or undefined when it is not loaded. */
  actionDefinition(
    plugin: string,
    action: string,
    objectType?: string | undefined,
  ): ActionTypeDefinition | undefined {
    return this.byName
      .get(plugin)
      ?.actions.find(
        (item) =>
          item.name === action &&
          (objectType === undefined || item.on === objectType),
      );
  }

  /** The plugin names in load order. */
  names(): readonly string[] {
    return this.plugins.map((plugin) => plugin.name);
  }

  /** The trigger rules plugins ship, in load order, with their plugin. */
  triggerRules(): readonly {
    readonly plugin: string;
    readonly rule: TriggerRule;
  }[] {
    return this.plugins.flatMap((plugin) =>
      plugin.rules.map((rule) => ({ plugin: plugin.name, rule })),
    );
  }

  /** The plugins left out at load, with the line that says why. */
  refusals(): readonly PluginRefusal[] {
    return this.refusalList;
  }

  /** The validated settings of one loaded plugin. */
  settingsFor(plugin: string): Readonly<Record<string, JsonValue>> {
    return this.settingsByPlugin.get(plugin) ?? Object.freeze({});
  }

  /** Every loaded plugin's settings, as a worker reloads them. */
  pluginSettings(): Readonly<Record<string, Readonly<Record<string, JsonValue>>>> {
    const settings: Record<string, Readonly<Record<string, JsonValue>>> = {};
    for (const [name, value] of this.settingsByPlugin) settings[name] = value;
    return settings;
  }

  /**
   * Refuses a profile that sets a field no step of the flow enforces. The
   * kernel never interprets a field; it only makes sure one step applies it.
   */
  checkAccess(flowName: string, access: JsonValue | undefined): void {
    if (access === undefined) return;
    if (!isRecord(access)) {
      throw new PluginError(`access: must be an object`);
    }
    const fields = Object.keys(access).filter((field) => access[field] !== undefined);
    if (fields.length === 0) return;
    const found = this.flow(flowName);
    if (found === undefined) {
      throw new PluginError(`flow "${flowName}": not loaded`);
    }

    const enforced = new Set<string>();
    const steps: string[] = [];
    for (const step of found.flow.steps) {
      if (step.kind !== "plugin") continue;
      const use = (step.params as { readonly use?: unknown }).use;
      if (typeof use !== "string") continue;
      steps.push(`${step.id} (${use})`);
      const type = this.stepIndex.get(use);
      for (const field of type?.step.enforces ?? []) enforced.add(field);
      for (const field of type?.plugin.enforces ?? []) enforced.add(field);
    }

    for (const field of fields) {
      if (enforced.has(field)) continue;
      const named = steps.length === 0 ? "none" : steps.join(", ");
      throw new AccessError(
        field,
        `access.${field}: no step of flow "${flowName}" enforces it (steps: ${named})`,
      );
    }
  }

  /**
   * Why a run of this flow cannot start, or undefined when it can: a step the
   * flow uses, or a step one of those calls, is not loaded.
   */
  startProblem(flowName: string): string | undefined {
    const found = this.flow(flowName);
    if (found === undefined) return undefined;
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const step of found.flow.steps) {
      if (step.kind !== "plugin") continue;
      const use = (step.params as { readonly use?: unknown }).use;
      if (typeof use === "string") queue.push(use);
    }
    while (queue.length > 0) {
      const use = queue.shift() as string;
      if (seen.has(use)) continue;
      seen.add(use);
      const loaded = this.stepIndex.get(use);
      if (loaded === undefined) return this.missingStep(use);
      queue.push(...(loaded.step.calls ?? []));
    }
    return undefined;
  }

  private missingStep(use: string): string {
    const plugin = use.split("/")[0] ?? use;
    const needs = `cannot start: needs "${use}" from plugin ${plugin}`;
    if (this.disabledNames.has(plugin)) {
      return `${needs}, which is disabled (operad plugin enable ${plugin})`;
    }
    const refusal = this.refusalList.find((item) => item.plugin === plugin);
    if (refusal !== undefined) {
      const reason = refusal.message.replace(`plugin "${plugin}": `, "");
      return `${needs}, which was refused: ${reason}`;
    }
    if (this.byName.has(plugin)) {
      return `${needs}, which has no step "${use.slice(plugin.length + 1)}"`;
    }
    return `${needs}, which is not loaded`;
  }

  /** The step type registry the flow loader and validator receive. */
  stepTypes(): readonly StepType[] {
    return collectStepTypes(this.plugins);
  }

  /** Every flow a loaded plugin declares, with its plugin name and source. */
  flows(): readonly {
    readonly plugin: string;
    readonly flow: FlowDefinition;
    readonly source: string | undefined;
  }[] {
    return this.plugins.flatMap((plugin) =>
      plugin.flows.map((flow) => ({
        plugin: plugin.name,
        flow,
        source: this.sourceByPlugin.get(plugin.name),
      })),
    );
  }

  /** The flow with this name, whichever plugin declares it. */
  flow(name: string):
    | { readonly plugin: string; readonly flow: FlowDefinition }
    | undefined {
    for (const plugin of this.plugins) {
      const flow = plugin.flows.find((item) => item.name === name);
      if (flow !== undefined) return { plugin: plugin.name, flow };
    }
    return undefined;
  }

  /** The result names a step type declares, or undefined when it is unknown. */
  stepResults(use: string): readonly string[] | undefined {
    return this.stepIndex.get(use)?.step.results;
  }

  /** The specifier each loaded plugin came from, aligned with `names()`. */
  pluginSources(): readonly (string | undefined)[] {
    return this.plugins.map((plugin) => this.sourceByPlugin.get(plugin.name));
  }

  /** Every object type the loaded plugins declare, with its plugin and definition. */
  objectTypes(): readonly {
    readonly plugin: string;
    readonly type: string;
    readonly definition: ObjectTypeDefinition;
  }[] {
    return this.plugins.flatMap((plugin) =>
      plugin.objects.map((object) => ({
        plugin: plugin.name,
        type: object.name,
        definition: object,
      })),
    );
  }

  /** The object type definitions of one type, or undefined. */
  objectType(type: string): ObjectTypeDefinition | undefined {
    for (const plugin of this.plugins) {
      const found = plugin.objects.find((object) => object.name === type);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The fields `where` may filter on for one type. */
  indexFor(type: string): readonly string[] | undefined {
    return this.objectType(type)?.index;
  }

  /** The directory plugin steps run in when a caller names none. */
  get workdir(): string {
    return this.cwd;
  }

  /** Loads and validates a flow file against the loaded step types. */
  async loadFlow(path: string): Promise<FlowDefinition> {
    return loadFlowFile(path, this.stepTypes());
  }

  /**
   * The limit one call of a step type falls under, or undefined when the type
   * declares none or its key function returns none for these params. A key or
   * count that is not usable is an error naming the step type.
   */
  stepLimit(
    use: string,
    params: unknown,
  ): { readonly key: string; readonly concurrent: number } | undefined {
    const found = this.stepIndex.get(use);
    if (found === undefined) {
      throw new PluginError(`step "${use}": no loaded plugin declares it`);
    }
    const limit = found.step.limit;
    if (limit === undefined) return undefined;
    const settings = this.settingsFor(found.plugin.name);
    let key: unknown;
    let concurrent: unknown;
    try {
      key = limit.key(params, settings);
      if (key === undefined) return undefined;
      concurrent = limit.concurrent(params, settings);
    } catch (error) {
      throw new PluginError(`step "${use}": limit: ${messageOf(error)}`);
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new PluginError(
        `step "${use}": limit: key must return a non-empty string or undefined`,
      );
    }
    if (
      typeof concurrent !== "number" ||
      !Number.isInteger(concurrent) ||
      concurrent < 1
    ) {
      throw new PluginError(
        `step "${use}": limit: concurrent must return a positive integer`,
      );
    }
    return { key, concurrent };
  }

  /** Runs a step type by its full use name. */
  async runStep(
    use: string,
    params: unknown,
    options: StepRunOptions,
  ): Promise<PluginStepResult> {
    return this.runStepInner(use, params, options, false);
  }

  /**
   * `nested` is a call a step made through `ctx.runStep`: it takes a place
   * under its limit key from the run's limiter first. The runner takes the
   * place of the step it starts itself, before the step is marked started.
   */
  private async runStepInner(
    use: string,
    params: unknown,
    options: StepRunOptions,
    nested: boolean,
  ): Promise<PluginStepResult> {
    if (nested && options.limits !== undefined) {
      const limit = this.stepLimit(use, params);
      if (limit !== undefined) {
        const release = await options.limits.acquire({
          use,
          key: limit.key,
          concurrent: limit.concurrent,
          signal: options.signal,
        });
        try {
          return await this.runStepInner(use, params, options, false);
        } finally {
          await release();
        }
      }
    }
    const found = this.stepIndex.get(use);
    if (found === undefined) {
      throw new PluginError(`step "${use}": no loaded plugin declares it`);
    }
    if (options.runId.trim().length === 0) {
      throw new PluginError(`step "${use}": runId: must be a non-empty string`);
    }

    const cause = `step:${use}`;
    const emit = async (event: StepEvent): Promise<void> => {
      if (!event.type.startsWith(`${found.plugin.name}.`)) {
        throw new PluginError(
          `step "${use}": emit: type "${event.type}" must begin with "${found.plugin.name}."`,
        );
      }
      if (options.emit === undefined) {
        throw new PluginError(
          `step "${use}": emit: no event destination is configured`,
        );
      }
      await options.emit(found.plugin.name, event);
    };
    const ask = async (request: AskRequest): Promise<AskAnswer> => {
      if (options.asker === undefined) {
        throw new PluginError(
          `step "${use}": ask: no one is configured to take questions`,
        );
      }
      if (
        !isRecord(request) ||
        typeof request.prompt !== "string" ||
        request.prompt.trim().length === 0
      ) {
        throw new PluginError(
          `step "${use}": ask: prompt: must be a non-empty string`,
        );
      }
      if (
        request.choices !== undefined &&
        (!Array.isArray(request.choices) ||
          request.choices.some((choice) => typeof choice !== "string"))
      ) {
        throw new PluginError(
          `step "${use}": ask: choices: must be a list of strings`,
        );
      }
      if (
        request.onTimeout !== undefined &&
        request.onTimeout !== "waiting" &&
        request.onTimeout !== "reject_once"
      ) {
        throw new PluginError(
          `step "${use}": ask: onTimeout: must be "waiting" or "reject_once"`,
        );
      }
      for (const [name, value] of [
        ["graceSecs", request.graceSecs],
        ["askGraceSecs", askGraceOf(params)],
      ] as const) {
        if (
          value !== undefined &&
          (typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > MAX_ASK_GRACE_SECS)
        ) {
          throw new PluginError(
            `step "${use}": ask: ${name}: must be a number of seconds from 0 to ${MAX_ASK_GRACE_SECS}`,
          );
        }
      }
      // A step that cannot resume has nothing to come back to: its question
      // gets one answer or a refusal, whatever the call said.
      const onTimeout =
        found.step.resumable === false ? "reject_once" : request.onTimeout;
      if (
        onTimeout !== "reject_once" &&
        !found.step.results.includes("waiting")
      ) {
        throw new PluginError(
          `step "${use}": ask: onTimeout "waiting" ends the step with the result "waiting", so the step must declare it in results (or ask with onTimeout "reject_once")`,
        );
      }
      const grantProblem = grantRequestProblem(request, found.step.grants);
      if (grantProblem !== undefined) {
        throw new PluginError(`step "${use}": ask: ${grantProblem}`);
      }
      const graceSecs = narrowerOf(request.graceSecs, askGraceOf(params));
      const outcome = await options.asker.ask(
        { ...request, ...(graceSecs === undefined ? {} : { graceSecs }) },
        options.signal,
      );
      if (outcome.kind === "answered") return outcome.answer;
      if (onTimeout === "reject_once") {
        return { choice: undefined, rejected: true };
      }
      throw new AskTimeoutError({
        waitId: outcome.waitId,
        prompt: outcome.prompt,
        choices: outcome.choices,
        resume: request.resume ?? null,
      });
    };
    const useGrant = async (waitId: string): Promise<boolean> => {
      if (options.asker === undefined) return false;
      return options.asker.useGrant(waitId);
    };
    const ctx: StepContext = {
      useGrant,
      plugin: found.plugin.name,
      home: this.home,
      cwd: options.cwd ?? this.cwd,
      store: this.store,
      facts: this.factsFor(cause),
      logger: createPluginLogger(
        this.store.root,
        found.plugin.name,
        "runs",
        options.runId,
        found.step.name,
      ),
      signal: options.signal ?? new AbortController().signal,
      settings: this.settingsFor(found.plugin.name),
      secrets: this.secretsFor(found.plugin.name),
      runId: options.runId,
      object: options.object,
      params: options.params ?? null,
      access: options.access ?? null,
      trigger: options.trigger,
      emit,
      ask,
      runStep: (nestedUse, nestedParams, nestedOptions) => {
        // Declarations must not drift: tests fail on a call the step did not
        // declare; production still runs it.
        if (
          process.env.NODE_ENV === "test" &&
          !(found.step.calls ?? []).includes(nestedUse) &&
          // A harness step is named by settings (a worker, a reviewer), so a
          // caller cannot list it.
          this.stepIndex.get(nestedUse)?.plugin.kind !== "harness"
        ) {
          return Promise.reject(
            new PluginError(
              `step "${use}": calls "${nestedUse}" without declaring it in calls`,
            ),
          );
        }
        return this.runStepInner(nestedUse, nestedParams, {
          ...nestedOptions,
          limits: nestedOptions.limits ?? options.limits,
          asker: nestedOptions.asker ?? options.asker,
          // A nested step reports its events to the same destination.
          emit: nestedOptions.emit ?? options.emit,
        }, true);
      },
    };

    let outcome: unknown;
    try {
      outcome = await found.step.run(ctx, params);
    } catch (error) {
      if (!(error instanceof AskTimeoutError)) throw error;
      // The grace passed: the step ends, and the flow's wait carries on.
      outcome = {
        result: "waiting",
        data: {
          waitId: error.waitId,
          prompt: error.prompt,
          choices: [...error.choices],
          resume: error.resume ?? null,
        },
      };
    }
    if (!isRecord(outcome) || typeof outcome.result !== "string") {
      throw new PluginError(
        `step "${use}": run: must return { result, data? }`,
      );
    }
    if (!found.step.results.includes(outcome.result)) {
      throw new PluginError(
        `step "${use}": result "${outcome.result}" is not one of ${found.step.results.map((result) => `"${result}"`).join(", ")}`,
      );
    }
    const data = outcome.data;
    if (data === undefined) {
      return { result: outcome.result };
    }
    if (!isRecord(data)) {
      throw new PluginError(`step "${use}": data: must be an object`);
    }
    return { result: outcome.result, data };
  }

  /** Runs an action on an object, by `plugin/action` or a unique plain name. */
  async runAction(
    name: string,
    args: unknown,
    options: ActionRunOptions,
  ): Promise<ActionRun> {
    const found = this.findAction(name, options.object.type);
    const label = `action "${found.plugin.name}:${found.action.name}"`;
    const personArgs = validateActionArgs(found.action.args, args, label);
    const cause = `action:${found.plugin.name}/${found.action.name}`;
    const runId = options.runId;
    const onAnswer = this.onAnswer;
    const actor = options.actor;
    const answer: Answer | undefined =
      runId === undefined || onAnswer === undefined
        ? undefined
        : (choice, note) => onAnswer(runId, choice, note, actor);

    // The action's own fact records who asked. It is not the object's type, so
    // it never changes the object's data.
    await this.store.append({
      type: "action_invoked",
      object: { type: options.object.type, id: options.object.id },
      cause,
      data: {
        action: `${found.plugin.name}/${found.action.name}`,
        actor: { via: actor.via, id: actor.id },
      },
    });

    const ctx: ActionContext = {
      plugin: found.plugin.name,
      home: this.home,
      cwd: options.cwd ?? this.cwd,
      store: this.store,
      facts: this.factsFor(cause),
      logger: createPluginLogger(
        this.store.root,
        found.plugin.name,
        "actions",
        found.action.name,
      ),
      signal: options.signal ?? new AbortController().signal,
      settings: this.settingsFor(found.plugin.name),
      secrets: this.secretsFor(found.plugin.name),
      runId,
      object: options.object,
      actor,
      answer,
      ...(this.onCancelRun === undefined
        ? {}
        : { runs: this.runControl() }),
    };
    const value = await found.action.run(ctx, personArgs);
    return {
      plugin: found.plugin.name,
      action: found.action.name,
      value,
    };
  }

  /** Runs each plugin's optional `check`; a throw is a failed check, not an error. */
  async checks(): Promise<readonly PluginCheck[]> {
    const checks: PluginCheck[] = [];
    for (const plugin of this.plugins) {
      if (plugin.check === undefined) continue;
      const ctx: PluginBaseContext = {
        plugin: plugin.name,
        home: this.home,
        cwd: this.cwd,
        store: this.store,
        facts: this.factsFor(`check:${plugin.name}`),
        logger: createPluginLogger(this.store.root, plugin.name, "check"),
        signal: new AbortController().signal,
        settings: this.settingsFor(plugin.name),
        secrets: this.secretsFor(plugin.name),
      };
      try {
        const note = await plugin.check(ctx);
        checks.push({
          plugin: plugin.name,
          ok: true,
          message: typeof note === "string" ? note : "ok",
        });
      } catch (error) {
        checks.push({
          plugin: plugin.name,
          ok: false,
          message: messageOf(error),
        });
      }
    }
    return checks;
  }

  /**
   * Resolves a CLI verb. `<plugin> <verb>` always wins; `<verb>` works when
   * exactly one plugin declares the name (a plugin command that shares a name
   * with a kernel verb is refused when the registry is built).
   */
  resolveCommand(argv: readonly string[]): ResolvedCommand | undefined {
    const first = argv[0];
    if (first === undefined) return undefined;

    const second = argv[1];
    const named = this.byName.get(first);
    if (named !== undefined && second !== undefined) {
      const command = named.commands.find((item) => item.name === second);
      if (command !== undefined) {
        return {
          plugin: named.name,
          command: command.name,
          argv: argv.slice(2),
        };
      }
    }

    let owner:
      | { readonly plugin: LoadedPlugin; readonly command: CommandDefinition }
      | undefined;
    for (const plugin of this.plugins) {
      for (const command of plugin.commands) {
        if (command.name !== first) continue;
        if (owner !== undefined) {
          throw new PluginError(
            `command "${first}": declared by plugins "${owner.plugin.name}" and "${plugin.name}"`,
          );
        }
        owner = { plugin, command };
      }
    }
    if (owner === undefined) return undefined;
    return {
      plugin: owner.plugin.name,
      command: owner.command.name,
      argv: argv.slice(1),
    };
  }

  /** Resolves and runs a CLI verb. Returns undefined when none matches. */
  async runCommand(
    argv: readonly string[],
    options: CommandRunOptions = {},
  ): Promise<CommandRun | undefined> {
    const resolved = this.resolveCommand(argv);
    if (resolved === undefined) return undefined;

    const plugin = this.byName.get(resolved.plugin);
    if (plugin === undefined) {
      throw new PluginError(`plugin "${resolved.plugin}": not loaded`);
    }
    const command = plugin.commands.find(
      (item) => item.name === resolved.command,
    );
    if (command === undefined) {
      throw new PluginError(
        `plugin "${plugin.name}": command "${resolved.command}": not declared`,
      );
    }

    const ctx: CommandContext = {
      plugin: plugin.name,
      home: this.home,
      cwd: options.cwd ?? this.cwd,
      store: this.store,
      facts: this.factsFor(`command:${plugin.name}/${command.name}`),
      logger: createPluginLogger(
        this.store.root,
        plugin.name,
        "commands",
        command.name,
      ),
      signal: options.signal ?? new AbortController().signal,
      settings: this.settingsFor(plugin.name),
      secrets: this.secretsFor(plugin.name),
      ...(options.input === undefined ? {} : { input: options.input }),
    };
    const value = await command.run(ctx, resolved.argv);
    return { ...resolved, value };
  }

  /**
   * The items plugins ask a person to know about. A hook that throws is
   * logged and shows nothing, so one plugin cannot hide the others.
   */
  async standing(): Promise<
    readonly { readonly plugin: string; readonly id: string; readonly prompt: string }[]
  > {
    const items: { plugin: string; id: string; prompt: string }[] = [];
    for (const plugin of this.plugins) {
      if (plugin.standing === undefined) continue;
      try {
        const found = await plugin.standing({
          plugin: plugin.name,
          home: this.home,
          cwd: this.cwd,
          store: this.store,
          facts: this.factsFor(`standing:${plugin.name}`),
          logger: createPluginLogger(this.store.root, plugin.name, "standing"),
          signal: new AbortController().signal,
          settings: this.settingsFor(plugin.name),
          secrets: this.secretsFor(plugin.name),
          loaded: this.plugins.map((item) => item.name),
        });
        for (const item of found) {
          items.push({ plugin: plugin.name, id: item.id, prompt: item.prompt });
        }
      } catch (error) {
        this.log(`plugin "${plugin.name}": standing failed: ${messageOf(error)}`);
      }
    }
    return items;
  }

  /**
   * Computes the pending view: for each waiting run, the object's state and
   * the actions whose `when` holds. A throwing `when` is logged and hidden.
   */
  async pending(runs: readonly WaitingRun[]): Promise<readonly PendingEntry[]> {
    const entries: PendingEntry[] = [];
    for (const run of runs) {
      const object = await this.store.get(run.object.type, run.object.id);
      if (object === undefined) {
        // The run still waits; show it without actions instead of hiding it.
        if (!this.reportedMissing.has(run.runId)) {
          this.reportedMissing.add(run.runId);
          this.log(
            `pending: run "${run.runId}" waits on ${run.object.type} "${run.object.id}", which is not in the store`,
          );
        }
        entries.push({
          runId: run.runId,
          prompt: run.prompt,
          choices: run.choices,
          object: {
            type: run.object.type,
            id: run.object.id,
            data: {},
            version: 0,
            cause: "missing",
            at: run.lastFactAt ?? 0,
          },
          actions: [],
        });
        continue;
      }

      const actions: PendingActionView[] = [];
      for (const { plugin, action } of this.actionsFor(object.type)) {
        let holds: unknown;
        try {
          holds = await action.when(object.data);
        } catch (error) {
          this.log(
            `plugin "${plugin.name}": action "${action.name}": when failed: ${messageOf(error)}`,
          );
          continue;
        }
        if (holds === true) {
          actions.push({ plugin: plugin.name, action: action.name });
        }
      }
      entries.push({
        runId: run.runId,
        prompt: run.prompt,
        choices: run.choices,
        object,
        actions,
      });
    }
    return entries;
  }

  /** Runs each plugin's `onTick` once; a failure is logged, not raised. */
  async tick(runs?: RunLookup): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onTick === undefined) continue;
      const ctx: TickContext = {
        plugin: plugin.name,
        home: this.home,
        cwd: this.cwd,
        store: this.store,
        facts: this.factsFor(`tick:${plugin.name}`),
        logger: createPluginLogger(this.store.root, plugin.name, "tick"),
        signal: new AbortController().signal,
        settings: this.settingsFor(plugin.name),
        secrets: this.secretsFor(plugin.name),
        ...(runs === undefined ? {} : { runLookup: runs }),
        loaded: this.plugins.map((item) => item.name),
        start: async (flowOrRequest, objectArg, accessArg) => {
          const request: StartRunRequest =
            typeof flowOrRequest === "string"
              ? {
                  plugin: plugin.name,
                  flow: flowOrRequest,
                  ...(objectArg === undefined ? {} : { object: objectArg }),
                  ...(accessArg === undefined ? {} : { access: accessArg }),
                }
              : {
                  plugin: plugin.name,
                  flow: flowOrRequest.flow,
                  ...(flowOrRequest.params === undefined
                    ? {}
                    : { params: flowOrRequest.params }),
                  ...(flowOrRequest.object === undefined
                    ? {}
                    : {
                        object:
                          typeof flowOrRequest.object === "string"
                            ? parseObjectKeyMaybe(flowOrRequest.object)
                            : flowOrRequest.object,
                      }),
                  ...(flowOrRequest.trigger === undefined
                    ? {}
                    : { trigger: flowOrRequest.trigger }),
                  ...(flowOrRequest.access === undefined
                    ? {}
                    : { access: flowOrRequest.access }),
                };
          const flow = plugin.flows.find((item) => item.name === request.flow);
          if (flow === undefined) {
            throw new PluginError(
              `plugin "${plugin.name}": flow "${request.flow}": not declared`,
            );
          }
          this.checkAccess(request.flow, request.access);
          this.starts.push(request);
          if (this.onStartRun !== undefined) {
            await this.onStartRun(request);
          }
        },
        answer: async (runId, choice, note) => {
          if (this.onAnswer === undefined) {
            throw new PluginError(
              `plugin "${plugin.name}": answer: no answer handler is installed`,
            );
          }
          await this.onAnswer(runId, choice, note, {
            via: "plugin",
            id: plugin.name,
          });
        },
      };
      try {
        await plugin.onTick(ctx);
      } catch (error) {
        this.log(`plugin "${plugin.name}": onTick failed: ${messageOf(error)}`);
      }
    }
  }

  /**
   * The run starts plugins asked for that nobody took yet. Reading does not
   * drain; a loop that ticks each pass calls `takeStartedRuns()` instead.
   */
  get startedRuns(): readonly StartRunRequest[] {
    return [...this.starts];
  }

  /** The loaded source plugins, with the function that starts each one. */
  sourcePlugins(): readonly {
    readonly plugin: string;
    readonly start: (ctx: SourceContext) => MaybePromise<SourceHandle> | SourceHandle;
  }[] {
    return this.plugins.flatMap((plugin) =>
      plugin.kind !== "source" || plugin.start === undefined
        ? []
        : [{ plugin: plugin.name, start: plugin.start }],
    );
  }

  /**
   * Starts each source plugin. A source that throws is logged and skipped, so
   * one broken source cannot stop the others or the loop.
   */
  async startSources(options: {
    readonly rules: readonly TriggerRule[];
    readonly clock: () => number;
    readonly emit: (event: TriggerEvent) => MaybePromise<void>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<readonly { readonly plugin: string; readonly handle: SourceHandle }[]> {
    const running: { plugin: string; handle: SourceHandle }[] = [];
    for (const plugin of this.plugins) {
      if (plugin.kind !== "source" || plugin.start === undefined) continue;
      const emit = async (event: SourceEvent): Promise<void> => {
        const trigger: TriggerEvent = {
          source: event.source ?? plugin.name,
          key: event.key,
          type: event.type,
          ...(event.object === undefined ? {} : { object: event.object }),
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.data === undefined ? {} : { data: event.data }),
          ...(event.link === undefined ? {} : { link: event.link }),
          hops: 0,
        };
        try {
          await options.emit(trigger);
        } catch (error) {
          this.log(
            `plugin "${plugin.name}": emit failed: ${messageOf(error)}`,
          );
        }
      };
      const ctx: SourceContext = {
        plugin: plugin.name,
        home: this.home,
        cwd: this.cwd,
        store: this.store,
        facts: this.factsFor(`source:${plugin.name}`),
        logger: createPluginLogger(this.store.root, plugin.name, "source"),
        signal: options.signal ?? new AbortController().signal,
        rules: options.rules,
        clock: options.clock,
        settings: this.settingsFor(plugin.name),
        secrets: this.secretsFor(plugin.name),
        emit,
      };
      try {
        const handle = await plugin.start(ctx);
        running.push({ plugin: plugin.name, handle });
      } catch (error) {
        this.log(`plugin "${plugin.name}": start failed: ${messageOf(error)}`);
      }
    }
    return running;
  }

  /** Removes and returns the start requests collected so far. */
  takeStartedRuns(): StartRunRequest[] {
    return this.starts.splice(0);
  }

  private actionsFor(
    type: string,
  ): readonly {
    readonly plugin: LoadedPlugin;
    readonly action: ActionTypeDefinition;
  }[] {
    const found: {
      readonly plugin: LoadedPlugin;
      readonly action: ActionTypeDefinition;
    }[] = [];
    for (const plugin of this.plugins) {
      for (const action of plugin.actions) {
        if (action.on === type) found.push({ plugin, action });
      }
    }
    return found;
  }

  private findAction(
    name: string,
    objectType: string,
  ): { readonly plugin: LoadedPlugin; readonly action: ActionTypeDefinition } {
    const named = splitActionName(name);
    if (named !== undefined) {
      const pluginName = named.plugin;
      const actionName = named.action;
      const plugin = this.byName.get(pluginName);
      if (plugin !== undefined) {
        const action = plugin.actions.find(
          (item) => item.name === actionName && item.on === objectType,
        );
        if (action !== undefined) return { plugin, action };
        const other = plugin.actions.find((item) => item.name === actionName);
        if (other !== undefined) {
          this.requireActionObject(plugin, other, objectType);
        }
      }
    }

    let found:
      | {
          readonly plugin: LoadedPlugin;
          readonly actions: readonly ActionTypeDefinition[];
        }
      | undefined;
    for (const plugin of this.plugins) {
      const matches = plugin.actions.filter((action) => action.name === name);
      if (matches.length === 0) continue;
      if (found !== undefined) {
        throw new PluginError(
          `action "${name}": declared by plugins "${found.plugin.name}" and "${plugin.name}", use "<plugin>/<action>"`,
        );
      }
      found = { plugin, actions: matches };
    }
    if (found === undefined) {
      throw new PluginError(`action "${name}": no loaded plugin declares it`);
    }
    const action =
      found.actions.find((item) => item.on === objectType) ?? found.actions[0];
    if (action === undefined) {
      throw new PluginError(`action "${name}": no loaded plugin declares it`);
    }
    this.requireActionObject(found.plugin, action, objectType);
    return { plugin: found.plugin, action };
  }

  private requireActionObject(
    plugin: LoadedPlugin,
    action: ActionTypeDefinition,
    objectType: string,
  ): void {
    if (action.on !== objectType) {
      throw new PluginError(
        `plugin "${plugin.name}": action "${action.name}": on: expected object type "${action.on}", got "${objectType}"`,
      );
    }
  }

  private resolveKeys(
    userKeys: KeyBindings,
  ): ReadonlyMap<string, KeyBinding> {
    const known = new Map(
      this.actionInfos.map((info) => [info.name, info] as const),
    );
    const bindings = new Map<string, KeyBinding>();

    for (const plugin of this.plugins) {
      for (const [key, target] of Object.entries(plugin.keys)) {
        const info = known.get(target);
        if (info === undefined) {
          throw new PluginError(
            `plugin "${plugin.name}": keys.${key}: "${target}" is not a loaded action`,
          );
        }
        const existing = bindings.get(key);
        if (existing !== undefined) {
          this.log(
            `key "${key}": plugin "${plugin.name}" would bind "${target}", but "${existing.name}" already uses it; keeping "${existing.name}"`,
          );
          continue;
        }
        bindings.set(key, {
          key,
          plugin: info.plugin,
          action: info.action,
          name: info.name,
          source: "plugin",
        });
      }
    }

    for (const [key, target] of Object.entries(userKeys)) {
      const info = known.get(target);
      if (info === undefined) {
        this.log(
          `key "${key}": "${target}" is not a loaded action; the key is ignored`,
        );
        continue;
      }
      bindings.set(key, {
        key,
        plugin: info.plugin,
        action: info.action,
        name: info.name,
        source: "user",
      });
    }

    return bindings;
  }

  private factsFor(cause: string): FactWriter {
    return {
      append: (input: FactInput) =>
        this.store.append({ ...input, cause: input.cause ?? cause }),
    };
  }

  private secretsFor(plugin: string): SecretStore {
    return new FileSecretStore({ home: this.home, plugin });
  }

  private runControl(): RunControl {
    const onCancelRun = this.onCancelRun;
    return {
      cancel: async (runId) => {
        if (onCancelRun !== undefined) await onCancelRun(runId);
      },
    };
  }

  private log(message: string): void {
    this.onLog(message);
  }
}
