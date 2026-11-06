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
  type PendingActionView,
  type PendingEntry,
  type PluginBaseContext,
  type PluginCheck,
  type PluginKind,
  type PluginStepResult,
  type PluginStore,
  type ResolvedCommand,
  type SourceContext,
  type SourceHandle,
  type StartRunRequest,
  type StepContext,
  type StepRunOptions,
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

/** Options for building a registry from plugin definitions. */
export interface PluginRegistryOptions {
  readonly home?: string | undefined;
  readonly cwd?: string | undefined;
  readonly store?: PluginStore | undefined;
  readonly storeRoot?: string | undefined;
  readonly clock?: (() => number) | undefined;
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
  /** The routing rules, given to source plugins. */
  readonly rules?: readonly TriggerRule[] | undefined;
  /** Called when a source plugin sends an event. */
  readonly onSourceEvent?:
    | ((event: TriggerEvent, plugin: string) => MaybePromise<void>)
    | undefined;
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
  readonly onTick: ((ctx: TickContext) => MaybePromise<void>) | undefined;
  readonly start:
    | ((ctx: SourceContext) => MaybePromise<SourceHandle> | SourceHandle)
    | undefined;
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
    actions.push({
      name,
      on,
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

  let start: NormalizedPlugin["start"];
  if (raw.start !== undefined) {
    if (typeof raw.start !== "function") {
      throw new PluginError(`${at}: start: must be a function`);
    }
    start = raw.start as NormalizedPlugin["start"];
  }

  return {
    name,
    kind,
    version,
    objects: normalizeObjects(raw.objects, `${at}: objects`),
    actions: normalizeActions(raw.actions, `${at}: actions`),
    steps: normalizeSteps(raw.steps, `${at}: steps`),
    flows: optionalArray(raw.flows, `${at}: flows`),
    commands: normalizeCommands(raw.commands, `${at}: commands`),
    onTick,
    start,
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
  private readonly rules: readonly TriggerRule[];
  private readonly onSourceEvent:
    | ((event: TriggerEvent, plugin: string) => MaybePromise<void>)
    | undefined;
  private readonly plugins: readonly LoadedPlugin[];
  private readonly byName: ReadonlyMap<string, LoadedPlugin>;
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
    validatePluginSet(normalized);
    const stepTypes = collectStepTypes(normalized);
    this.plugins = validateFlows(normalized, stepTypes);

    this.byName = new Map(this.plugins.map((plugin) => [plugin.name, plugin]));

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
      await options.emit(event);
    };
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
      params: options.params ?? null,
      trigger: options.trigger,
      emit,
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
        start: async (flowOrRequest, objectArg) => {
          const request: StartRunRequest =
            typeof flowOrRequest === "string"
              ? {
                  plugin: plugin.name,
                  flow: flowOrRequest,
                  ...(objectArg === undefined ? {} : { object: objectArg }),
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
                };
          const flow = plugin.flows.find((item) => item.name === request.flow);
          if (flow === undefined) {
            throw new PluginError(
              `plugin "${plugin.name}": flow "${request.flow}": not declared`,
            );
          }
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
    const slash = name.indexOf("/");
    if (slash > 0) {
      const pluginName = name.slice(0, slash);
      const actionName = name.slice(slash + 1);
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
