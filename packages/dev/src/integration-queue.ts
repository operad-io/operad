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
  leave(): void {
    if (!this.joined) return;
    this.joined = false;
    rmSync(this.ticketPath(this.options.task), { force: true });
    rmSync(this.soloPath(this.options.task), { force: true });
    // Looking prunes what no one needs now: a leader's claim and result stay
    // while a task it claimed is still queued.
    this.tickets();
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
        if (result !== undefined) {
          return { kind: "batched", leader: claimed, result };
        }
        holder = claimed;
      }
      if (this.options.signal?.aborted === true) throw new IntegrationQueueCancelled();
      if (mine === undefined) throw new Error("the integration ticket is gone");
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

  /** Leaves what the claimed tasks need to record their merges. */
  publish(result: BatchResult): void {
    writeAtomic(this.resultPath(this.options.task), result);
  }

  /** A claimed task is done with the result. */
  done(): void {
    this.leave();
  }
}
