/**
 * The integration queue: at most one integration of a repository runs at a
 * time. A task whose merge was chosen takes a ticket, a small file under
 * `<home>/dev/integration-queue/<repository>/` numbered in the order tickets
 * were taken. The first ticket whose process is alive has the turn; a ticket
 * whose process died is dropped by whoever looks next, so a turn is given back
 * however the integration ends. Waiting for a turn is not a check and holds no
 * check place.
 *
 * A turn that merges a batch claims the tickets queued behind it. A claimed
 * task does not take a turn of its own: it waits for the leader's result file.
 * A ticket is written only by its own task. Claims and "integrate alone" marks
 * are separate files the leader owns (`c-<leader>.json`, `s-<task>.json`), so a
 * task that leaves while it is claimed is never written back.
 *
 * Withdrawing a ticket and a leader's last check-and-push take the same lock
 * (`land.lock`): either the withdrawal comes first, so the leader sees it and
 * lands without that task, or the push comes first, so the task stays in the
 * batch. The lock is held across the push, and nothing slower.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { waitForChange, withLockFile } from "@operad-io/engine/platform";

/**
 * How long a waiter accepts a live holder of the land lock. The holder is
 * across a git push, which has no bound of its own, so the engine's 10 s
 * default would fail every cancel and leave behind a slow push.
 */
const LAND_LOCK_TIMEOUT_MS = 30 * 60 * 1000;

/** How often a waiting integration looks again when nothing announced a change. */
const RECHECK_MS = 500;

/** One queued task: what a leader needs to merge it for the task. */
export interface Ticket {
  readonly seq: number;
  readonly task: string;
  readonly run: string;
  readonly pid: number;
  readonly verified: string;
  readonly message: string;
  /** Set by a batch that fell back: this task integrates alone, never in a batch. */
  readonly solo?: true;
  /** The task whose batch this task is part of. */
  readonly claimedBy?: string;
}

/** What a batch's leader leaves for the tasks it merged. */
export interface BatchResult {
  readonly base: string;
  /** The pushed head of the batch. */
  readonly head: string;
  readonly note?: string | undefined;
  /**
   * `pending` from before the leader pushes until the push succeeds, `pushed`
   * once it has, and `done` after the leader recorded the merge. A pending
   * result whose leader is gone is settled by whether `head` landed. A result
   * without a state is done.
   */
  readonly state?: "pending" | "pushed" | "done" | undefined;
  readonly members: readonly { readonly task: string; readonly sha: string }[];
}

/** Thrown when the step is cancelled while it waits for its turn. */
export class IntegrationQueueCancelled extends Error {
  constructor() {
    super("cancelled while waiting to integrate");
    this.name = "IntegrationQueueCancelled";
  }
}

/** What waiting ends with. */
export type Turn =
  | { readonly kind: "turn" }
  | { readonly kind: "batched"; readonly leader: string; readonly result: BatchResult };

/** What withdrawing a ticket found: it went, or the leader had already pushed it. */
export type Withdrawal =
  | { readonly kind: "withdrawn" }
  | { readonly kind: "merged"; readonly leader: string; readonly result: BatchResult };

/** What a leader's last check, publish and push did. */
export type Landing = "withdrawn" | "pushed" | "failed";

/**
 * Test-only hooks. Production code never sets them. `lockWait` replaces the
 * wait of the land lock so a test can see a withdrawal wait behind a push;
 * `withdrawn` reports what that withdrawal found.
 */
export const integrationQueueTestHooks: {
  lockWait?: ((ms: number) => Promise<void>) | undefined;
  withdrawn?: ((task: string, kind: Withdrawal["kind"]) => void) | undefined;
} = {};

export interface QueueOptions {
  readonly home: string;
  readonly repository: { readonly name: string; readonly path: string };
  readonly task: string;
  readonly run: string;
  readonly verified: string;
  readonly message: string;
  readonly signal?: AbortSignal | undefined;
  /** Says who has the turn; called when that changes. */
  readonly say: (line: string, holder: string) => Promise<unknown> | unknown;
  /** How a waiting task waits before it looks again; tests inject this. */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  /** Whether a process is alive; tests inject this. */
  readonly alive?: ((pid: number) => boolean) | undefined;
  /** Whether a dead leader's pending batch reached the remote's main. */
  readonly landed?: ((result: BatchResult) => boolean) | undefined;
}

