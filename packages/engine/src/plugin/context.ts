/**
 * Opening a home: the configuration, store, log, plugins, views and kernel one
 * process needs, wired the same way for the command line and the MCP server.
 */

import { openConfigLog, readConfig, storeRootOf, type OperadConfig } from "../config/config.ts";
import type { FlowDefinition } from "../flow/types.ts";
import type { LogBackend } from "../log/types.ts";
import { cancelRun } from "../runner/cancel.ts";
import { recordAnswer } from "../runner/answer.ts";
import { StateError } from "../runner/errors.ts";
import { Kernel } from "../trigger/kernel.ts";
import type { TriggerEvent, TriggerRule } from "../trigger/types.ts";
import { createViews, type ClientApi, type Views } from "../views/presentation.ts";
import { loadPluginRegistry } from "./load.ts";
import { openPluginStore } from "./open-store.ts";
import type { PluginRegistry } from "./registry.ts";
import type { Actor, MaybePromise, PluginStore } from "./types.ts";

/**
 * The verbs the kernel owns. A plugin cannot take one of them as a short
 * command, and the MCP command tool never reaches one through a plugin.
 */
export const KERNEL_VERBS = [
  "init",
  "doctor",
  "serve",
  "pending",
  "history",
  "running",
  "flows",
  "trigger",
  "list",
  "show",
  "plugin",
  "secret",
  "settings",
  "http",
  "pair",
  "tui",
  "run-internal",
  "check-load",
  "mcp",
] as const;

/** One verb the kernel owns. */
export type KernelVerb = (typeof KERNEL_VERBS)[number];

/** What opening one home reads and how it wires the hooks. */
export interface OpenHomeOptions {
  readonly home: string;
  /** Defaults to this process's directory. */
  readonly cwd?: string | undefined;
  /** A configuration already read by the caller, such as for a code snapshot. */
  readonly config?: OperadConfig | undefined;
  readonly clock?: (() => number) | undefined;
  readonly follow?: boolean | undefined;
  /** A namespace named explicitly, handed to each type's `resolve`. */
  readonly scope?: string | undefined;
  /** Where view ids resolve; defaults to `cwd`. */
  readonly viewsCwd?: string | undefined;
  readonly installOnEnable?: readonly string[] | undefined;
  /** Shipped plugins that may be off and unnamed in the file; their guides are readable. */
  readonly optional?: Readonly<Record<string, string>> | undefined;
  /** What loads in place of a package not installed yet (`LoadPluginRegistryOptions.standIns`). */
  readonly standIns?: Readonly<Record<string, string>> | undefined;
  readonly rules?: readonly TriggerRule[] | undefined;
  /** Reads the rules after the plugins load, when `rules` is absent. */
  readonly loadRules?:
    | ((registry: PluginRegistry) => MaybePromise<readonly TriggerRule[]>)
    | undefined;
  /** Defaults to the exported list; a caller may narrow it in a test. */
  readonly kernelVerbs?: readonly string[] | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
  /** Replaces the kernel's own answer; the default checks the run exists. */
  readonly onAnswer?:
    | ((
        runId: string,
        choice: string,
        note: string | undefined,
        actor: Actor,
      ) => MaybePromise<void>)
    | undefined;
  /** Runs after the default answer recorded one. */
  readonly afterAnswer?: ((runId: string) => MaybePromise<void>) | undefined;
  /** Replaces routing an emitted event through the opened kernel. */
  readonly onEvent?: ((event: TriggerEvent) => MaybePromise<void>) | undefined;
  readonly onCancelRun?:
    | ((runId: string, flow?: FlowDefinition) => MaybePromise<boolean | void>)
    | undefined;
  readonly onRunActive?: ((runId: string) => MaybePromise<boolean | void>) | undefined;
  /** Who asks when a plugin action cancels a run; defaults to `operad`. */
  readonly cancelSource?: string | undefined;
  /** The client API a source plugin sees; defaults to the opened views. */
  readonly client?: ClientApi | undefined;
}

/** A home opened and wired: everything a command or the MCP server uses. */
export interface OpenedHome {
  readonly home: string;
  readonly cwd: string;
  readonly config: OperadConfig;
  readonly store: PluginStore;
  readonly storeRoot: string;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly views: Views;
  readonly kernel: Kernel;
  readonly disabled: readonly string[];
  /** What did not load; later lines are runtime failures, not load ones. */
  readonly problems: string[];
  /** Sends emitted events through a kernel the caller already built. */
  useKernelForEvents(kernel: Kernel): void;
}

