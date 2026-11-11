/**
 * The `prepare` commands of dev.json: run in a checkout after it is created or
 * moved to a new commit, before a step uses it. A checkout without them can
 * still resolve its own workspace packages (`linkWorkspacePackages`).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { isRecord, messageOf, type StepContext, type StepRunOptions } from "@operad-io/engine";

import type { DevSettings } from "./settings.ts";

/** The reason a step reports when a prepare command failed. */
export const PREPARE_FAILED = "prepare failed";

export function stepOptions(ctx: StepContext, cwd: string): StepRunOptions {
  return {
    runId: ctx.runId,
    cwd,
    ...(ctx.object === undefined ? {} : { object: ctx.object }),
    params: ctx.params,
    access: ctx.access,
    ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
    signal: ctx.signal,
  };
}

export interface PrepareFailure {
  /** Always `PREPARE_FAILED`. */
  readonly reason: typeof PREPARE_FAILED;
  /** `prepare failed`, then the log path or the host error. */
  readonly message: string;
  readonly log?: string;
}

/**
 * Runs `settings.prepare` in `path`. Returns undefined when it passed or there
 * is nothing to run, otherwise the failure.
 */
export async function runPrepare(
  ctx: StepContext,
  settings: DevSettings,
  path: string,
): Promise<PrepareFailure | undefined> {
  if (settings.prepare.length === 0) return undefined;
  const runStep = ctx.runStep;
  if (runStep === undefined) {
    return {
      reason: PREPARE_FAILED,
      message: `${PREPARE_FAILED}: the kernel did not offer a way to run the prepare commands`,
    };
  }
  try {
    const outcome = await runStep(
      "shell/check",
      {
        cwd: path,
        timeoutSecs: settings.gate.commandTimeoutSecs,
        lines: settings.prepare,
      },
      stepOptions(ctx, path),
    );
    if (outcome.result === "pass") return undefined;
    const data = isRecord(outcome.data) ? outcome.data : {};
    const log = typeof data.log === "string" ? data.log : undefined;
    return {
      reason: PREPARE_FAILED,
      message: `${PREPARE_FAILED}${log === undefined ? "" : `; log: ${log}`}`,
      ...(log === undefined ? {} : { log }),
    };
  } catch (error) {
    return {
      reason: PREPARE_FAILED,
      message: `${PREPARE_FAILED}: ${messageOf(error)}`,
    };
  }
}

/** The workspace package directories of a checkout, from its `packages/*` folders. */
function workspacePackages(root: string): { name: string; dir: string }[] {
  const found: { name: string; dir: string }[] = [];
  let hasWorkspaces = false;
  try {
    const rootJson: unknown = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    hasWorkspaces = isRecord(rootJson) && rootJson.workspaces !== undefined;
  } catch {
    return found;
  }
  if (!hasWorkspaces) return found;
  let entries: string[] = [];
  try {
    entries = readdirSync(join(root, "packages"));
  } catch {
    return found;
  }
  for (const entry of entries) {
    const dir = join(root, "packages", entry);
    try {
      const json: unknown = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      );
      if (isRecord(json) && typeof json.name === "string") {
        found.push({ name: json.name, dir });
      }
    } catch {
      // Not a package.
    }
  }
  return found;
}

/**
 * Makes a checkout resolve its own workspace packages when no `prepare`
 * command installs them: one symlink per package in the checkout's own
 * `node_modules`, so Bun stops walking up to the main clone's packages. It is
 * cheap (a few symlinks, no network) and never replaces an existing entry.
 * Returns the names it linked.
 */
export function linkWorkspacePackages(path: string): string[] {
  const linked: string[] = [];
  for (const { name, dir } of workspacePackages(path)) {
    const link = join(path, "node_modules", name);
    try {
      lstatSync(link);
      continue;
    } catch {
      // Absent: link it.
    }
    try {
      mkdirSync(join(link, ".."), { recursive: true });
      if (!existsSync(link)) {
        symlinkSync(relative(join(link, ".."), dir), link, "dir");
        linked.push(name);
      }
    } catch {
      // A package that cannot be linked resolves as it did before.
    }
  }
  return linked;
}
