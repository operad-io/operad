/** The one entry point that starts runs, and the rules that point events at it. */

import type { KernelState, StartInput } from "../kernel/types.ts";
import { ActiveRunError } from "../log/errors.ts";
import type {
  JsonValue,
  LogBackend,
  RunInfo,
} from "../log/types.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type { SourceHandle } from "../plugin/types.ts";
import { messageOf } from "../plugin/errors.ts";
import { readState } from "../runner/service.ts";
import { TriggerStore, type StoredTriggerResult } from "./store.ts";
import {
  MAX_TRIGGER_HOPS,
  type StartRequest,
  type StartResult,
  type StepEvent,
  type TriggerCandidate,
  type TriggerEvent,
  type TriggerResult,
  type TriggerRule,
  type TriggerView,
} from "./types.ts";

export interface KernelOptions {
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly home: string;
  /** The store root: event files and the trigger journal live under it. */
  readonly storeRoot: string;
  readonly rules?: readonly TriggerRule[] | undefined;
  readonly clock?: (() => number) | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
  /** Overrides the event journal, for a test that places a crash in it. */
  readonly store?: TriggerStore | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventPayload(event: TriggerEvent): JsonValue {
  return { ...event } as unknown as JsonValue;
}

function objectOf(event: TriggerEvent): string | undefined {
  return typeof event.object === "string" && event.object.length > 0
    ? event.object
    : undefined;
}

/** A string field of a fact payload, if it is a non-empty string. */
function field(payload: JsonValue, name: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The event a recorded input payload carries, if it carries one. */
function eventFromPayload(payload: JsonValue): TriggerEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const source = payload.source;
  const key = payload.key;
  const type = payload.type;
  if (
    typeof source !== "string" ||
    typeof key !== "string" ||
    typeof type !== "string" ||
    source.length === 0 ||
    key.length === 0 ||
    type.length === 0
  ) {
    return undefined;
  }
  const hops =
    typeof payload.hops === "number" && Number.isInteger(payload.hops) && payload.hops >= 0
      ? payload.hops
      : 0;
  return {
    source,
    key,
    type,
    hops,
    ...(typeof payload.object === "string" ? { object: payload.object } : {}),
    ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
    ...(typeof payload.link === "string" ? { link: payload.link } : {}),
    ...(payload.data === undefined ? {} : { data: payload.data as JsonValue }),
  };
}

/** The last step result in a state, as a small summary for the run-end event. */
function lastStepSummary(state: KernelState): JsonValue {
  const entries = Object.entries(state.results);
  const last = entries[entries.length - 1];
  if (last === undefined) return null;
  const [effectId, value] = last;
  return { step: effectId.split(":")[0] ?? effectId, result: value.result };
}

/**
 * Starts one run through the kernel entry, for callers that do not keep a
 * `Kernel` around. The first four fields are the request; the rest is the
 * environment the kernel needs.
 */
export async function start(
  options: StartRequest & KernelOptions,
): Promise<StartResult> {
  const kernel = new Kernel(options);
  return kernel.start({
    flow: options.flow,
    object: options.object,
    ...(options.params === undefined ? {} : { params: options.params }),
    ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
    ...(options.inputId === undefined ? {} : { inputId: options.inputId }),
  });
}

export class Kernel {
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly home: string;
  readonly storeRoot: string;
  readonly store: TriggerStore;
  readonly rules: readonly TriggerRule[];
  readonly clock: () => number;
  private readonly onLog: (message: string) => void;
  private readonly runningSources: {
    readonly plugin: string;
    readonly handle: SourceHandle;
  }[] = [];

  constructor(options: KernelOptions) {
    this.log = options.log;
    this.registry = options.registry;
    this.home = options.home;
    this.storeRoot = options.storeRoot;
    this.rules = options.rules ?? [];
    this.clock = options.clock ?? (() => Date.now());
    this.onLog = options.onLog ?? ((message) => console.error(message));
    this.store =
      options.store ??
      new TriggerStore({
        root: `${options.storeRoot}/triggers`,
        clock: this.clock,
      });
  }

