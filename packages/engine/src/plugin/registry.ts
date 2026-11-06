import { join } from "node:path";
import type { FlowDefinition, StepType } from "../flow/types.ts";
import { loadFlow as loadFlowFile } from "../flow/load.ts";
import { FlowError, validateFlow } from "../flow/validate.ts";
import { messageOf, PluginError } from "./errors.ts";
import { defaultOperadHome } from "./home.ts";
import { createPluginLogger } from "./logger.ts";
import { MemoryPluginStore } from "./store.ts";
import {
  OPERAD_PLUGIN_VERSION,
  type ActionContext,
  type ActionNote,
  type ActionRun,
  type ActionRunOptions,
  type ActionTypeDefinition,
  type Answer,
  type CommandContext,
  type CommandDefinition,
  type CommandRun,
  type CommandRunOptions,
  type FactInput,
  type FactWriter,
  type MaybePromise,
  type ObjectTypeDefinition,
  type ObjectViews,
  type KeyBindings,
  type PendingActionView,
  type PendingEntry,
  type PluginBaseContext,
  type PluginCheck,
  type PluginKind,
  type PluginStepResult,
  type PluginStore,
  type ResolvedCommand,
  type StartRunRequest,
  type StepContext,
  type StepRunOptions,
  type StepTypeDefinition,
  type TickContext,
  type WaitingRun,
} from "./types.ts";

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
    | ((runId: string, choice: string, note?: string) => MaybePromise<void>)
    | undefined;
  /** The specifier each definition was loaded from, aligned with it. */
  readonly sources?: readonly (string | undefined)[] | undefined;
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
  readonly onTick: ((ctx: TickContext) => MaybePromise<void>) | undefined;
  readonly check:
    | ((ctx: PluginBaseContext) => MaybePromise<string | void>)
    | undefined;
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
  /** The plugin's declaration: true, false, or `{ required }`. */
  readonly note?: ActionNote | undefined;
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

function noteRequired(note: ActionNote | undefined): boolean {
  if (note === true) return true;
  return typeof note === "object" && note !== null && note.required === true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    views[type] = {
      row: raw.row as ObjectViews["row"],
      sections: raw.sections as ObjectViews["sections"],
      load: raw.load as ObjectViews["load"],
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
    objects.push(
      entry.schema === undefined ? { name } : { name, schema: entry.schema },
    );
  });
  return objects;
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
      run: entry.run as StepTypeDefinition["run"],
    });
  });
  return steps;
}

