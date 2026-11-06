/** The one entry point that starts runs, and the rules that point events at it. */

import type { KernelState, StartInput } from "../kernel/types.ts";
import { inputIdFor } from "../log/facts.ts";
import { ActiveRunError, SeqConflictError } from "../log/errors.ts";
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

/** One decision per input: what the event would do. */
const ROUTE = "route";
/** A second decision per candidate input: how a person resolved it. */
const RESOLVE = "resolve";

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

function payloadOf(outcome: InputOutcome): Record<string, JsonValue> {
  return isRecord(outcome.payload) ? outcome.payload : {};
}

/** The value a claimed decision carries, such as `started` or `dismissed`. */
function valueOf(outcome: InputOutcome): string | undefined {
  return field(outcome.payload, "value");
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
  /** One in-flight route per input, so same-process callers share a decision. */
  private readonly routing = new Map<string, Promise<TriggerResult>>();

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

    // An input a route or a candidate already claimed: realise that claim,
    // never a second one. The log's first decision is the result.
    if (request.inputId !== undefined) {
      const inputId = request.inputId;
      const input = await this.findInput(inputId);
      const claimed = await this.outcome(inputId, ROUTE);
      if (claimed === undefined) {
        await this.claimRoute(inputId, {
          value: "started",
          flow: request.flow,
          object: request.object,
          ...(request.params === undefined ? {} : { params: request.params }),
        });
      }
      return this.startResultFor(inputId, input);
    }

    const given = request.trigger;
    if (given === undefined) {
      const realized = await this.realizeStart(
        undefined,
        request.flow,
        request.params,
        request.object,
        undefined,
      );
      return { kind: "started", runId: realized.runId, duplicate: false };
    }

    if (
      !isRecord(given) ||
      typeof given.source !== "string" ||
      typeof given.key !== "string" ||
      typeof given.type !== "string"
    ) {
      throw new Error("start: trigger needs a source, a key and a type");
    }
    const hops = given.hops ?? 0;
    const event: TriggerEvent = { ...given, hops };
    const prepared = this.prepareEvent(event);
    const recorded = await this.log.recordInput(
      null,
      event.source,
      event.key,
      prepared.payload,
    );
    const inputId = recorded.inputId;
    const input = await this.findInput(inputId);

    const claimed = await this.outcome(inputId, ROUTE);
    if (claimed === undefined) {
      await this.claimRoute(inputId, {
        value: "started",
        flow: request.flow,
        object: request.object,
        ...(request.params === undefined ? {} : { params: request.params }),
      });
    }
    return this.startResultFor(inputId, input, recorded.duplicate);
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
   * Routes one event the log already recorded. The claim is written before any
   * side effect, so concurrent callers agree on one decision; the side effect
   * is idempotent on the input id, so a crash between the two is finished by
   * the next pass.
   */
  private async route(
    inputId: string,
    duplicate: boolean,
  ): Promise<TriggerResult> {
    const inflight = this.routing.get(inputId);
    if (inflight !== undefined) {
      const result = await inflight;
      return duplicate ? { ...result, duplicate: true } : result;
    }
    const work = this.routeOnce(inputId);
    this.routing.set(inputId, work);
    try {
      const result = await work;
      return duplicate ? { ...result, duplicate: true } : result;
    } finally {
      this.routing.delete(inputId);
    }
  }

  /** The work behind one route, shared by concurrent callers. */
  private async routeOnce(inputId: string): Promise<TriggerResult> {
    const input = await this.findInput(inputId);
    if (input === undefined) {
      throw new Error(`input "${inputId}" is not recorded`);
    }
    const event = eventFromPayload(input.payload);
    if (event === undefined) {
      throw new Error(`input "${inputId}" carries no event`);
    }

    let claimed = await this.outcome(inputId, ROUTE);
    if (claimed === undefined) {
      claimed = await this.claimRoute(
        inputId,
        await this.routeDecision(inputId, event),
      );
    }
    return this.realizeRoute(inputId, input, event, claimed, false);
  }

  /**
   * Claims the route decision. The first write wins; every concurrent caller
   * and every retry after a crash reads the same stored decision.
   */
  private async claimRoute(
    inputId: string,
    payload: Record<string, JsonValue>,
  ): Promise<InputOutcome> {
    const recorded = await this.log.recordOutcome(inputId, ROUTE, payload);
    return recorded.outcome;
  }

  /** What one recorded event would do, before the claim is written. */
  private async routeDecision(
    inputId: string,
    event: TriggerEvent,
  ): Promise<Record<string, JsonValue>> {
    // A run the log says this input started is the decision, even when the
    // process died before it could write one.
    const started = await this.startedRun(inputId);
    if (started !== undefined) {
      return {
        value: "started",
        flow: started.flow,
        object: started.object,
      };
    }

    if (event.hops > MAX_TRIGGER_HOPS) {
      return {
        value: "skipped",
        reason: `the chain is ${event.hops} hops deep; at most ${MAX_TRIGGER_HOPS} are followed`,
        ...(event.object === undefined ? {} : { object: event.object }),
      };
    }

    const rule = this.match(event);
    if (rule === undefined) {
      return {
        value: "none",
        ...(event.object === undefined ? {} : { object: event.object }),
      };
    }

    const object = this.resolveObject(rule, event);
    if (object === undefined) {
      return {
        value: "none",
        reason: "the rule takes the event's object, but the event has none",
      };
    }

    const active = await this.activeRun(rule.start.flow, object);
    if (active !== undefined) {
      if (active.startInputId === inputId) {
        return { value: "started", flow: rule.start.flow, object };
      }
      return {
        value: "in_run",
        runId: active.runId,
        flow: active.flow,
        object: active.object,
      };
    }

    if (rule.mode === "observe") {
      return { value: "observed", flow: rule.start.flow, object };
    }
    if (rule.mode === "candidate") {
      return {
        value: "candidate",
        flow: rule.start.flow,
        object,
        ...(rule.start.params === undefined ? {} : { params: rule.start.params }),
      };
    }
    return {
      value: "started",
      flow: rule.start.flow,
      object,
      ...(rule.start.params === undefined ? {} : { params: rule.start.params }),
    };
  }

  /** Finishes the side effect a claimed route decision names. */
  private async realizeRoute(
    inputId: string,
    input: InputRecord,
    event: TriggerEvent,
    outcome: InputOutcome,
    duplicate: boolean,
  ): Promise<TriggerResult> {
    const value = valueOf(outcome);
    const flow = field(outcome.payload, "flow");
    const object = field(outcome.payload, "object");
    const base = {
      inputId,
      duplicate,
      ...(flow === undefined ? {} : { flow }),
      ...(object === undefined ? {} : { object }),
    };

    switch (value) {
      case "started": {
        if (flow === undefined || object === undefined) {
          return { kind: "recorded", ...base };
        }
        const params = payloadOf(outcome).params;
        const realized = await this.realizeStart(
          inputId,
          flow,
          params,
          object,
          input,
        );
        return {
          kind: realized.kind === "active" ? "active" : "started",
          ...base,
          runId: realized.runId,
        };
      }
      case "in_run": {
        const runId = field(outcome.payload, "runId");
        if (runId !== undefined) {
          await this.ensureRunFact(
            runId,
            "trigger_received",
            {
              source: event.source,
              type: event.type,
              key: event.key,
              ...(event.summary === undefined ? {} : { summary: event.summary }),
              ...(event.link === undefined ? {} : { link: event.link }),
              hops: event.hops,
            },
            inputId,
          );
        }
        return {
          kind: "active",
          ...base,
          ...(runId === undefined ? {} : { runId }),
        };
      }
      case "observed":
        await this.ensureObservedFact(
          inputId,
          flow ?? "a flow",
          object ?? "an object",
        );
        return { kind: "observed", ...base };
      case "candidate":
        return { kind: "candidate", ...base, pendingId: inputId };
      case "skipped":
        return {
          kind: "skipped",
          ...base,
          reason:
            field(outcome.payload, "reason") ?? "the event was not followed",
        };
      default:
        return { kind: "recorded", ...base };
    }
  }

  /** The candidates still waiting for a person, oldest first. */
  async candidates(): Promise<readonly TriggerCandidate[]> {
    const inputs = new Map<string, InputRecord>();
    for await (const input of this.log.readInputs()) {
      inputs.set(input.inputId, input);
    }
    const resolved = new Set<string>();
    const routes: InputOutcome[] = [];
    for await (const outcome of this.log.readOutcomes()) {
      if (outcome.kind === RESOLVE) resolved.add(outcome.inputId);
      if (outcome.kind === ROUTE && valueOf(outcome) === "candidate") {
        routes.push(outcome);
      }
    }
    const list: TriggerCandidate[] = [];
    for (const outcome of routes) {
      if (resolved.has(outcome.inputId)) continue;
      const candidate = this.candidateFrom(outcome, inputs.get(outcome.inputId));
      if (candidate !== undefined) list.push(candidate);
    }
    return list.sort(
      (left, right) =>
        left.at - right.at || left.pendingId.localeCompare(right.pendingId),
    );
  }

  /** Cancels a candidate without starting it. */
  async dismiss(pendingId: string): Promise<TriggerCandidate> {
    const route = await this.outcome(pendingId, ROUTE);
    if (route === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }
    if (valueOf(route) !== "candidate") {
      throw new Error(
        `pending item "${pendingId}" is already ${valueOf(route) ?? "resolved"}`,
      );
    }
    const input = await this.findInput(pendingId);
    const candidate = this.candidateFrom(route, input);
    if (candidate === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }

    const recorded = await this.log.recordOutcome(
      pendingId,
      RESOLVE,
      { value: "dismissed", pendingId },
    );
    const resolved = valueOf(recorded.outcome);
    if (resolved === "started") {
      const started = await this.startedRun(pendingId);
      const runId = field(recorded.outcome.payload, "runId") ?? started?.runId;
      throw new Error(
        `pending item "${pendingId}" is already started${runId === undefined ? "" : ` as ${runId}`}`,
      );
    }
    if (resolved !== "dismissed") {
      throw new Error(
        `pending item "${pendingId}" is already ${resolved ?? "resolved"}`,
      );
    }
    return { ...candidate, status: "dismissed" };
  }

  /** Starts a candidate through the same entry every other start uses. */
  async startCandidate(pendingId: string): Promise<StartResult> {
    const route = await this.outcome(pendingId, ROUTE);
    if (route === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }
    if (valueOf(route) !== "candidate") {
      throw new Error(
        `pending item "${pendingId}" is already ${valueOf(route) ?? "resolved"}`,
      );
    }
    const input = await this.findInput(pendingId);
    const candidate = this.candidateFrom(route, input);
    if (candidate === undefined) {
      throw new Error(`no pending item "${pendingId}"`);
    }

    const recorded = await this.log.recordOutcome(
      pendingId,
      RESOLVE,
      {
        value: "started",
        flow: candidate.flow,
        object: candidate.object,
      },
    );
    const resolved = valueOf(recorded.outcome);
    if (resolved === "dismissed") {
      throw new Error(`pending item "${pendingId}" is already dismissed`);
    }
    if (resolved !== "started") {
      throw new Error(
        `pending item "${pendingId}" is already ${resolved ?? "resolved"}`,
      );
    }

    const realized = await this.realizeStart(
      pendingId,
      candidate.flow,
      candidate.params,
      candidate.object,
      input,
    );
    return {
      kind: realized.kind === "active" ? "active" : "started",
      runId: realized.runId,
      duplicate: recorded.duplicate,
    };
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
   * Routes every recorded event whose side effect may not be finished. `serve`
   * calls this once per pass, so a crash anywhere in receiving an event is
   * picked up on the next start. The claim is the guard: routing again can
   * never double a run or a fact.
   */
  async recoverUnrouted(): Promise<void> {
    for await (const input of this.log.readInputs()) {
      if (input.runId !== null) continue;
      if (eventFromPayload(input.payload) === undefined) continue;
      try {
        await this.route(input.inputId, true);
      } catch (error) {
        this.onLog(
          `trigger ${input.inputId}: event routing failed: ${messageOf(error)}`,
        );
      }
    }

    // A candidate a person started, whose run the process never created.
    for await (const outcome of this.log.readOutcomes()) {
      if (outcome.kind !== RESOLVE || valueOf(outcome) !== "started") continue;
      const route = await this.outcome(outcome.inputId, ROUTE);
      if (route === undefined || valueOf(route) !== "candidate") continue;
      const input = await this.findInput(outcome.inputId);
      const candidate = this.candidateFrom(route, input);
      if (candidate === undefined) continue;
      try {
        await this.realizeStart(
          outcome.inputId,
          candidate.flow,
          candidate.params,
          candidate.object,
          input,
        );
      } catch (error) {
        this.onLog(
          `trigger ${outcome.inputId}: candidate start failed: ${messageOf(error)}`,
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
      await this.recordSkip(runId, trigger, result.reason, result.inputId);
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

  /** Appends a run fact once per input id; a sequence conflict is retried. */
  private async ensureRunFact(
    runId: string,
    kind: string,
    payload: JsonValue,
    inputId: string | undefined,
  ): Promise<void> {
    if (inputId === undefined) return;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // Read the sequence first, then look for the fact: a write that lands
      // between the two is seen by the scan, and a write after it makes the
      // append conflict, so two processes cannot both add the fact.
      const state = await readState(this.log, runId);
      if (state.status === "ended") return;
      let found = false;
      for await (const fact of this.log.read(runId)) {
        if (fact.cause === inputId && fact.kind === kind) {
          found = true;
          break;
        }
      }
      if (found) return;
      try {
        await this.log.append(runId, state.lastSeq, [
          { kind, payload, cause: inputId },
        ]);
        return;
      } catch (error) {
        if (error instanceof SeqConflictError) continue;
        throw error;
      }
    }
    this.onLog(`run ${runId}: could not record ${kind} after a sequence conflict`);
  }

  /** Writes the "would start" fact once per input id, enforced by the log. */
  private async ensureObservedFact(
    inputId: string,
    flow: string,
    object: string,
  ): Promise<void> {
    await this.log.appendGlobal(
      {
        kind: "trigger_observed",
        payload: {
          inputId,
          flow,
          object,
          reason: `would start ${flow} on ${object}`,
        },
        cause: inputId,
      },
      `trigger_observed:${inputId}`,
    );
  }

  private async recordSkip(
    runId: string,
    event: TriggerEvent,
    reason: string,
    inputId: string | undefined,
  ): Promise<void> {
    try {
      await this.ensureRunFact(
        runId,
        "trigger_skipped",
        {
          source: event.source,
          type: event.type,
          key: event.key,
          hops: event.hops,
          reason,
        },
        inputId,
      );
    } catch (error) {
      this.onLog(
        `run ${runId}: could not record a skipped event: ${messageOf(error)}`,
      );
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

  private async outcome(
    inputId: string,
    kind: string,
  ): Promise<InputOutcome | undefined> {
    for await (const outcome of this.log.readOutcomes()) {
      if (outcome.inputId === inputId && outcome.kind === kind) return outcome;
    }
    return undefined;
  }

  /** A result for an input whose route decision is already claimed. */
  private async startResultFor(
    inputId: string,
    input: InputRecord | undefined,
    duplicate = true,
  ): Promise<StartResult> {
    const claimed = await this.outcome(inputId, ROUTE);
    if (claimed === undefined) {
      throw new Error(`input "${inputId}" has no route decision`);
    }
    const value = valueOf(claimed);
    const flow = field(claimed.payload, "flow");
    const object = field(claimed.payload, "object");
    switch (value) {
      case "started": {
        if (flow === undefined || object === undefined) {
          return { kind: "recorded", duplicate };
        }
        const params = payloadOf(claimed).params;
        const realized = await this.realizeStart(
          inputId,
          flow,
          params,
          object,
          input,
        );
        return {
          kind: realized.kind === "active" ? "active" : "started",
          runId: realized.runId,
          duplicate,
        };
      }
      case "in_run": {
        const runId = field(claimed.payload, "runId");
        return runId === undefined
          ? { kind: "recorded", duplicate }
          : { kind: "active", runId, duplicate };
      }
      case "candidate":
        return { kind: "candidate", pendingId: inputId, duplicate };
      case "observed":
        return { kind: "observed", duplicate };
      case "skipped":
        return {
          kind: "skipped",
          reason:
            field(claimed.payload, "reason") ?? "the event was not followed",
          duplicate,
        };
      default:
        return { kind: "recorded", duplicate };
    }
  }

  /**
   * Creates the run for an input at most once. The start files are written
   * after the run exists, so a recovered run restores them from its pending
   * start before a child takes over.
   */
  private async realizeStart(
    inputId: string | undefined,
    flow: string,
    params: JsonValue | undefined,
    object: string,
    input: InputRecord | undefined,
  ): Promise<{ readonly kind: "started" | "active"; readonly runId: string }> {
    if (inputId !== undefined) {
      const existing = await this.startedRun(inputId);
      if (existing !== undefined) {
        this.ensureStartFiles(existing, inputId, params, object, input);
        return { kind: "started", runId: existing.runId };
      }
    }

    const view = input === undefined ? undefined : viewFromPayload(input.payload);
    const event: TriggerEvent | undefined =
      view === undefined
        ? undefined
        : {
            source: view.source,
            key: view.key,
            type: view.type,
            hops: view.hops,
            ...(view.link === undefined ? {} : { link: view.link }),
          };
    const start: StartInput = {
      kind: "start",
      ...(params === undefined ? {} : { params }),
      hops: view?.hops ?? 0,
      ...(event === undefined
        ? {}
        : { trigger: { source: event.source, type: event.type, key: event.key } }),
      ...(inputId === undefined ? {} : { inputId }),
    };

    const pendingId = this.store.writePendingStart({
      flow,
      object,
      ...(inputId === undefined ? {} : { inputId }),
      start,
      ...(view === undefined ? {} : { view }),
    });

    let info: RunInfo;
    try {
      info = await this.log.startRun(flow, object, inputId ?? null);
    } catch (error) {
      if (error instanceof ActiveRunError) {
        // This start created no run; the record must not be adopted later.
        this.store.dropPendingStart(pendingId);
        const active = (await this.log.runs()).find(
          (run) => run.runId === error.runId,
        );
        if (active !== undefined) {
          if (inputId !== undefined && active.startInputId === inputId) {
            this.ensureStartFiles(active, inputId, params, object, input);
            return { kind: "started", runId: active.runId };
          }
          if (event !== undefined && inputId !== undefined) {
            await this.ensureRunFact(
              active.runId,
              "trigger_received",
              {
                source: event.source,
                type: event.type,
                key: event.key,
                ...(event.summary === undefined ? {} : { summary: event.summary }),
                ...(event.link === undefined ? {} : { link: event.link }),
                hops: event.hops,
              },
              inputId,
            );
          }
          return { kind: "active", runId: active.runId };
        }
      }
      throw error;
    }

    // `start.json` is the commit point: it is written last, so a crash before
    // it lets `adoptStart` redo both files.
    if (view !== undefined) this.store.writeRunTrigger(info.runId, view);
    this.store.writeRunStart(info.runId, start);
    this.store.dropPendingStart(pendingId);
    return { kind: "started", runId: info.runId };
  }

  /** Writes a run's start files if they are missing, from its pending start. */
  private ensureStartFiles(
    run: RunInfo,
    inputId: string,
    params: JsonValue | undefined,
    object: string,
    input: InputRecord | undefined,
  ): void {
    if (this.store.readRunStart(run.runId) !== undefined) return;
    if (this.adoptStart(run)) return;
    const view = input === undefined ? undefined : viewFromPayload(input.payload);
    const start: StartInput = {
      kind: "start",
      ...(params === undefined ? {} : { params }),
      hops: view?.hops ?? 0,
      ...(view === undefined
        ? {}
        : { trigger: { source: view.source, type: view.type, key: view.key } }),
      inputId,
    };
    if (view !== undefined) this.store.writeRunTrigger(run.runId, view);
    this.store.writeRunStart(run.runId, start);
  }

  /** The run the log says this input started, if any. */
  private async startedRun(inputId: string): Promise<RunInfo | undefined> {
    const runs = await this.log.runs();
    return runs.find((run) => run.startInputId === inputId);
  }

  /** A candidate from a route outcome and the input it points at. */
  private candidateFrom(
    outcome: InputOutcome,
    input: InputRecord | undefined,
  ): TriggerCandidate | undefined {
    if (valueOf(outcome) !== "candidate" || input === undefined) return undefined;
    const event = eventFromPayload(input.payload);
    if (event === undefined) return undefined;
    const flow = field(outcome.payload, "flow");
    const object = field(outcome.payload, "object");
    if (flow === undefined || object === undefined) return undefined;
    const params = payloadOf(outcome).params;
    return {
      pendingId: outcome.inputId,
      inputId: outcome.inputId,
      flow,
      ...(params === undefined ? {} : { params }),
      object,
      event,
      status: "pending",
      at: outcome.time,
    };
  }
}