  /** The event a run sees, from the sidecar written when the run started. */
  triggerForRun(runId: string): TriggerView | undefined {
    return this.store.readRunTrigger(runId);
  }

  /**
   * Starts one run. When a trigger is given, its `source`+`key` is recorded
   * first and the run's start fact points at that input; a repeated event
   * returns the first result and starts nothing.
   */
  async start(request: StartRequest): Promise<StartResult> {
    const found = this.registry.flow(request.flow);
    if (found === undefined) {
      throw new Error(`flow "${request.flow}" is not loaded`);
    }
    if (typeof request.object !== "string" || request.object.length === 0) {
      throw new Error("start: object must be a non-empty string");
    }

    const trigger =
      request.trigger === undefined
        ? undefined
        : { ...request.trigger, hops: request.trigger.hops ?? 0 };
    const triggerHops = trigger?.hops ?? 0;
    let inputId = request.inputId;
    let view: TriggerView | undefined;

    // The log is the only truth: if a run already names this input as its
    // cause, that run is the result, even when the sidecar was lost.
    if (inputId !== undefined) {
      const already = await this.startedRun(inputId);
      if (already !== undefined) {
        this.store.setResult(inputId, {
          kind: "started",
          inputId,
          duplicate: false,
          runId: already.runId,
          flow: already.flow,
          object: already.object,
        });
        return { kind: "started", runId: already.runId, duplicate: true };
      }
    }

    if (trigger !== undefined) {
      if (!isRecord(trigger) || typeof trigger.source !== "string" || typeof trigger.key !== "string") {
        throw new Error("start: trigger needs a source and a key");
      }
      if (inputId === undefined) {
        const recorded = await this.log.recordInput(
          null,
          trigger.source,
          trigger.key,
          eventPayload(trigger),
        );
        inputId = recorded.inputId;
        if (recorded.duplicate) {
          const first = await this.firstResult(inputId);
          if (first !== undefined) return first;
          // Recorded but never routed: route it now with this event.
        }
      }
      if (this.store.event(inputId) === undefined) {
        this.store.recordEvent(inputId, trigger);
      }
      if (triggerHops > MAX_TRIGGER_HOPS) {
        const reason = `the chain is ${triggerHops} hops deep; at most ${MAX_TRIGGER_HOPS} are followed`;
        await this.log.appendGlobal({
          kind: "trigger_skipped",
          payload: {
            source: trigger.source,
            type: trigger.type,
            key: trigger.key,
            hops: trigger.hops,
            reason,
          },
          cause: inputId,
        });
        this.store.setResult(inputId, {
          kind: "skipped",
          inputId,
          duplicate: false,
          reason,
          ...(trigger.object === undefined ? {} : { object: trigger.object }),
        });
        return { kind: "skipped", reason, duplicate: false };
      }
      if (inputId === undefined) {
        throw new Error("start: trigger recording returned no input id");
      }
      view = this.store.writeEventFiles(inputId, trigger);
    }

    if (trigger !== undefined && inputId !== undefined) {
      const active = await this.activeRun(request.flow, request.object);
      if (active !== undefined) {
        await this.recordInRun(active, trigger, inputId);
        this.store.setResult(inputId, {
          kind: "active",
          inputId,
          duplicate: false,
          runId: active.runId,
          flow: request.flow,
          object: request.object,
        });
        return { kind: "active", runId: active.runId, duplicate: false };
      }
    }

    const start: StartInput = {
      kind: "start",
      ...(request.params === undefined ? {} : { params: request.params }),
      hops: triggerHops,
      ...(trigger === undefined
        ? {}
        : {
            trigger: {
              source: trigger.source,
              type: trigger.type,
              key: trigger.key,
            },
          }),
      ...(inputId === undefined ? {} : { inputId }),
    };

    // The run id only exists after `startRun`, so a process that dies between
    // creating the run and writing its start files would leave an idle run
    // with no record of the event that made it. The start is written under a
    // pending id first; `adoptStart` restores it on recovery.
    const pendingId = this.store.writePendingStart({
      flow: request.flow,
      object: request.object,
      ...(inputId === undefined ? {} : { inputId }),
      start,
      ...(view === undefined ? {} : { view }),
    });

    let info: RunInfo;
    try {
      info = await this.log.startRun(request.flow, request.object, inputId ?? null);
    } catch (error) {
      if (error instanceof ActiveRunError) {
        // This start created no run; the record must not be adopted later.
        this.store.dropPendingStart(pendingId);
      }
      if (error instanceof ActiveRunError && trigger !== undefined && inputId !== undefined) {
        const active = (await this.log.runs()).find((run) => run.runId === error.runId);
        if (active !== undefined) {
          await this.recordInRun(active, trigger, inputId);
          this.store.setResult(inputId, {
            kind: "active",
            inputId,
            duplicate: false,
            runId: active.runId,
            flow: request.flow,
            object: request.object,
          });
          return { kind: "active", runId: active.runId, duplicate: false };
        }
      }
      throw error;
    }

    // `start.json` is the commit point: it is written last, so a crash before
    // it lets `adoptStart` redo both files.
    if (view !== undefined) this.store.writeRunTrigger(info.runId, view);
    this.store.writeRunStart(info.runId, start);
    this.store.dropPendingStart(pendingId);

    if (trigger !== undefined && inputId !== undefined) {
      this.store.setResult(inputId, {
        kind: "started",
        inputId,
        duplicate: false,
        runId: info.runId,
        flow: request.flow,
        object: request.object,
      });
    }
    return { kind: "started", runId: info.runId, duplicate: false };
  }