/** Drops the plugin store's database handle; a memory store has none. */
function closePluginStore(store: unknown): void {
  if (typeof store !== "object" || store === null || !("close" in store)) return;
  const close = store.close;
  if (typeof close === "function") close.call(store);
}

/**
 * Opens one home and wires its plugin callbacks to the kernel it returns. The
 * default event route uses the opened kernel; a caller that builds a kernel
 * with its own rules, such as `serve`, hands it over with `useKernelForEvents`.
 */
export async function openHome(options: OpenHomeOptions): Promise<OpenedHome> {
  const home = options.home;
  const cwd = options.cwd ?? process.cwd();
  const clock = options.clock ?? (() => Date.now());
  const config = options.config ?? (await readConfig(home));
  const storeRoot = storeRootOf(config);
  const problems: string[] = [];
  const onLog =
    options.onLog ??
    ((message: string) => {
      console.error(message);
    });
  const report = (message: string): void => {
    problems.push(message);
    onLog(message);
  };
  const store = openPluginStore({
    root: storeRoot,
    clock,
    ...(options.follow === undefined ? {} : { follow: options.follow }),
  });
  const log = openConfigLog(config, {
    clock,
    ...(options.follow === undefined ? {} : { follow: options.follow }),
  });
  let loaded: PluginRegistry | undefined;
  let openedKernel: Kernel | undefined;
  /**
   * The kernel emitted events use. Until `useKernelForEvents` names another,
   * it is the kernel this function opens.
   */
  let eventKernel: Kernel | undefined;

  const answer =
    options.onAnswer ??
    (async (
      runId: string,
      choice: string,
      note: string | undefined,
      actor: Actor,
    ): Promise<void> => {
      const run = await log.run(runId);
      if (run === undefined) throw new StateError(`no run "${runId}"`);
      await recordAnswer({
        log,
        runId,
        choice,
        ...(note === undefined ? {} : { note }),
        actor,
      });
      await options.afterAnswer?.(runId);
    });
  const event =
    options.onEvent ??
    (async (trigger: TriggerEvent): Promise<void> => {
      const kernel = eventKernel ?? openedKernel;
      if (kernel === undefined) {
        throw new StateError("the home is not open yet");
      }
      await kernel.receive(trigger);
    });
  const cancel =
    options.onCancelRun ??
    ((runId: string, flow?: FlowDefinition): Promise<boolean | void> =>
      cancelRun({
        log,
        flow: (name) => loaded?.flow(name)?.flow,
        runId,
        ...(flow === undefined ? {} : { graph: flow }),
        clock,
        source: options.cancelSource ?? "operad",
      }));
  const active =
    options.onRunActive ??
    (async (runId: string): Promise<boolean> => {
      const run = await log.run(runId);
      return run?.active === true;
    });

  let registry: PluginRegistry;
  try {
    registry = await loadPluginRegistry({
      installOnEnable: options.installOnEnable,
      optional: options.optional,
      standIns: options.standIns,
      home,
      cwd,
      store,
      clock,
      kernelVerbs: options.kernelVerbs ?? KERNEL_VERBS,
      onLog: report,
      onHomeFlowProblem: onLog,
      onAnswer: answer,
      onEvent: event,
      onCancelRun: cancel,
      onRunActive: active,
    });
  } catch (error: unknown) {
    // A retry opens again: what this attempt opened must not stay open.
    for (const close of [() => closePluginStore(store), () => log.close()]) {
      try {
        void Promise.resolve(close()).catch(() => undefined);
      } catch {
        // The load error below is the one to report.
      }
    }
    throw error;
  }
  loaded = registry;
  const views = createViews({
    registry,
    store,
    log,
    cwd: options.viewsCwd ?? cwd,
    clock,
    follow: options.follow ?? false,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    home,
    onLog: report,
  });
  const rules =
    options.rules ??
    (options.loadRules === undefined ? [] : await options.loadRules(registry));
  const kernel = new Kernel({
    log,
    registry,
    home,
    storeRoot,
    rules,
    clock,
    client: options.client ?? views,
    onLog: report,
  });
  openedKernel = kernel;
  eventKernel ??= kernel;
  const opened: OpenedHome = {
    home,
    cwd,
    config,
    store,
    storeRoot,
    log,
    registry,
    views,
    kernel,
    disabled: config.plugins
      .filter((entry) => !entry.enabled)
      .map((entry) => entry.name)
      .filter((name): name is string => name !== undefined),
    problems,
    useKernelForEvents(next: Kernel): void {
      eventKernel = next;
    },
  };
  return opened;
}
