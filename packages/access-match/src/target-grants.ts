/**
 * The target grants of a background run: a person's "always for this flow and
 * this target" answer, in `$OPERAD_HOME/access-grants.json` (ADR 0025 D12).
 *
 * A grant is bound to a flow's definition identity and to one outward target.
 * The identity is a generated id kept beside the definition's digest: every
 * time the digest differs from the last one seen, a new id is made. An edit
 * therefore asks again even after it is reverted, because reverting is another
 * change from the digest last seen. The grant is never bound to the content
 * that is sent, so a daily message with new text to the same target stays
 * allowed.
 *
 * The file is the user layer, like `access-user.json`: hand-editable, written
 * under the platform file lock and replaced whole. It lives here, beside the
 * guard, because the shell and dev steps call the guard without the harness
 * packages.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, type Actor, type FlowDefinition, type OutwardWrite } from "@operad-io/engine";
import { withLockFile } from "@operad-io/engine/platform";

/** The file name of the target grants under the operad home. */
export const ACCESS_GRANTS_FILE = "access-grants.json";

/** One flow definition's identity: the digest last seen and its generated id. */
export interface FlowDefinitionIdentity {
  readonly flow: string;
  readonly digest: string;
  /** Changes whenever the digest differs from the last one seen; never reused. */
  readonly id: string;
}

/** One target a person allowed for one flow definition. */
export interface TargetGrant {
  readonly flow: string;
  /** The definition identity the person answered for. */
  readonly definition: string;
  readonly kind: OutwardWrite["kind"];
  readonly target: string;
  /** Who answered. */
  readonly by: Actor;
  /** When the answer came, in epoch milliseconds. */
  readonly at: number;
}

/** Everything the file holds. */
export interface TargetGrantFile {
  readonly flows: readonly FlowDefinitionIdentity[];
  readonly grants: readonly TargetGrant[];
}

/** The file, and a readable problem when it had to be treated as empty. */
export interface TargetGrantRead {
  readonly file: TargetGrantFile;
  readonly problem?: string;
}

/** The file of the target grants in an operad home. */
export function accessGrantsPath(home: string): string {
  return join(home, ACCESS_GRANTS_FILE);
}