  /**
   * Restores the start metadata of a run whose creator died between creating
   * the run and writing it. `serve` does this before it spawns a child, so the
   * child starts from the same input and sees the same event.
   */
  adoptStart(run: RunInfo): boolean {
    if (this.store.readRunStart(run.runId) !== undefined) return false;
    const pending = this.store.pendingStart(run.flow, run.object, run.startedAt);
    if (pending === undefined) return false;
    if (pending.view !== undefined) {
      this.store.writeRunTrigger(run.runId, pending.view);
    }
    this.store.writeRunStart(run.runId, pending.start);
    this.store.dropPendingStart(pending.id);
    return true;
  }

  /** Sends one outside event through the rules. */
  async receive(event: TriggerEvent): Promise<TriggerResult> {
    event = { ...event, hops: event.hops ?? 0 };
    if (
      typeof event.source !== "string" ||
      event.source.length === 0 ||
      typeof event.key !== "string" ||
      event.key.length === 0 ||
      typeof event.type !== "string" ||
      event.type.length === 0
    ) {
      throw new Error("event: source, key and type must be non-empty strings");
    }
    if (!Number.isInteger(event.hops) || event.hops < 0) {
      throw new Error("event: hops must be a non-negative integer");
    }

    const recorded = await this.log.recordInput(
      null,
      event.source,
      event.key,
      eventPayload(event),
    );
    const inputId = recorded.inputId;
    if (recorded.duplicate) {
      // A duplicate with no outcome is not routed yet: route it again. The
      // outcome is looked up by input id, so this cannot make a second run.
      if (this.store.event(inputId) === undefined) {
        this.store.recordEvent(inputId, event);
      }
      this.store.writeEventFiles(inputId, event);
      return this.route(inputId, event, true);
    }
    this.store.recordEvent(inputId, event);
    this.store.writeEventFiles(inputId, event);
    return this.route(inputId, event, false);
  }

