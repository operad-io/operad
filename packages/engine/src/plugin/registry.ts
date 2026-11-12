import { join } from "node:path";
import type { FlowDefinition, StepType } from "../flow/types.ts";
import { loadFlow as loadFlowFile } from "../flow/load.ts";
import { FlowError, validateFlow } from "../flow/validate.ts";
import type { JsonValue } from "../log/types.ts";
import { validateActionArgs } from "./action-schema.ts";
import { readDeclaredFlows, writeDeclaredFlow } from "./declared-flows.ts";
import { AccessError, AskTimeoutError, messageOf, PluginError, StepNotLoadedError } from "./errors.ts";
import { defaultOperadHome } from "./home.ts";
import { createPluginLogger } from "./logger.ts";
import { FileSecretStore } from "./secrets.ts";
import { satisfiesRange } from "./semver.ts";
import { enterStep, reapStep, withStepMarker, type StepMarker } from "../platform/step-reap.ts";
import { prepareSettings } from "./settings.ts";
import { MemoryPluginStore } from "./store.ts";
import {
  PLUGIN_API_VERSION,
  type ActionArgsSchema,
  type ProjectSettingsDeclaration,
  type ActionContext,
  type ActionEnv,
  type ActionEvent,
  type ActionRun,
  isActionOutcome,
  type ActionRunOptions,
  type ActionTypeDefinition,
  type ObjectData,
  type Actor,
  type Answer,
  type CommandContext,
  type CommandDefinition,
  type CommandRun,
  type CommandRunOptions,
  type FactInput,
  type FactWriter,
  type MaybePromise,
  type ObjectRef,
  type StoredObject,
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
import { askGraceOf, collectStepTypes, grantRequestProblem, narrowerOf, noteInfo, normalizePlugin, parseObjectKeyMaybe, splitActionName, validateFlows, validatePluginSet, validateRuleFlows, type LoadedPlugin } from "./validate.ts";
import { isRecord } from "../util.ts";

export { splitActionName };

/** An action's rank for an object's data; a failing `rank` counts as 0. */
export function rankOf(action: ActionTypeDefinition, data: ObjectData): number {
  if (action.rank === undefined) return 0;
  try {
    const rank = action.rank(data);
    return Number.isFinite(rank) ? rank : 0;
  } catch {
    return 0;
  }
}

/** Orders by rank, lower first; equal ranks keep their order. */
export function sortByRank<T extends { readonly rank: number }>(items: readonly T[]): T[] {
  return items
    .map((item, at) => ({ item, at }))
    .sort((a, b) => a.item.rank - b.item.rank || a.at - b.at)
    .map(({ item }) => item);
}

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
  readonly onCancelRun?:
    | ((runId: string, flow?: FlowDefinition) => MaybePromise<void>)
    | undefined;
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
  /**
   * Called when an action sends an event with `ctx.emit`: the kernel routes it
   * through the rules. Without it an action has no `emit`.
   */
  readonly onEvent?: ((event: TriggerEvent) => MaybePromise<void>) | undefined;
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
  /** The action ends the object, so a main key or button never runs it. */
  readonly ends?: boolean | undefined;
  /** The object type the action creates; a client lists it where that type is created. */
  readonly creates?: string | undefined;
}

/** Where a key binding came from. */
export interface KeyBinding {
  readonly key: string;
  readonly plugin: string;
  readonly action: string;
  readonly name: string;
  readonly source: "plugin" | "user";
}