export function integrationQueueDirectory(
  home: string,
  repository: { readonly name: string; readonly path: string },
): string {
  const hash = new Bun.CryptoHasher("sha1").update(repository.path).digest("hex");
  const name = repository.name.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(home, "dev", "integration-queue", `${name}-${hash.slice(0, 8)}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function safeName(task: string): string {
  return task.replace(/[^A-Za-z0-9._-]/g, "_");
}

function landLockPath(directory: string): string {
  return join(directory, "land.lock");
}

function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function parseTicket(text: string): Ticket | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record.seq !== "number" ||
      typeof record.task !== "string" ||
      typeof record.run !== "string" ||
      typeof record.pid !== "number" ||
      typeof record.verified !== "string" ||
      typeof record.message !== "string"
    ) {
      return undefined;
    }
    return {
      seq: record.seq,
      task: record.task,
      run: record.run,
      pid: record.pid,
      verified: record.verified,
      message: record.message,
    };
  } catch {
    return undefined;
  }
}

export class IntegrationQueue {
  private readonly directory: string;
  private readonly alive: (pid: number) => boolean;
  private joined = false;

  constructor(private readonly options: QueueOptions) {
    this.directory = integrationQueueDirectory(options.home, options.repository);
    this.alive = options.alive ?? processAlive;
  }

  private ticketPath(task: string): string {
    return join(this.directory, `t-${safeName(task)}.json`);
  }

  private claimPath(leader: string): string {
    return join(this.directory, `c-${safeName(leader)}.json`);
  }

  private soloPath(task: string): string {
    return join(this.directory, `s-${safeName(task)}.json`);
  }

  private resultPath(leader: string): string {
    return join(this.directory, `r-${safeName(leader)}.json`);
  }

  /** The lock a withdrawal and a leader's last check-and-push share. */
  private withLandLock<T>(work: () => Promise<T> | T): Promise<T> {
    const wait = integrationQueueTestHooks.lockWait;
    return withLockFile(landLockPath(this.directory), work, {
      label: "integration queue",
      onLog: () => {},
      timeoutMs: LAND_LOCK_TIMEOUT_MS,
      ...(wait === undefined ? {} : { wait }),
    });
  }

  /** Removes this task's ticket and its "integrate alone" mark. */
  private removeTicket(): void {
    this.joined = false;
    rmSync(this.ticketPath(this.options.task), { force: true });
    rmSync(this.soloPath(this.options.task), { force: true });
    // Looking prunes what no one needs now: a leader's claim and result stay
    // while a task it claimed is still queued.
    this.tickets();
  }

  /** The live tickets in queue order; tickets of dead processes are dropped. */
  tickets(): readonly Ticket[] {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return [];
    }
    const live: Ticket[] = [];
    for (const name of names) {
      if (!name.startsWith("t-") || !name.endsWith(".json")) continue;
      const path = join(this.directory, name);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const ticket = parseTicket(text);
      if (ticket === undefined) continue;
      if (!this.alive(ticket.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      live.push(ticket);
    }
    live.sort((left, right) => left.seq - right.seq);
    // A claim holds while its leader is queued or has left a result; it
    // names only tasks that still have a ticket.
    const claims = new Map<string, string>();
    for (const name of names) {
      if (!name.startsWith("c-") || !name.endsWith(".json")) continue;
      const file = name.slice(2, -5);
      let claim: { leader?: unknown; members?: unknown } = {};
      try {
        claim = JSON.parse(readFileSync(join(this.directory, name), "utf8"));
      } catch {
        continue;
      }
      const leader = claim.leader;
      const members = claim.members;
      const claimed =
        Array.isArray(members) ? live.filter((ticket) => members.includes(ticket.task)) : [];
      const resulted = names.includes(`r-${file}.json`);
      if (
        typeof leader !== "string" ||
        claimed.length === 0 ||
        (!live.some((ticket) => ticket.task === leader) && !resulted)
      ) {
        rmSync(join(this.directory, name), { force: true });
        rmSync(join(this.directory, `r-${file}.json`), { force: true });
        continue;
      }
      for (const ticket of claimed) claims.set(ticket.task, leader);
    }
    for (const name of names) {
      if (!name.startsWith("r-") || !name.endsWith(".json")) continue;
      if (!existsSync(join(this.directory, `c-${name.slice(2)}`))) {
        rmSync(join(this.directory, name), { force: true });
      }
    }
    const solo = new Set<string>();
    for (const name of names) {
      if (!name.startsWith("s-") || !name.endsWith(".json")) continue;
      const owner = live.find((ticket) => safeName(ticket.task) === name.slice(2, -5));
      if (owner === undefined) rmSync(join(this.directory, name), { force: true });
      else solo.add(owner.task);
    }
    return live.map((ticket) => {
      const claimedBy = claims.get(ticket.task);
      return {
        ...ticket,
        ...(claimedBy === undefined ? {} : { claimedBy }),
        ...(solo.has(ticket.task) ? { solo: true as const } : {}),
      };
    });
  }

  /** Takes a ticket at the end of the queue. */
  async join(): Promise<void> {
    mkdirSync(this.directory, { recursive: true });
    await withLockFile(
      join(this.directory, "join.lock"),
      () => {
        const last = this.tickets().reduce((most, ticket) => Math.max(most, ticket.seq), 0);
        const ticket: Ticket = {
          seq: last + 1,
          task: this.options.task,
          run: this.options.run,
          pid: process.pid,
          verified: this.options.verified,
          message: this.options.message,
        };
        writeAtomic(this.ticketPath(this.options.task), ticket);
        this.joined = true;
      },
      { label: "integration queue", onLog: () => {} },
    );
  }

  /** Gives the turn back, and the ticket with it. */
  async leave(): Promise<void> {
    if (!this.joined) return;
    await this.withLandLock(() => this.removeTicket());
  }

  /**
   * A withdrawal takes the land lock, so it cannot slip between a leader's last
   * check and its push. It removes the ticket unless the leader already pushed
   * a batch that lists this task; then it says so and leaves the task to record
   * its merge.
   */
  async withdraw(): Promise<Withdrawal> {
    const withdrawal = await this.withLandLock(() => {
      const me = this.options.task;
      const mine = this.tickets().find((ticket) => ticket.task === me);
      // A follower reads its leader's result; the leader reads its own. The
      // leader's ticket is still here while it pushes, so it must be asked too.
      const leader = mine === undefined ? undefined : (mine.claimedBy ?? me);
      if (leader !== undefined) {
        const result = this.readResult(leader);
        if (
          result !== undefined &&
          result.state !== "pending" &&
          result.members.some((member) => member.task === me)
        ) {
          return { kind: "merged" as const, leader, result };
        }
      }
      this.removeTicket();
      return { kind: "withdrawn" as const };
    });
    integrationQueueTestHooks.withdrawn?.(this.options.task, withdrawal.kind);
    return withdrawal;
  }

  /**
   * The leader's last check, its result and the push, under the land lock. A
   * ticket that left first makes this land without its batch; a push that
   * lands first leaves a result a waiting withdrawal reads as merged.
   */
  async landWhenStillQueued(
    followers: readonly Ticket[],
    result: BatchResult,
    push: () => Promise<boolean> | boolean,
  ): Promise<Landing> {
    return this.withLandLock(async () => {
      const queued = new Set(this.tickets().map((ticket) => ticket.task));
      if (
        !queued.has(this.options.task) ||
        this.stillQueued(followers).length !== followers.length
      ) {
        return "withdrawn" as const;
      }
      this.publish(result);
      const pushed = await push();
      if (!pushed) return "failed" as const;
      this.markPushed();
      return "pushed" as const;
    });
  }

  private readResult(leader: string): BatchResult | undefined {
    try {
      return JSON.parse(readFileSync(this.resultPath(leader), "utf8")) as BatchResult;
    } catch {
      return undefined;
    }
  }

  /** Waits until this task has the turn or has been merged by a batch. */
  async turn(): Promise<Turn> {
    const me = this.options.task;
    let said: string | undefined;
    const wait =
      this.options.wait ??
      ((ms: number) => waitForChange(this.directory, "", ms));
    for (;;) {
      const tickets = this.tickets();
      const mine = tickets.find((ticket) => ticket.task === me);
      let holder: string | undefined;
      const claimed = mine?.claimedBy;
      if (claimed !== undefined) {
        // A merge already on main is reported even when the step was aborted
        // after the push: the result is read before the abort is.
        const result = this.readResult(claimed);
        if (result !== undefined && result.state !== "pending") {
          return { kind: "batched", leader: claimed, result };
        }
        if (result !== undefined && !tickets.some((ticket) => ticket.task === claimed)) {
          // The leader died between writing the result and recording the merge.
          if (this.options.landed?.(result) === true) {
            return { kind: "batched", leader: claimed, result };
          }
          // Its push never landed: the claim is void and this task goes on alone.
          rmSync(this.claimPath(claimed), { force: true });
          rmSync(this.resultPath(claimed), { force: true });
          continue;
        }
        holder = claimed;
      }
      if (this.options.signal?.aborted === true) {
        const withdrawal = await this.withdraw();
        if (withdrawal.kind === "merged") {
          return {
            kind: "batched",
            leader: withdrawal.leader,
            result: withdrawal.result,
          };
        }
        throw new IntegrationQueueCancelled();
      }
      // Only a withdrawal removes a live task's ticket; its run is cancelled.
      if (mine === undefined) throw new IntegrationQueueCancelled();
      if (holder === undefined) {
        const head = tickets.find((ticket) => ticket.claimedBy === undefined);
        if (head !== undefined && head.task === me) return { kind: "turn" };
        holder = head?.task;
      }
      if (holder !== undefined && said !== holder) {
        said = holder;
        await this.options.say(`waiting to integrate: ${holder} is integrating`, holder);
      }
      await wait(RECHECK_MS);
    }
  }

  /**
   * At the start of a turn: claims up to `limit - 1` tickets queued behind
   * this one that may join a batch, and returns them in queue order.
   */
  claim(limit: number): readonly Ticket[] {
    const me = this.options.task;
    const mine = this.tickets().find((ticket) => ticket.task === me);
    if (mine === undefined || mine.solo === true || limit <= 1) return [];
    const followers = this.tickets()
      .filter(
        (ticket) =>
          ticket.seq > mine.seq && ticket.solo !== true && ticket.claimedBy === undefined,
      )
      .slice(0, limit - 1);
    if (followers.length > 0) {
      writeAtomic(this.claimPath(me), {
        leader: me,
        members: followers.map((ticket) => ticket.task),
      });
    }
    return followers;
  }

  /** The claimed tasks that are still queued: a task that left is not merged. */
  stillQueued(followers: readonly Ticket[]): readonly Ticket[] {
    const queued = new Set(this.tickets().map((ticket) => ticket.task));
    return followers.filter((ticket) => queued.has(ticket.task));
  }

  /** A batch that could not land: its tasks integrate one by one, never batched again. */
  fallBack(followers: readonly Ticket[]): void {
    for (const ticket of followers) {
      writeAtomic(this.soloPath(ticket.task), { task: ticket.task });
    }
    rmSync(this.claimPath(this.options.task), { force: true });
    rmSync(this.resultPath(this.options.task), { force: true });
  }

  /** Leaves what the claimed tasks need to record their merges, before the push. */
  publish(result: BatchResult): void {
    writeAtomic(this.resultPath(this.options.task), { ...result, state: "pending" });
  }

  /** The push landed: a waiting withdrawal now reads the batch as merged. */
  private markPushed(): void {
    const result = this.readResult(this.options.task);
    if (result === undefined) return;
    writeAtomic(this.resultPath(this.options.task), { ...result, state: "pushed" });
  }

  /** The leader has recorded the merge: the result is final. */
  finish(): void {
    const result = this.readResult(this.options.task);
    if (result === undefined) return;
    writeAtomic(this.resultPath(this.options.task), { ...result, state: "done" });
  }

  /** A claimed task is done with the result. */
  async done(): Promise<void> {
    await this.leave();
  }
}

/**
 * Takes a task out of the integration queue on behalf of a cancel, with the
 * land lock a leader's last check-and-push takes. It answers `merged` when the
 * leader already pushed a batch that lists the task. The ticket goes at once,
 * before the cancelled run has seen its abort: that run can no longer push
 * (its last check finds no ticket), and the next task may start its turn while
 * the cancelled run is still winding down.
 */
export async function withdrawIntegration(
  home: string,
  repository: { readonly name: string; readonly path: string },
  task: string,
): Promise<Withdrawal> {
  return new IntegrationQueue({
    home,
    repository,
    task,
    run: "",
    verified: "",
    message: "",
    say: () => {},
  }).withdraw();
}