  /**
   * Routes one event that the log already recorded. The result is stored, so
   * a second call for the same input reads the first outcome and changes
   * nothing. Recovery calls this for a recorded run-end event whose routing
   * was interrupted.
   */
  private async route(
    inputId: string,
    event: TriggerEvent,
    duplicate: boolean,
  ): Promise<TriggerResult> {
    const stored = this.store.result(inputId);
    if (stored !== undefined) return this.toTriggerResult(stored, duplicate);

    // The log derives the outcome: a run whose start names this input, a
    // receipt in a run's history, an observe or candidate fact, or a skip.
    const derived = await this.outcome(inputId);
    if (derived !== undefined) {
      this.store.setResult(inputId, derived);
      return this.toTriggerResult(derived, duplicate);
    }

    if (event.hops > MAX_TRIGGER_HOPS) {
      const reason = `the chain is ${event.hops} hops deep; at most ${MAX_TRIGGER_HOPS} are followed`;
      await this.log.appendGlobal({
        kind: "trigger_skipped",
        payload: {
          source: event.source,
          type: event.type,
          key: event.key,
          hops: event.hops,
          reason,
        },
        cause: inputId,
      });
      this.store.setResult(inputId, {
        kind: "skipped",
        inputId,
        duplicate: false,
        reason,
        ...(event.object === undefined ? {} : { object: event.object }),
      });
      return { kind: "skipped", inputId, duplicate, reason };
    }

    const rule = this.match(event);
    if (rule === undefined) {
      this.store.setResult(inputId, {
        kind: "recorded",
        inputId,
        duplicate: false,
        ...(event.object === undefined ? {} : { object: event.object }),
      });
      return { kind: "recorded", inputId, duplicate };
    }

    const object = this.resolveObject(rule, event);
    if (object === undefined) {
      this.store.setResult(inputId, {
        kind: "recorded",
        inputId,
        duplicate: false,
        reason: "the rule takes the event's object, but the event has none",
      });
      return { kind: "recorded", inputId, duplicate };
    }

    const active = await this.activeRun(rule.start.flow, object);
    if (active !== undefined) {
      await this.recordInRun(active, event, inputId);
      this.store.setResult(inputId, {
        kind: "active",
        inputId,
        duplicate: false,
        runId: active.runId,
        flow: rule.start.flow,
        object,
      });
      return {
        kind: "active",
        inputId,
        duplicate,
        runId: active.runId,
        flow: rule.start.flow,
        object,
      };
    }

    if (rule.mode === "observe") {
      const reason = `would start ${rule.start.flow} on ${object}`;
      await this.log.appendGlobal({
        kind: "trigger_observed",
        payload: {
          source: event.source,
          type: event.type,
          key: event.key,
          flow: rule.start.flow,
          object,
          reason,
        },
        cause: inputId,
      });
      this.store.setResult(inputId, {
        kind: "observed",
        inputId,
        duplicate: false,
        flow: rule.start.flow,
        object,
        reason,
      });
      return {
        kind: "observed",
        inputId,
        duplicate,
        flow: rule.start.flow,
        object,
      };
    }

    if (rule.mode === "candidate") {
      // The pending item is keyed by the input id; the fact is its durable
      // record, so a lost sidecar can rebuild the same candidate.
      await this.log.appendGlobal({
        kind: "trigger_candidate",
        payload: {
          flow: rule.start.flow,
          ...(rule.start.params === undefined ? {} : { params: rule.start.params }),
          object,
        },
        cause: inputId,
      });
      this.store.setResult(inputId, {
        kind: "candidate",
        inputId,
        duplicate: false,
        pendingId: inputId,
        flow: rule.start.flow,
        ...(rule.start.params === undefined ? {} : { params: rule.start.params }),
        object,
        status: "pending",
      });
      return {
        kind: "candidate",
        inputId,
        duplicate,
        pendingId: inputId,
        flow: rule.start.flow,
        object,
      };
    }

    const result = await this.start({
      flow: rule.start.flow,
      ...(rule.start.params === undefined ? {} : { params: rule.start.params }),
      object,
      trigger: event,
      inputId,
    });
    return this.toTriggerResult(
      {
        kind: result.kind === "started" ? "started" : result.kind,
        inputId,
        duplicate: result.duplicate,
        ...("runId" in result ? { runId: result.runId } : {}),
        flow: rule.start.flow,
        object,
      },
      duplicate,
    );
  }