/** One standing item with the plugin that gave it, and the actions that hold for its object. */
export interface StandingEntry {
  readonly plugin: string;
  readonly id: string;
  readonly prompt: string;
  readonly object?: ObjectRef;
  readonly actions: readonly PendingActionView[];
  readonly announce?: false;
  /** Object keys (`type:id`) the item stands for besides its own. */
  readonly covers?: readonly string[];
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
    | ((runId: string, flow?: FlowDefinition) => MaybePromise<void>)
    | undefined;
  private readonly rules: readonly TriggerRule[];
  private readonly onEvent: ((event: TriggerEvent) => MaybePromise<void>) | undefined;
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
  /** Flows a plugin generated while the process ran, by name. */
  private readonly declaredFlows = new Map<
    string,
    { readonly plugin: string; readonly flow: FlowDefinition }
  >();
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
    this.onEvent = options.onEvent;

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
          ...(action.ends === true ? { ends: true } : {}),
          ...(action.creates === undefined ? {} : { creates: action.creates }),
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
    this.loadDeclaredFlows();
  }

  /** Loads flows an earlier process declared, so a run can find its graph. */
  private loadDeclaredFlows(): void {
    if (this.store.kind !== "file") return;
    for (const stored of readDeclaredFlows(this.store.root)) {
      let flow: FlowDefinition;
      try {
        flow = validateFlow(stored.flow, this.stepTypes());
      } catch {
        // A flow whose steps this process cannot load is left for the loop to
        // report when it tries to start a run of it.
        continue;
      }
      if (this.flow(flow.name) !== undefined) continue;
      this.declaredFlows.set(flow.name, { plugin: stored.plugin, flow });
    }
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

  /** True when the plugin's objects belong under a client's settings view. */
  objectsUnderSettings(plugin: string): boolean {
    return this.byName.get(plugin)?.objectsUnderSettings === true;
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

  /** What each loaded plugin declares for settings, in load order. */
  settingsDeclarations(): readonly {
    readonly plugin: string;
    readonly schema: ActionArgsSchema | undefined;
    readonly project: ProjectSettingsDeclaration | undefined;
  }[] {
    return this.plugins.map((plugin) => ({
      plugin: plugin.name,
      schema: plugin.settingsSchema,
      project: plugin.projectSettings,
    }));
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
    const staticFlows = this.plugins.flatMap((plugin) =>
      plugin.flows.map((flow) => ({
        plugin: plugin.name,
        flow,
        source: this.sourceByPlugin.get(plugin.name),
      })),
    );
    const names = new Set(staticFlows.map((item) => item.flow.name));
    const generated = [...this.declaredFlows.values()]
      .filter((item) => !names.has(item.flow.name))
      .map((item) => ({
        plugin: item.plugin,
        flow: item.flow,
        source: this.sourceByPlugin.get(item.plugin),
      }));
    return [...staticFlows, ...generated];
  }

  /**
   * Adds a flow a plugin generated. A name already in use keeps the definition
   * it got first, so a run that started with it keeps its graph when the
   * repository's settings change.
   */
  private declareFlow(pluginName: string, raw: FlowDefinition): void {
    let flow: FlowDefinition;
    try {
      flow = validateFlow(raw, this.stepTypes());
    } catch (error) {
      if (error instanceof FlowError) {
        throw new PluginError(`plugin "${pluginName}": ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
    const existing = this.flow(flow.name);
    if (existing !== undefined) {
      if (
        existing.plugin === pluginName &&
        JSON.stringify(existing.flow) === JSON.stringify(flow)
      ) {
        return;
      }
      throw new PluginError(
        `plugin "${pluginName}": flow "${flow.name}": already declared`,
      );
    }
    if (this.store.kind === "file") {
      try {
        writeDeclaredFlow(this.store.root, pluginName, flow);
      } catch (error) {
        throw new PluginError(
          `plugin "${pluginName}": flow "${flow.name}": could not be saved: ${messageOf(error)}`,
          { cause: error },
        );
      }
    }
    this.declaredFlows.set(flow.name, { plugin: pluginName, flow });
  }

  /** The flow with this name, whichever plugin declares it. */
  flow(name: string):
    | { readonly plugin: string; readonly flow: FlowDefinition }
    | undefined {
    const declared = this.declaredFlows.get(name);
    if (declared !== undefined) return declared;
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

  /**
   * Whether the object's plugin answers its wait automatically. A hook that
   * throws is logged and counts as no.
   */
  async answeredAutomatically(object: ObjectRef): Promise<boolean> {
    const hook = this.objectType(object.type)?.answeredAutomatically;
    if (hook === undefined) return false;
    try {
      const stored = await this.store.get(object.type, object.id);
      if (stored === undefined) return false;
      return (await hook(stored.data, this.actionEnv())) === true;
    } catch (error) {
      this.log(
        `answeredAutomatically failed for ${object.type} "${object.id}": ${messageOf(error)}`,
      );
      return false;
    }
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
      throw new StepNotLoadedError(use);
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
      throw new StepNotLoadedError(use);
    }
    if (options.runId.trim().length === 0) {
      throw new PluginError(`step "${use}": runId: must be a non-empty string`);
    }

    const cause = `step:${use}`;
    const limiter = options.limits;
    const emit = async (event: StepEvent): Promise<void> => {
      if (!event.type.startsWith(`${found.plugin.name}.`)) {
        throw new PluginError(
          `step "${use}": emit: type "${event.type}" must begin with "${found.plugin.name}."`,
        );
      }
      // The step that started this one may watch its events; it does not
      // replace the destination.
      await options.observe?.(found.plugin.name, event);
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
      queued:
        limiter === undefined
          ? undefined
          : (key, ahead) =>
            limiter.report({ key, ...(ahead === undefined ? {} : { ahead }) }),
      stepLoaded: (name) => this.stepIndex.has(name),
      runStep: (nestedUse, nestedParams, nestedOptions) => {
        // Declarations must not drift: tests fail on a call the step did not
        // declare; production still runs it.
        if (
          process.env.NODE_ENV === "test" &&
          !(found.step.calls ?? []).includes(nestedUse) &&
          found.step.callsNamedByData !== true &&
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
    const marker: StepMarker = { runId: options.runId, step: use, home: this.home };
    const leave = enterStep(marker);
    try {
      outcome = await withStepMarker(marker, () => found.step.run(ctx, params));
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
    } finally {
      // However the step ended, what it left running goes with it.
      if (leave()) await reapStep(marker, ctx.logger);
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

  /** The names of the harness plugins loaded now. */
  loadedHarnesses(): readonly string[] {
    return this.plugins.filter((item) => item.kind === "harness").map((item) => item.name);
  }

  /** What an action's checks may read. */
  actionEnv(): ActionEnv {
    return { store: this.store, harnesses: this.loadedHarnesses() };
  }

  /** Runs an action on an object, by `plugin/action` or a unique plain name. */
  async runAction(
    name: string,
    args: unknown,
    options: ActionRunOptions,
  ): Promise<ActionRun> {
    const found = this.findAction(name, options.object.type);
    const label = `action "${found.plugin.name}:${found.action.name}"`;
    const personArgs = validateActionArgs(
      found.action.argsFor?.(options.object, this.actionEnv()) ?? found.action.args,
      args,
      label,
    );
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
      harnesses: this.loadedHarnesses(),
      ...(this.onEvent === undefined
        ? {}
        : { emit: this.actionEmitter(found.plugin.name) }),
      ...(this.onCancelRun === undefined
        ? {}
        : { runs: this.runControl() }),
    };
    const value = await found.action.run(ctx, personArgs);
    if (isActionOutcome(value)) {
      return {
        plugin: found.plugin.name,
        action: found.action.name,
        value: value.text,
        opens: value.opens,
      };
    }
    return {
      plugin: found.plugin.name,
      action: found.action.name,
      value,
    };
  }

  /** The `ctx.emit` of an action: an outside event, never one from `operad`. */
  private actionEmitter(plugin: string): (event: ActionEvent) => Promise<void> {
    const onEvent = this.onEvent;
    return async (event) => {
      if (onEvent === undefined) {
        throw new PluginError(`plugin "${plugin}": emit: no event destination is configured`);
      }
      if (event.source === "operad" || event.source.trim().length === 0) {
        throw new PluginError(
          `plugin "${plugin}": emit: source must be a name other than "operad"`,
        );
      }
      await onEvent({
        source: event.source,
        type: event.type,
        key: event.key,
        hops: 0,
        ...(event.object === undefined ? {} : { object: event.object }),
        ...(event.summary === undefined ? {} : { summary: event.summary }),
        ...(event.data === undefined ? {} : { data: event.data }),
      });
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
      ...(this.onCancelRun === undefined ? {} : { runs: this.runControl() }),
    };
    const value = await command.run(ctx, resolved.argv);
    return { ...resolved, value };
  }

  /**
   * The items plugins ask a person to know about. A hook that throws is
   * logged and shows nothing, so one plugin cannot hide the others.
   */
  async standing(): Promise<readonly StandingEntry[]> {
    const items: StandingEntry[] = [];
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
          const object =
            item.object === undefined
              ? undefined
              : await this.store.get(item.object.type, item.object.id);
          // An item about an object that is gone says nothing.
          if (item.object !== undefined && object === undefined) continue;
          items.push({
            plugin: plugin.name,
            id: item.id,
            prompt: item.prompt,
            actions: object === undefined ? [] : await this.actionsHolding(object),
            ...(item.object === undefined ? {} : { object: item.object }),
            ...(item.announce === false ? { announce: false as const } : {}),
            ...(item.covers === undefined || item.covers.length === 0
              ? {}
              : { covers: item.covers.map((ref) => `${ref.type}:${ref.id}`) }),
          });
        }
      } catch (error) {
        this.log(`plugin "${plugin.name}": standing failed: ${messageOf(error)}`);
      }
    }
    return items;
  }

  /** The actions whose `when` holds for the object; a throwing `when` is logged and hidden. */
  private async actionsHolding(object: StoredObject): Promise<readonly PendingActionView[]> {
    const held: { plugin: string; action: string; rank: number }[] = [];
    for (const { plugin, action } of this.actionsFor(object.type)) {
      let holds: unknown;
      try {
        holds = await action.when(object.data, this.actionEnv());
      } catch (error) {
        this.log(
          `plugin "${plugin.name}": action "${action.name}": when failed: ${messageOf(error)}`,
        );
        continue;
      }
      if (holds === true) {
        held.push({ plugin: plugin.name, action: action.name, rank: rankOf(action, object.data) });
      }
    }
    return sortByRank(held).map(({ plugin, action }) => ({ plugin, action }));
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

      const actions = await this.actionsHolding(object);
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
        ...(this.onCancelRun === undefined ? {} : { runs: this.runControl() }),
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
          const found = this.flow(request.flow);
          if (found === undefined || found.plugin !== plugin.name) {
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
        declareFlow: (flow) => {
          this.declareFlow(plugin.name, flow);
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
      cancel: async (runId, flow) => {
        if (onCancelRun !== undefined) await onCancelRun(runId, flow);
      },
    };
  }

  private log(message: string): void {
    this.onLog(message);
  }
}