function normalizeActionNote(
  value: unknown,
  at: string,
): ActionNote | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (isRecord(value)) {
    const required = value.required;
    if (typeof required !== "boolean") {
      throw new PluginError(`${at}.required: must be a boolean`);
    }
    return { required };
  }
  throw new PluginError(`${at}: must be a boolean or { required: boolean }`);
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
    if (names.has(name)) {
      throw new PluginError(`${at}: duplicate action "${name}"`);
    }
    names.add(name);

    const on = requireName(entry.on, `${at}[${index}]: on`);
    if (typeof entry.when !== "function") {
      throw new PluginError(`${at}[${index}]: when: must be a function`);
    }
    if (typeof entry.run !== "function") {
      throw new PluginError(`${at}[${index}]: run: must be a function`);
    }
    const note = normalizeActionNote(entry.note, `${at}[${index}]: note`);
    const confirm = entry.confirm;
    if (confirm !== undefined && typeof confirm !== "boolean") {
      throw new PluginError(`${at}[${index}]: confirm: must be a boolean`);
    }
    actions.push({
      name,
      on,
      ...(note === undefined ? {} : { note }),
      ...(confirm === undefined ? {} : { confirm }),
      when: entry.when as ActionTypeDefinition["when"],
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

  const objects = normalizeObjects(raw.objects, `${at}: objects`);

  return {
    name,
    kind,
    version,
    objects,
    actions: normalizeActions(raw.actions, `${at}: actions`),
    steps: normalizeSteps(raw.steps, `${at}: steps`),
    flows: optionalArray(raw.flows, `${at}: flows`),
    commands: normalizeCommands(raw.commands, `${at}: commands`),
    views: normalizeViews(raw.views, `${at}: views`, objects),
    keys: normalizeKeys(raw.keys, `${at}: keys`),
    onTick,
    check,
  };
}

function collectStepTypes(plugins: readonly NormalizedPlugin[]): readonly StepType[] {
  return plugins.flatMap((plugin) =>
    plugin.steps.map((step) => ({
      name: `${plugin.name}/${step.name}`,
      results: step.results,
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

/**
 * Holds the loaded plugins and gives the kernel the three entry points it
 * needs: run a step, dispatch a command, and compute the pending view. The
 * registry validates every plugin before the first one can be used.
 */
export class PluginRegistry {
  readonly home: string;
  readonly store: PluginStore;

  private readonly cwd: string;
  private readonly kernelVerbs: ReadonlySet<string>;
  private readonly onLog: (message: string) => void;
  private readonly onStartRun:
    | ((request: StartRunRequest) => MaybePromise<void>)
    | undefined;
  private readonly onAnswer:
    | ((runId: string, choice: string, note?: string) => MaybePromise<void>)
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
    validatePluginSet(normalized);
    const stepTypes = collectStepTypes(normalized);
    this.plugins = validateFlows(normalized, stepTypes);

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
        actionInfos.push({
          plugin: plugin.name,
          action: action.name,
          on: action.on,
          name: `${plugin.name}:${action.name}`,
          ...(action.note === undefined ? {} : { note: action.note }),
          noteRequired: noteRequired(action.note),
          confirm: action.confirm === true,
        });
      }
    }
    this.viewByType = viewByType;
    this.actionInfos = actionInfos;
    this.bindingByKey = this.resolveKeys(options.keys ?? {});

    const sources = new Map<string, string>();
    for (const [index, plugin] of this.plugins.entries()) {
      const source = options.sources?.[index];
      if (source !== undefined) sources.set(plugin.name, source);
    }
    this.sourceByPlugin = sources;

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
  ): ActionTypeDefinition | undefined {
    return this.byName.get(plugin)?.actions.find((item) => item.name === action);
  }

  /** The plugin names in load order. */
  names(): readonly string[] {
    return this.plugins.map((plugin) => plugin.name);
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

  /** Every object type the loaded plugins declare, with its plugin. */
  objectTypes(): readonly {
    readonly plugin: string;
    readonly type: string;
  }[] {
    return this.plugins.flatMap((plugin) =>
      plugin.objects.map((object) => ({
        plugin: plugin.name,
        type: object.name,
      })),
    );
  }

  /** The directory plugin steps run in when a caller names none. */
  get workdir(): string {
    return this.cwd;
  }

  /** Loads and validates a flow file against the loaded step types. */
  async loadFlow(path: string): Promise<FlowDefinition> {
    return loadFlowFile(path, this.stepTypes());
  }

  /** Runs a step type by its full use name. */
  async runStep(
    use: string,
    params: unknown,
    options: StepRunOptions,
  ): Promise<PluginStepResult> {
    const found = this.stepIndex.get(use);
    if (found === undefined) {
      throw new PluginError(`step "${use}": no loaded plugin declares it`);
    }
    if (options.runId.trim().length === 0) {
      throw new PluginError(`step "${use}": runId: must be a non-empty string`);
    }

    const cause = `step:${use}`;
    const ctx: StepContext = {
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
      runId: options.runId,
      object: options.object,
    };

    const outcome: unknown = await found.step.run(ctx, params);
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
    const cause = `action:${found.plugin.name}/${found.action.name}`;
    const runId = options.runId;
    const onAnswer = this.onAnswer;
    const answer: Answer | undefined =
      runId === undefined || onAnswer === undefined
        ? undefined
        : (choice, note) => onAnswer(runId, choice, note);
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
      runId,
      object: options.object,
      ...(options.note === undefined ? {} : { note: options.note }),
      answer,
    };
    const value = await found.action.run(ctx, args);
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
   * Resolves a CLI verb. `<plugin> <verb>` always wins; `<verb>` works when no
   * kernel verb and exactly one plugin declare the name.
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

    if (this.kernelVerbs.has(first)) return undefined;

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
    };
    const value = await command.run(ctx, resolved.argv);
    return { ...resolved, value };
  }

  /**
   * Computes the pending view: for each waiting run, the object's state and
   * the actions whose `when` holds. A throwing `when` is logged and hidden.
   */
  async pending(runs: readonly WaitingRun[]): Promise<readonly PendingEntry[]> {
    const entries: PendingEntry[] = [];
    for (const run of runs) {
      const object = await this.store.get(run.object.type, run.object.id);
      if (object === undefined) continue;

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
  async tick(): Promise<void> {
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
        start: async (flowName, object) => {
          const flow = plugin.flows.find((item) => item.name === flowName);
          if (flow === undefined) {
            throw new PluginError(
              `plugin "${plugin.name}": flow "${flowName}": not declared`,
            );
          }
          const request: StartRunRequest =
            object === undefined
              ? { plugin: plugin.name, flow: flowName }
              : { plugin: plugin.name, flow: flowName, object };
          this.starts.push(request);
          if (this.onStartRun !== undefined) {
            await this.onStartRun(request);
          }
        },
      };
      try {
        await plugin.onTick(ctx);
      } catch (error) {
        this.log(`plugin "${plugin.name}": onTick failed: ${messageOf(error)}`);
      }
    }
  }

  /** The run starts plugins asked for on the latest ticks. */
  get startedRuns(): readonly StartRunRequest[] {
    return this.starts;
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
        const action = plugin.actions.find((item) => item.name === actionName);
        if (action !== undefined) {
          this.requireActionObject(plugin, action, objectType);
          return { plugin, action };
        }
      }
    }

    let found:
      | { readonly plugin: LoadedPlugin; readonly action: ActionTypeDefinition }
      | undefined;
    for (const plugin of this.plugins) {
      for (const action of plugin.actions) {
        if (action.name !== name) continue;
        if (found !== undefined) {
          throw new PluginError(
            `action "${name}": declared by plugins "${found.plugin.name}" and "${plugin.name}", use "<plugin>/<action>"`,
          );
        }
        found = { plugin, action };
      }
    }
    if (found === undefined) {
      throw new PluginError(`action "${name}": no loaded plugin declares it`);
    }
    this.requireActionObject(found.plugin, found.action, objectType);
    return found;
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
        this.store.append(
          input.cause === undefined ? { ...input, cause } : input,
        ),
    };
  }

  private log(message: string): void {
    this.onLog(message);
  }
}