  /** Cancels a candidate without starting it. */
  dismiss(pendingId: string): TriggerCandidate {
    const candidate = this.store.candidate(pendingId);
    if (candidate === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }
    if (candidate.status !== "pending") {
      throw new Error(`pending item "${pendingId}" is already ${candidate.status}`);
    }
    this.store.setResult(candidate.inputId, {
      kind: "candidate",
      inputId: candidate.inputId,
      duplicate: false,
      pendingId,
      flow: candidate.flow,
      ...(candidate.params === undefined ? {} : { params: candidate.params }),
      object: candidate.object,
      status: "dismissed",
    });
    return { ...candidate, status: "dismissed" };
  }

  /** Starts a candidate through the same entry every other start uses. */
  async startCandidate(pendingId: string): Promise<StartResult> {
    const candidate = this.store.candidate(pendingId);
    if (candidate === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }
    if (candidate.status !== "pending") {
      throw new Error(`pending item "${pendingId}" is already ${candidate.status}`);
    }
    const result = await this.start({
      flow: candidate.flow,
      ...(candidate.params === undefined ? {} : { params: candidate.params }),
      object: candidate.object,
      trigger: candidate.event,
      inputId: candidate.inputId,
    });
    this.store.setResult(candidate.inputId, {
      kind: "candidate",
      inputId: candidate.inputId,
      duplicate: false,
      pendingId,
      flow: candidate.flow,
      ...(candidate.params === undefined ? {} : { params: candidate.params }),
      object: candidate.object,
      status: "started",
      ...("runId" in result ? { runId: result.runId } : {}),
    });
    return result;
  }

  /** Emits the event that ends a run, once per run id. */
  async emitRunEnd(runId: string, state: KernelState): Promise<void> {
    const status = state.endedStatus;
    if (status === null) return;
    const runs = await this.log.runs();
    const run = runs.find((candidate) => candidate.runId === runId);
    if (run === undefined) return;
    const type = `run.${status}`;
    const event: TriggerEvent = {
      source: "operad",
      key: runId,
      type,
      object: run.object,
      hops: state.hops + 1,
      data: {
        result: status,
        summary: lastStepSummary(state),
      },
    };
    // Record the event before ending the run: a crash in between leaves the
    // run active, and the next pass records the same event again (the input
    // store dedupes source+key). A run that is still active would receive the
    // event instead of the rule starting a run on the same object, so the run
    // is ended before the event goes back through the rules.
    const recorded = await this.log.recordInput(
      null,
      event.source,
      event.key,
      eventPayload(event),
    );
    const inputId = recorded.inputId;
    if (this.store.event(inputId) === undefined) {
      this.store.recordEvent(inputId, event);
    }
    this.store.writeEventFiles(inputId, event);
    await this.log.endRun(runId);
    try {
      await this.route(inputId, event, recorded.duplicate);
    } catch (error) {
      this.onLog(`run ${runId}: run-end event failed: ${messageOf(error)}`);
    }
  }

  /**
   * Routes every recorded event whose outcome is not in the log yet. `serve`
   * calls this once per pass, so a crash anywhere in receiving an event is
   * picked up on the next start. The sidecar only caches outcomes.
   */
  async recoverUnrouted(): Promise<void> {
    for await (const input of this.log.readInputs()) {
      if (input.runId !== null) continue;
      const event = eventFromPayload(input.payload);
      if (event === undefined) continue;
      try {
        await this.route(input.inputId, event, true);
      } catch (error) {
        this.onLog(
          `trigger ${input.inputId}: event routing failed: ${messageOf(error)}`,
        );
      }
    }
  }