function emptyFile(): TargetGrantFile {
  return { flows: [], grants: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function actorOf(value: unknown): Actor | undefined {
  if (!isRecord(value) || !nonEmpty(value["via"]) || !nonEmpty(value["id"])) return undefined;
  return { via: value["via"], id: value["id"] };
}

function flowIdentityOf(value: unknown): FlowDefinitionIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const flow = value["flow"];
  const digest = value["digest"];
  const id = value["id"];
  if (!nonEmpty(flow) || !nonEmpty(digest) || !nonEmpty(id)) return undefined;
  return { flow, digest, id };
}

const OUTWARD_KINDS = new Set<OutwardWrite["kind"]>(["channel", "mail", "post", "repository", "service", "command"]);

function targetGrantOf(value: unknown): TargetGrant | undefined {
  if (!isRecord(value)) return undefined;
  const flow = value["flow"];
  const definition = value["definition"];
  const kind = value["kind"];
  const target = value["target"];
  const by = actorOf(value["by"]);
  const at = value["at"];
  if (!nonEmpty(flow) || !nonEmpty(definition) || !nonEmpty(target)) return undefined;
  if (typeof kind !== "string" || !OUTWARD_KINDS.has(kind as OutwardWrite["kind"])) return undefined;
  if (by === undefined || typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return { flow, definition, kind: kind as OutwardWrite["kind"], target, by, at };
}

function invalid(path: string, detail: string): TargetGrantRead {
  return { file: emptyFile(), problem: `the target grants file "${path}" ${detail}; it is treated as empty` };
}

/** Reads the target grants; a missing file is empty, and an invalid one is empty with a problem. */
export async function readTargetGrants(home: string): Promise<TargetGrantRead> {
  const path = accessGrantsPath(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { file: emptyFile() };
    return invalid(path, `cannot be read: ${messageOf(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return invalid(path, `is not valid JSON: ${messageOf(error)}`);
  }
  if (!isRecord(raw)) return invalid(path, "must be a JSON object with flows and grants arrays");
  const flowsRaw = raw["flows"] ?? [];
  const grantsRaw = raw["grants"] ?? [];
  if (!Array.isArray(flowsRaw)) return invalid(path, "flows must be an array");
  if (!Array.isArray(grantsRaw)) return invalid(path, "grants must be an array");
  const flows: FlowDefinitionIdentity[] = [];
  for (let index = 0; index < flowsRaw.length; index += 1) {
    const entry = flowIdentityOf(flowsRaw[index]);
    if (entry === undefined) return invalid(path, `flow entry ${index} needs a flow, digest and id`);
    flows.push(entry);
  }
  const grants: TargetGrant[] = [];
  for (let index = 0; index < grantsRaw.length; index += 1) {
    const entry = targetGrantOf(grantsRaw[index]);
    if (entry === undefined) {
      return invalid(path, `grant entry ${index} needs a flow, definition, kind, target, by and at`);
    }
    grants.push(entry);
  }
  return { file: { flows, grants } };
}

/** A stable JSON reading, so the same definition always gives the same digest. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  const text = JSON.stringify(value);
  return text === undefined ? "null" : text;
}

/** The digest of one flow definition, without its name alone standing for its structure. */
export function flowDefinitionDigest(flow: FlowDefinition): string {
  return createHash("sha256").update(canonical(flow)).digest("hex");
}

async function writeTargetGrants(home: string, file: TargetGrantFile): Promise<void> {
  const path = accessGrantsPath(home);
  await mkdir(home, { recursive: true });
  const temporary = join(home, `.${ACCESS_GRANTS_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file was never made, or is already gone.
    }
    throw error;
  }
}

/** Reads the file again inside the lock, and gives the current definition identity. */
async function refreshFlow(home: string, flow: FlowDefinition): Promise<string> {
  const path = accessGrantsPath(home);
  return withLockFile(`${path}.lock`, async () => {
    const read = await readTargetGrants(home);
    const digest = flowDefinitionDigest(flow);
    const current = read.file.flows.find((entry) => entry.flow === flow.name);
    if (current !== undefined && current.digest === digest) return current.id;
    const id = randomUUID();
    const flows = [...read.file.flows.filter((entry) => entry.flow !== flow.name), { flow: flow.name, digest, id }];
    await writeTargetGrants(home, { flows, grants: read.file.grants });
    return id;
  }, { label: "access target grants" });
}

/**
 * The grant for this flow definition and target, if one is there. Looking at a
 * write first records a changed definition, so an edit and a later revert each
 * give a new identity and no older grant can come back.
 */
export async function targetGrantFor(
  home: string,
  flow: FlowDefinition,
  target: string,
): Promise<TargetGrant | undefined> {
  const identity = await refreshFlow(home, flow);
  const read = await readTargetGrants(home);
  const wanted = target.trim();
  return read.file.grants.find(
    (grant) => grant.flow === flow.name && grant.definition === identity && grant.target === wanted,
  );
}

/** Appends or replaces the grant of one flow definition and target. */
export async function appendTargetGrant(
  home: string,
  flow: FlowDefinition,
  write: OutwardWrite,
  by: Actor,
  at: number,
): Promise<TargetGrant> {
  const path = accessGrantsPath(home);
  return withLockFile(`${path}.lock`, async () => {
    const read = await readTargetGrants(home);
    const digest = flowDefinitionDigest(flow);
    const current = read.file.flows.find((entry) => entry.flow === flow.name);
    const id = current !== undefined && current.digest === digest ? current.id : randomUUID();
    const flows = current !== undefined && current.digest === digest
      ? read.file.flows
      : [...read.file.flows.filter((entry) => entry.flow !== flow.name), { flow: flow.name, digest, id }];
    const target = write.target.trim();
    const entry: TargetGrant = {
      flow: flow.name,
      definition: id,
      kind: write.kind,
      target,
      by,
      at,
    };
    const grants = [
      ...read.file.grants.filter(
        (grant) => !(grant.flow === flow.name && grant.definition === id && grant.target === target),
      ),
      entry,
    ];
    await writeTargetGrants(home, { flows, grants });
    return entry;
  }, { label: "access target grants" });
}

/** Removes every grant for one target, or for one flow's target; returns how many went. */
export async function revokeTargetGrants(
  home: string,
  target: string,
  flow?: string,
): Promise<number> {
  const path = accessGrantsPath(home);
  return withLockFile(`${path}.lock`, async () => {
    const read = await readTargetGrants(home);
    const wanted = target.trim();
    const kept = read.file.grants.filter(
      (grant) => !(grant.target === wanted && (flow === undefined || grant.flow === flow)),
    );
    const removed = read.file.grants.length - kept.length;
    if (removed > 0) await writeTargetGrants(home, { flows: read.file.flows, grants: kept });
    return removed;
  }, { label: "access target grants" });
}
