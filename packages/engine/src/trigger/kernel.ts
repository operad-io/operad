/** The one entry point that starts runs, and the rules that point events at it. */

import type { KernelState, StartInput } from "../kernel/types.ts";
import { inputIdFor } from "../log/facts.ts";
import { ActiveRunError } from "../log/errors.ts";
import type {
  InputOutcome,
  InputRecord,
  JsonValue,
  LogBackend,
  RunInfo,
} from "../log/types.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type { SourceHandle } from "../plugin/types.ts";
import { messageOf } from "../plugin/errors.ts";
import { readState } from "../runner/service.ts";
import { TriggerStore } from "./store.ts";
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
  /** The store root: event files and the trigger metadata live under it. */
  readonly storeRoot: string;
  readonly rules?: readonly TriggerRule[] | undefined;
  readonly clock?: (() => number) | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    ...(typeof payload.link === "string" ? { link: payload.link } : {}),
  };
}

/** What a step sees of a recorded event: paths to files, never their text. */
function viewFromPayload(payload: JsonValue): TriggerView | undefined {
  const event = eventFromPayload(payload);
  if (event === undefined || !isRecord(payload)) return undefined;
  return {
    source: event.source,
    key: event.key,
    type: event.type,
    ...(event.link === undefined ? {} : { link: event.link }),
    hops: event.hops,
    ...(typeof payload.summaryFile === "string"
      ? { summary: payload.summaryFile }
      : {}),
    ...(typeof payload.dataFile === "string" ? { data: payload.dataFile } : {}),
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
    this.store = new TriggerStore({
      root: `${options.storeRoot}/triggers`,
      clock: this.clock,
    });
  }

  /** The event a run sees, from the store written when the run started. */
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

    let inputId = request.inputId;
    if (inputId !== undefined) {
      const already = await this.startedRun(inputId);
      if (already !== undefined) {
        return { kind: "started", runId: already.runId, duplicate: true };
      }
    }

    const given = request.trigger;
    let trigger: TriggerEvent | undefined;
    let view: TriggerView | undefined;

    if (given !== undefined) {
      if (
        !isRecord(given) ||
        typeof given.source !== "string" ||
        typeof given.key !== "string" ||
        typeof given.type !== "string"
      ) {
        throw new Error("start: trigger needs a source, a key and a type");
      }
      const hops = given.hops ?? 0;
      let duplicate = false;
      if (inputId === undefined) {
        const prepared = this.prepareEvent({ ...given, hops });
        const recorded = await this.log.recordInput(
          null,
          given.source,
          given.key,
          prepared.payload,
        );
        inputId = recorded.inputId;
        duplicate = recorded.duplicate;
      }
      const input = inputId === undefined ? undefined : await this.findInput(inputId);
      trigger =
        (input === undefined ? undefined : eventFromPayload(input.payload)) ?? {
          ...given,
          hops,
        };
      view = input === undefined ? undefined : viewFromPayload(input.payload);
      if (inputId !== undefined && view === undefined) {
        view = this.store.writeEventFiles(inputId, trigger);
      }
      if (duplicate && inputId !== undefined) {
        // Recorded before, with an outcome: that outcome is the first result.
        const existing = await this.outcome(inputId);
        if (existing !== undefined) return this.toStartResult(existing, inputId);
      }
      if (trigger.hops > MAX_TRIGGER_HOPS && inputId !== undefined) {
        const reason = `the chain is ${trigger.hops} hops deep; at most ${MAX_TRIGGER_HOPS} are followed`;
        await this.recordOutcome(inputId, "skipped", {
          reason,
          ...(trigger.object === undefined ? {} : { object: trigger.object }),
        });
        return { kind: "skipped", reason, duplicate };
      }
      if (inputId !== undefined) {
        const active = await this.activeRun(request.flow, request.object);
        if (active !== undefined && active.startInputId === inputId) {
          await this.recordOutcome(inputId, "started", {
            runId: active.runId,
            flow: active.flow,
            object: active.object,
          });
          return { kind: "started", runId: active.runId, duplicate };
        }
        if (active !== undefined) {
          await this.recordInRun(active, trigger, inputId);
          await this.recordOutcome(inputId, "active", {
            runId: active.runId,
            flow: request.flow,
            object: request.object,
          });
          return { kind: "active", runId: active.runId, duplicate };
        }
      }
    }

    if (trigger !== undefined && inputId === undefined) {
      throw new Error("start: trigger recording returned no input id");
    }

    const start: StartInput = {
      kind: "start",
      ...(request.params === undefined ? {} : { params: request.params }),
      hops: trigger?.hops ?? 0,
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
        if (active !== undefined && active.startInputId === inputId) {
          // Another caller started this very event; that run is the result.
          await this.recordOutcome(inputId, "started", {
            runId: active.runId,
            flow: active.flow,
            object: active.object,
          });
          return { kind: "started", runId: active.runId, duplicate: true };
        }
        if (active !== undefined) {
          await this.recordInRun(active, trigger, inputId);
          await this.recordOutcome(inputId, "active", {
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
      await this.recordOutcome(inputId, "started", {
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

    const prepared = this.prepareEvent(event);
    const recorded = await this.log.recordInput(
      null,
      event.source,
      event.key,
      prepared.payload,
    );
    return this.route(recorded.inputId, recorded.duplicate);
  }

  /**
   * Routes one event the log already recorded. The event comes from the
   * recorded input payload, and the outcome comes from the log's outcome
   * store, so a duplicate call and a recovery pass reach the same result.
   */
  private async route(
    inputId: string,
    duplicate: boolean,
  ): Promise<TriggerResult> {
    const input = await this.findInput(inputId);
    if (input === undefined) {
      throw new Error(`input "${inputId}" is not recorded`);
    }
    const event = eventFromPayload(input.payload);
    if (event === undefined) {
      throw new Error(`input "${inputId}" carries no event`);
    }

    const stored = await this.outcome(inputId);
    if (stored !== undefined) {
      return this.toTriggerResult(stored, duplicate);
    }

    // A run the log says this input started is an outcome too, even when the
    // process died before it could record one.
    const started = await this.startedRun(inputId);
    if (started !== undefined) {
      const outcome = await this.recordOutcome(inputId, "started", {
        runId: started.runId,
        flow: started.flow,
        object: started.object,
      });
      return this.toTriggerResult(outcome, duplicate);
    }
    const fromFacts = await this.outcomeFromFacts(inputId);
    if (fromFacts !== undefined) {
      const outcome = await this.recordOutcome(inputId, fromFacts.kind, fromFacts.payload);
      return this.toTriggerResult(outcome, duplicate);
    }

    if (event.hops > MAX_TRIGGER_HOPS) {
      const reason = `the chain is ${event.hops} hops deep; at most ${MAX_TRIGGER_HOPS} are followed`;
      const outcome = await this.recordOutcome(inputId, "skipped", {
        reason,
        ...(event.object === undefined ? {} : { object: event.object }),
      });
      return this.toTriggerResult(outcome, duplicate);
    }

    const rule = this.match(event);
    if (rule === undefined) {
      const outcome = await this.recordOutcome(inputId, "recorded", {
        ...(event.object === undefined ? {} : { object: event.object }),
      });
      return this.toTriggerResult(outcome, duplicate);
    }

    const object = this.resolveObject(rule, event);
    if (object === undefined) {
      const outcome = await this.recordOutcome(inputId, "recorded", {
        reason: "the rule takes the event's object, but the event has none",
      });
      return this.toTriggerResult(outcome, duplicate);
    }

    const active = await this.activeRun(rule.start.flow, object);
    if (active !== undefined) {
      if (active.startInputId === inputId) {
        const outcome = await this.recordOutcome(inputId, "started", {
          runId: active.runId,
          flow: active.flow,
          object: active.object,
        });
        return this.toTriggerResult(outcome, duplicate);
      }
      await this.recordInRun(active, event, inputId);
      const outcome = await this.recordOutcome(inputId, "active", {
        runId: active.runId,
        flow: rule.start.flow,
        object,
      });
      return this.toTriggerResult(outcome, duplicate);
    }

    if (rule.mode === "observe") {
      const outcome = await this.recordOutcome(inputId, "observed", {
        flow: rule.start.flow,
        object,
        reason: `would start ${rule.start.flow} on ${object}`,
      });
      return this.toTriggerResult(outcome, duplicate);
    }

    if (rule.mode === "candidate") {
      const outcome = await this.recordOutcome(inputId, "candidate", {
        flow: rule.start.flow,
        ...(rule.start.params === undefined ? {} : { params: rule.start.params }),
        object,
        pendingId: inputId,
      });
      return this.toTriggerResult(outcome, duplicate);
    }

    const result = await this.start({
      flow: rule.start.flow,
      ...(rule.start.params === undefined ? {} : { params: rule.start.params }),
      object,
      trigger: event,
      inputId,
    });
    return {
      kind: result.kind,
      inputId,
      duplicate,
      ...("runId" in result ? { runId: result.runId } : {}),
      flow: rule.start.flow,
      object,
    };
  }

  /** The candidates still waiting for a person, oldest first. */
  async candidates(): Promise<readonly TriggerCandidate[]> {
    const latest = await this.latestOutcomes();
    const inputs = new Map<string, InputRecord>();
    for await (const input of this.log.readInputs()) {
      inputs.set(input.inputId, input);
    }
    const list: TriggerCandidate[] = [];
    for (const [inputId, outcome] of latest) {
      const candidate = this.candidateFrom(outcome, inputs.get(inputId));
      if (candidate !== undefined) list.push(candidate);
    }
    return list.sort(
      (left, right) =>
        left.at - right.at || left.pendingId.localeCompare(right.pendingId),
    );
  }

  /** Cancels a candidate without starting it. */
  async dismiss(pendingId: string): Promise<TriggerCandidate> {
    const outcome = await this.outcome(pendingId);
    if (outcome === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }
    if (outcome.kind === "dismissed") {
      throw new Error(`pending item "${pendingId}" is already dismissed`);
    }
    if (outcome.kind !== "candidate") {
      throw new Error(`pending item "${pendingId}" is already ${outcome.kind}`);
    }
    const input = await this.findInput(pendingId);
    const candidate = this.candidateFrom(outcome, input);
    if (candidate === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }
    await this.recordOutcome(pendingId, "dismissed", { pendingId });
    return { ...candidate, status: "dismissed" };
  }

  /** Starts a candidate through the same entry every other start uses. */
  async startCandidate(pendingId: string): Promise<StartResult> {
    const outcome = await this.outcome(pendingId);
    if (outcome === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }
    if (outcome.kind !== "candidate") {
      throw new Error(`pending item "${pendingId}" is already ${outcome.kind}`);
    }
    const input = await this.findInput(pendingId);
    const candidate = this.candidateFrom(outcome, input);
    if (candidate === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }
    return this.start({
      flow: candidate.flow,
      ...(candidate.params === undefined ? {} : { params: candidate.params }),
      object: candidate.object,
      trigger: candidate.event,
      inputId: candidate.inputId,
    });
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
    const prepared = this.prepareEvent(event);
    const recorded = await this.log.recordInput(
      null,
      event.source,
      event.key,
      prepared.payload,
    );
    const inputId = recorded.inputId;
    await this.log.endRun(runId);
    try {
      await this.route(inputId, recorded.duplicate);
    } catch (error) {
      this.onLog(`run ${runId}: run-end event failed: ${messageOf(error)}`);
    }
  }

  /**
   * Routes every recorded event whose outcome is not in the log yet. `serve`
   * calls this once per pass, so a crash anywhere in receiving an event is
   * picked up on the next start.
   */
  async recoverUnrouted(): Promise<void> {
    const known = await this.latestOutcomes();
    for await (const input of this.log.readInputs()) {
      if (input.runId !== null) continue;
      if (known.has(input.inputId)) continue;
      if (eventFromPayload(input.payload) === undefined) continue;
      try {
        await this.route(input.inputId, true);
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

  /**
   * Writes the event's summary and data files and returns the payload the log
   * keeps: the event fields, with file paths instead of the text itself.
   */
  private prepareEvent(event: TriggerEvent): {
    readonly inputId: string;
    readonly payload: JsonValue;
    readonly view: TriggerView;
  } {
    const inputId = inputIdFor(event.source, event.key);
    const paths = this.store.eventPaths(inputId);
    const view = this.store.writeEventFiles(inputId, event);
    const payload: JsonValue = {
      source: event.source,
      key: event.key,
      type: event.type,
      hops: event.hops,
      ...(event.object === undefined ? {} : { object: event.object }),
      ...(event.link === undefined ? {} : { link: event.link }),
      ...(event.summary === undefined ? {} : { summaryFile: paths.summary }),
      ...(event.data === undefined ? {} : { dataFile: paths.data }),
    };
    return { inputId, payload, view };
  }

  private async findInput(inputId: string): Promise<InputRecord | undefined> {
    for await (const input of this.log.readInputs()) {
      if (input.inputId === inputId) return input;
    }
    return undefined;
  }

  private async recordOutcome(
    inputId: string,
    kind: string,
    payload: JsonValue,
  ): Promise<InputOutcome> {
    const recorded = await this.log.recordOutcome(inputId, kind, payload);
    return recorded.outcome;
  }

  private async latestOutcomes(): Promise<Map<string, InputOutcome>> {
    const latest = new Map<string, InputOutcome>();
    for await (const outcome of this.log.readOutcomes()) {
      const current = latest.get(outcome.inputId);
      if (current === undefined || outcome.seq > current.seq) {
        latest.set(outcome.inputId, outcome);
      }
    }
    return latest;
  }

  private async outcome(inputId: string): Promise<InputOutcome | undefined> {
    let latest: InputOutcome | undefined;
    for await (const outcome of this.log.readOutcomes()) {
      if (outcome.inputId !== inputId) continue;
      if (latest === undefined || outcome.seq > latest.seq) latest = outcome;
    }
    return latest;
  }

  /** A routed result, from the payload of its stored outcome. */
  private toTriggerResult(
    outcome: InputOutcome,
    duplicate: boolean,
  ): TriggerResult {
    const payload = isRecord(outcome.payload) ? outcome.payload : {};
    const kind =
      outcome.kind === "dismissed"
        ? "recorded"
        : (outcome.kind as TriggerResult["kind"]);
    return {
      kind,
      inputId: outcome.inputId,
      duplicate,
      ...(typeof payload.runId === "string" ? { runId: payload.runId } : {}),
      ...(typeof payload.pendingId === "string"
        ? { pendingId: payload.pendingId }
        : kind === "candidate"
          ? { pendingId: outcome.inputId }
          : {}),
      ...(typeof payload.flow === "string" ? { flow: payload.flow } : {}),
      ...(typeof payload.object === "string" ? { object: payload.object } : {}),
      ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    };
  }

  private toStartResult(outcome: InputOutcome, inputId: string): StartResult {
    const payload = isRecord(outcome.payload) ? outcome.payload : {};
    switch (outcome.kind) {
      case "started":
        return typeof payload.runId === "string"
          ? { kind: "started", runId: payload.runId, duplicate: true }
          : { kind: "recorded", duplicate: true };
      case "active":
        return typeof payload.runId === "string"
          ? { kind: "active", runId: payload.runId, duplicate: true }
          : { kind: "recorded", duplicate: true };
      case "candidate":
        return {
          kind: "candidate",
          pendingId:
            typeof payload.pendingId === "string" ? payload.pendingId : inputId,
          duplicate: true,
        };
      case "observed":
        return { kind: "observed", duplicate: true };
      case "skipped":
        return {
          kind: "skipped",
          reason:
            typeof payload.reason === "string"
              ? payload.reason
              : "the event was not followed",
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

  /** An outcome the log already shows in a run's facts. */
  private async outcomeFromFacts(
    inputId: string,
  ): Promise<{ kind: string; payload: JsonValue } | undefined> {
    for (const run of await this.log.runs()) {
      for await (const fact of this.log.read(run.runId)) {
        if (fact.cause !== inputId) continue;
        if (fact.kind === "run_started") {
          return {
            kind: "started",
            payload: { runId: run.runId, flow: run.flow, object: run.object },
          };
        }
        if (fact.kind === "trigger_received") {
          return {
            kind: "active",
            payload: { runId: run.runId, flow: run.flow, object: run.object },
          };
        }
        if (fact.kind === "trigger_skipped") {
          return {
            kind: "skipped",
            payload: {
              reason: field(fact.payload, "reason") ?? "the event was not followed",
            },
          };
        }
      }
    }
    return undefined;
  }

  /** A candidate from an outcome and the input it points at. */
  private candidateFrom(
    outcome: InputOutcome,
    input: InputRecord | undefined,
  ): TriggerCandidate | undefined {
    if (outcome.kind !== "candidate" || input === undefined) return undefined;
    const event = eventFromPayload(input.payload);
    if (event === undefined) return undefined;
    const payload = isRecord(outcome.payload) ? outcome.payload : {};
    const flow = field(outcome.payload, "flow");
    const object = field(outcome.payload, "object");
    if (flow === undefined || object === undefined) return undefined;
    const params = payload.params;
    return {
      pendingId: outcome.inputId,
      inputId: outcome.inputId,
      flow,
      ...(params === undefined ? {} : { params: params as JsonValue }),
      object,
      event,
      status: "pending",
      at: outcome.time,
    };
  }
}