  /** Handles an event a step emitted; the run scopes the key and sets hops. */
  async emitStep(
    runId: string,
    plugin: string,
    event: StepEvent,
    object: string | undefined,
  ): Promise<TriggerResult> {
    if (!event.type.startsWith(`${plugin}.`)) {
      throw new Error(
        `emit: type "${event.type}" must begin with "${plugin}."`,
      );
    }
    const state = await readState(this.log, runId);
    const eventObject = event.object ?? object;
    const trigger: TriggerEvent = {
      source: "operad",
      key: `${runId}:${event.key}`,
      type: event.type,
      ...(eventObject === undefined ? {} : { object: eventObject }),
      ...(event.summary === undefined ? {} : { summary: event.summary }),
      ...(event.data === undefined ? {} : { data: event.data }),
      hops: state.hops + 1,
    };
    const result = await this.receive(trigger);
    if (result.kind === "skipped" && result.reason !== undefined) {
      await this.recordSkip(runId, trigger, result.reason);
    }
    return result;
  }

  /** Starts every loaded source; a broken one is logged and skipped. */
  async startSources(): Promise<void> {
    const running = await this.registry.startSources({
      rules: this.rules,
      clock: this.clock,
      emit: async (event) => {
        await this.receive(event);
      },
    });
    this.runningSources.push(...running);
  }

  /** Stops every source. A source that throws while stopping is logged. */
  async stopSources(): Promise<void> {
    const running = this.runningSources.splice(0);
    for (const source of running) {
      try {
        await source.handle.stop();
      } catch (error) {
        this.onLog(
          `plugin "${source.plugin}": stop failed: ${messageOf(error)}`,
        );
      }
    }
  }

  private match(event: TriggerEvent): TriggerRule | undefined {
    return this.rules.find((rule) => {
      if (rule.source !== event.source || rule.type !== event.type) return false;
      return this.resolveObject(rule, event) !== undefined;
    });
  }

  private resolveObject(
    rule: TriggerRule,
    event: TriggerEvent,
  ): string | undefined {
    if (rule.object === "$event.object") return objectOf(event);
    return rule.object;
  }

  private async activeRun(
    flow: string,
    object: string,
  ): Promise<RunInfo | undefined> {
    const active = await this.log.runs({ active: true });
    return active.find((run) => run.flow === flow && run.object === object);
  }

  private async recordInRun(
    run: RunInfo,
    event: TriggerEvent,
    inputId: string | undefined,
  ): Promise<void> {
    const state = await readState(this.log, run.runId);
    if (state.status === "ended" || inputId === undefined) return;
    await this.log.append(run.runId, state.lastSeq, [
      {
        kind: "trigger_received",
        payload: {
          source: event.source,
          type: event.type,
          key: event.key,
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.link === undefined ? {} : { link: event.link }),
          hops: event.hops,
        },
        cause: inputId,
      },
    ]);
  }

  private async recordSkip(
    runId: string,
    event: TriggerEvent,
    reason: string,
  ): Promise<void> {
    try {
      const state = await readState(this.log, runId);
      await this.log.append(runId, state.lastSeq, [
        {
          kind: "trigger_skipped",
          payload: {
            source: event.source,
            type: event.type,
            key: event.key,
            hops: event.hops,
            reason,
          },
          cause: `${event.source}:${event.key}`,
        },
      ]);
    } catch (error) {
      this.onLog(`run ${runId}: could not record a skipped event: ${messageOf(error)}`);
    }
  }

  /** The first result for an input, from the sidecar or derived from the log. */
  private async firstResult(inputId: string): Promise<StartResult | undefined> {
    const stored = this.store.result(inputId);
    if (stored !== undefined) return this.toStartResult(stored, inputId);
    const derived = await this.outcome(inputId);
    if (derived === undefined) return undefined;
    this.store.setResult(inputId, derived);
    return this.toStartResult(derived, inputId);
  }

  private toStartResult(
    stored: Omit<StoredTriggerResult, "at">,
    inputId: string,
  ): StartResult {
    switch (stored.kind) {
      case "started":
        return stored.runId === undefined
          ? { kind: "recorded", duplicate: true }
          : { kind: "started", runId: stored.runId, duplicate: true };
      case "active":
        return stored.runId === undefined
          ? { kind: "recorded", duplicate: true }
          : { kind: "active", runId: stored.runId, duplicate: true };
      case "candidate":
        return {
          kind: "candidate",
          pendingId: stored.pendingId ?? inputId,
          duplicate: true,
        };
      case "observed":
        return { kind: "observed", duplicate: true };
      case "skipped":
        return {
          kind: "skipped",
          reason: stored.reason ?? "the event was not followed",
          duplicate: true,
        };
      default:
        return { kind: "recorded", duplicate: true };
    }
  }

  /** The run the log says this input started, if any. */
  private async startedRun(inputId: string): Promise<RunInfo | undefined> {
    const runs = await this.log.runs();
    return runs.find((run) => run.startInputId === inputId);
  }

  /**
   * The outcome of an input, derived from the log alone. A run started by the
   * input, a receipt in a run's history, an observe or candidate fact, or a
   * skip fact is the result; anything else has not been routed.
   */
  private async outcome(
    inputId: string,
  ): Promise<Omit<StoredTriggerResult, "at"> | undefined> {
    const runs = await this.log.runs();
    const started = runs.find((run) => run.startInputId === inputId);
    if (started !== undefined) {
      return {
        kind: "started",
        inputId,
        duplicate: false,
        runId: started.runId,
        flow: started.flow,
        object: started.object,
      };
    }

    for (const run of runs) {
      for await (const fact of this.log.read(run.runId)) {
        if (fact.cause !== inputId) continue;
        if (fact.kind === "run_started") {
          return {
            kind: "started",
            inputId,
            duplicate: false,
            runId: run.runId,
            flow: run.flow,
            object: run.object,
          };
        }
        if (fact.kind === "trigger_received") {
          return {
            kind: "active",
            inputId,
            duplicate: false,
            runId: run.runId,
            flow: run.flow,
            object: run.object,
          };
        }
        if (fact.kind === "trigger_skipped") {
          return {
            kind: "skipped",
            inputId,
            duplicate: false,
            reason: field(fact.payload, "reason") ?? "the event was not followed",
          };
        }
      }
    }

    for await (const fact of this.log.readGlobal()) {
      if (fact.cause !== inputId) continue;
      if (fact.kind === "trigger_observed") {
        const flow = field(fact.payload, "flow");
        const object = field(fact.payload, "object");
        return {
          kind: "observed",
          inputId,
          duplicate: false,
          ...(flow === undefined ? {} : { flow }),
          ...(object === undefined ? {} : { object }),
        };
      }
      if (fact.kind === "trigger_candidate") {
        const flow = field(fact.payload, "flow");
        const object = field(fact.payload, "object");
        if (flow === undefined || object === undefined) continue;
        return {
          kind: "candidate",
          inputId,
          duplicate: false,
          pendingId: inputId,
          flow,
          object,
        };
      }
      if (fact.kind === "trigger_skipped") {
        return {
          kind: "skipped",
          inputId,
          duplicate: false,
          reason: field(fact.payload, "reason") ?? "the event was not followed",
        };
      }
    }
    return undefined;
  }

  private toTriggerResult(
    stored: {
      readonly kind: TriggerResult["kind"];
      readonly inputId: string;
      readonly duplicate: boolean;
      readonly runId?: string;
      readonly pendingId?: string;
      readonly flow?: string;
      readonly object?: string;
      readonly reason?: string;
    },
    duplicate: boolean,
  ): TriggerResult {
    return {
      kind: stored.kind,
      inputId: stored.inputId,
      duplicate,
      ...(stored.runId === undefined ? {} : { runId: stored.runId }),
      ...(stored.pendingId === undefined ? {} : { pendingId: stored.pendingId }),
      ...(stored.flow === undefined ? {} : { flow: stored.flow }),
      ...(stored.object === undefined ? {} : { object: stored.object }),
      ...(stored.reason === undefined ? {} : { reason: stored.reason }),
    };
  }
}
