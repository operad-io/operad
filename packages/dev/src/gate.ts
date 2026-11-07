/**
 * The gate: verify a task's commit with the repository's commands, review its
 * diff with a harness step, and turn a failure into another rework pass. Both
 * steps run git here; the kernel never runs a command or a harness itself.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  messageOf,
  type PluginStepResult,
  type StepContext,
  type StepRunOptions,
} from "@operad-io/engine";
import {
  appendRework,
  isRecord,
  type ReviewFinding,
  type ReviewRecord,
  type ReviewResult,
  type ReviewRunRecord,
  type ReviewRunReason,
  type ReviewRunRole,
  type ReworkRecord,
  type TaskAttempt,
  type TaskData,
  type VerifyRecord,
  type VerifyResult,
} from "./model.ts";
import {
  assertInsideRepository,
  type DevSettings,
  type FixLevel,
  type ReviewerFallback,
  type ReviewerSettings,
} from "./settings.ts";
import {
  briefText,
  cancelledStep,
  claimAllows,
  git,
  headOf,
  isRegistered,
  saveTaskGuarded,
  taskContext,
  workBranch,
  type TaskContext,
} from "./steps.ts";
import { REVIEW_WAIT_CHUNK_MS } from "./timeouts.ts";

/** The gate worktree of a task: `<worktreeRoot>/<task id>-gate`. */
export function gateWorktreePath(
  repositoryPath: string,
  settings: DevSettings,
  taskId: string,
): string {
  const path = resolve(repositoryPath, settings.worktreeRoot, `${taskId}-gate`);
  assertInsideRepository(repositoryPath, path, "worktreeRoot");
  return path;
}

interface GitZ {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function gitZ(
  cwd: string,
  args: readonly string[],
  input?: string,
): GitZ {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString(),
    err: result.stderr.toString().trim(),
  };
}

/** The commit a task's branch points at, local first and then the remote. */
export function branchHead(
  repositoryPath: string,
  settings: DevSettings,
  taskId: string,
): string | undefined {
  const branch = workBranch(taskId);
  const local = git(repositoryPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${branch}^{commit}`,
  ]);
  if (local.ok && local.out.length > 0) return local.out;
  const remote = git(repositoryPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${settings.remote}/${branch}^{commit}`,
  ]);
  return remote.ok && remote.out.length > 0 ? remote.out : undefined;
}

/** The commit the task branched from: the merge base of main and the commit. */
function mergeBase(
  repositoryPath: string,
  settings: DevSettings,
  sha: string,
): string | undefined {
  const main = `${settings.remote}/${settings.mainBranch}`;
  const result = git(repositoryPath, ["merge-base", main, sha]);
  return result.ok && result.out.length > 0 ? result.out : undefined;
}

/** Removes whatever is at the gate path and checks a commit out detached. */
export function recreateGateWorktree(
  repositoryPath: string,
  path: string,
  sha: string,
): string | undefined {
  if (existsSync(path)) {
    if (isRegistered(repositoryPath, path)) {
      const removed = git(repositoryPath, [
        "worktree",
        "remove",
        "--force",
        path,
      ]);
      if (!removed.ok) {
        rmSync(path, { recursive: true, force: true });
        git(repositoryPath, ["worktree", "prune"]);
      }
    } else {
      rmSync(path, { recursive: true, force: true });
    }
  }
  git(repositoryPath, ["worktree", "prune"]);
  mkdirSync(dirname(path), { recursive: true });
  const add = git(repositoryPath, [
    "worktree",
    "add",
    "--detach",
    path,
    sha,
  ]);
  if (add.ok) return undefined;
  return `cannot check out ${sha} at ${path}: ${add.err || add.out}`;
}

function stepOptions(
  ctx: StepContext,
  cwd: string,
): StepRunOptions {
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

function attemptOf(ctx: StepContext, task: TaskData): TaskAttempt {
  return (
    task.attempt ?? {
      number: Math.max(task.attempts, 0) + 1,
      run: ctx.runId,
    }
  );
}

function verifyData(record: VerifyRecord, extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...record, ...extra };
}

function recordVerify(
  attempt: TaskAttempt,
  record: VerifyRecord,
): TaskAttempt {
  return { ...attempt, verify: record };
}

/** Step `dev/verify`: run the gate commands on the task's branch head. */
export async function runVerify(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const task = context.task;
  const attempt = attemptOf(ctx, task);
  const previous = attempt.verify;
  // A replay of the same run reads the result it already recorded; the branch
  // may have moved since, and the verified sha must be the one review sees.
  if (
    previous !== undefined &&
    previous !== null &&
    previous.run === ctx.runId
  ) {
    return {
      result: previous.result,
      data: verifyData(previous, {
        attempt: attempt.number,
        verified: attempt.verified ?? null,
        replayed: true,
      }),
    };
  }

  git(context.repository.path, [
    "fetch",
    "--prune",
    context.settings.remote,
  ]);
  const sha = branchHead(
    context.repository.path,
    context.settings,
    context.taskId,
  );
  const path = gateWorktreePath(
    context.repository.path,
    context.settings,
    context.taskId,
  );

  const failed = async (
    message: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<PluginStepResult> => {
    const record: VerifyRecord = {
      result: "fail",
      run: ctx.runId,
      message,
    };
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...task,
        phase: "review",
        run: ctx.runId,
        attempts: Math.max(task.attempts, attempt.number),
        attempt: recordVerify(
          { ...attempt, run: ctx.runId, verified: sha ?? null },
          record,
        ),
      },
      "dev:verify",
    );
    if (!written) return cancelledStep();
    return {
      result: "fail",
      data: verifyData(record, {
        attempt: attempt.number,
        verified: sha ?? null,
        worktree: path,
        ...extra,
      }),
    };
  };

  if (sha === undefined) {
    return failed(
      `no branch "${workBranch(context.taskId)}" or "${context.settings.remote}/${workBranch(context.taskId)}" to verify`,
    );
  }
  const prepared = recreateGateWorktree(context.repository.path, path, sha);
  if (prepared !== undefined) return failed(prepared, { sha, verified: sha });

  const commands = context.settings.gate.commands;
  const runStep = ctx.runStep;
  if (runStep === undefined) {
    return failed(
      "the kernel did not offer a way to run the gate commands",
      { sha, verified: sha },
    );
  }

  let outcome: PluginStepResult | undefined;
  let hostError: string | undefined;
  try {
    outcome = await runStep(
      "shell/check",
      {
        lines: commands,
        cwd: path,
        timeoutSecs: context.settings.gate.commandTimeoutSecs,
      },
      stepOptions(ctx, path),
    );
  } catch (error) {
    hostError = messageOf(error);
  }

  const outcomeData =
    outcome !== undefined && isRecord(outcome.data) ? outcome.data : {};
  const result: VerifyResult =
    hostError === undefined && outcome?.result === "pass" ? "pass" : "fail";
  const command =
    typeof outcomeData.line === "string" ? outcomeData.line : undefined;
  const log = typeof outcomeData.log === "string" ? outcomeData.log : undefined;
  const message =
    hostError ??
    (typeof outcomeData.message === "string" ? outcomeData.message : undefined) ??
    (result === "fail"
      ? `the gate commands failed (${outcome?.result ?? "unknown"})`
      : undefined);
  const lineNumber =
    typeof outcomeData.lineNumber === "number"
      ? outcomeData.lineNumber
      : undefined;

  const record: VerifyRecord = {
    result,
    run: ctx.runId,
    ...(command === undefined ? {} : { command }),
    ...(log === undefined ? {} : { log }),
    ...(message === undefined ? {} : { message }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
  };
  const nextAttempt: TaskAttempt = {
    ...recordVerify(attempt, record),
    run: ctx.runId,
    verified: sha,
  };
  const written = await saveTaskGuarded(
    ctx,
    context.taskKey,
    {
      ...task,
      phase: "review",
      run: ctx.runId,
      attempts: Math.max(task.attempts, attempt.number),
      attempt: nextAttempt,
    },
    "dev:verify",
  );
  if (!written) return cancelledStep();
  return {
    result,
    data: verifyData(record, {
      attempt: attempt.number,
      verified: sha,
      worktree: path,
      ...(outcomeData.tail === undefined ? {} : { tail: outcomeData.tail }),
    }),
  };
}

interface FileDiff {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** The patch as text, used for its size and its content when included. */
  readonly patch: string;
  readonly bytes: number;
  /** Why the file is left out of the prompt, or undefined when it is in it. */
  readonly leftOut: string | undefined;
  readonly binary: boolean;
}

interface Attributes {
  readonly vendored: boolean;
  readonly generated: boolean;
  readonly diffable: boolean;
  readonly binary: boolean;
}

const NO_ATTRIBUTES: Attributes = {
  vendored: false,
  generated: false,
  diffable: true,
  binary: false,
};

/** Reads the attributes that decide whether a file belongs in a review diff. */
function attributesOf(
  repositoryPath: string,
  paths: readonly string[],
): ReadonlyMap<string, Attributes> {
  const map = new Map<string, Attributes>();
  if (paths.length === 0) return map;
  const result = gitZ(
    repositoryPath,
    [
      "check-attr",
      "--stdin",
      "-z",
      "linguist-vendored",
      "linguist-generated",
      "diff",
      "binary",
    ],
    `${paths.join("\0")}\0`,
  );
  if (!result.ok) return map;
  const parts = result.out.split("\0");
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const path = parts[index] ?? "";
    const attribute = parts[index + 1] ?? "";
    const value = parts[index + 2] ?? "";
    const current = map.get(path) ?? NO_ATTRIBUTES;
    const set = value !== "unspecified" && value !== "unset";
    if (attribute === "linguist-vendored") {
      map.set(path, { ...current, vendored: set });
    } else if (attribute === "linguist-generated") {
      map.set(path, { ...current, generated: set });
    } else if (attribute === "diff") {
      map.set(path, {
        ...current,
        diffable: value !== "unset" && value !== "binary",
      });
    } else if (attribute === "binary") {
      map.set(path, { ...current, binary: set });
    }
  }
  return map;
}

/** The changed files with line counts and their own patch. */
function diffsOf(
  repositoryPath: string,
  base: string,
  sha: string,
): readonly FileDiff[] {
  const numstat = gitZ(repositoryPath, [
    "diff",
    "--numstat",
    "--no-renames",
    "-z",
    base,
    sha,
  ]);
  if (!numstat.ok) return [];
  const files: FileDiff[] = [];
  for (const record of numstat.out.split("\0")) {
    if (record.length === 0) continue;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const addedText = record.slice(0, first);
    const removedText = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    if (path.length === 0) continue;
    const binary = addedText === "-" || removedText === "-";
    const patch = binary
      ? ""
      : git(repositoryPath, [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-renames",
          base,
          sha,
          "--",
          path,
        ]).out;
    files.push({
      path,
      added: binary ? 0 : Number(addedText) || 0,
      removed: binary ? 0 : Number(removedText) || 0,
      patch,
      bytes: Buffer.byteLength(patch, "utf8"),
      leftOut: undefined,
      binary,
    });
  }
  return files;
}

interface PreparedDiff {
  readonly files: readonly FileDiff[];
  /** The files that go into the prompt, in path order. */
  readonly included: readonly FileDiff[];
  /** The files left out, with the reason, in path order. */
  readonly leftOut: readonly FileDiff[];
  /** The bytes of every diff the review could carry, not only the included ones. */
  readonly bytes: number;
  /** The bytes of the diff text that goes into the prompt. */
  readonly includedBytes: number;
}

function reasonFor(
  attributes: Attributes,
  diff: FileDiff,
  maxFileDiffBytes: number,
): string | undefined {
  if (attributes.vendored) return "vendored";
  if (attributes.generated) return "generated";
  if (attributes.binary || diff.binary) return "binary";
  if (!attributes.diffable) return "not diffable";
  if (diff.bytes > maxFileDiffBytes) return "too large";
  return undefined;
}

/** True when a file is left out because of an attribute, not its size. */
function excludedByAttribute(
  attributes: Attributes,
  diff: FileDiff,
): boolean {
  return (
    attributes.vendored ||
    attributes.generated ||
    attributes.binary ||
    diff.binary ||
    !attributes.diffable
  );
}

/**
 * Prepares the diff for a review prompt. Vendored and non-diffable files never
 * enter the prompt, and neither does a file whose own diff is over the limit;
 * every one of them is listed so the reviewer knows it exists.
 */
export function normalizePath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function prepareDiff(
  repositoryPath: string,
  base: string,
  sha: string,
  reviewer: ReviewerSettings,
  attributesCwd: string = repositoryPath,
): PreparedDiff {
  const diffs = diffsOf(repositoryPath, base, sha);
  const attributes = attributesOf(
    attributesCwd,
    diffs.map((diff) => diff.path),
  );
  const files = diffs.map((diff) => {
    const reason = reasonFor(
      attributes.get(diff.path) ?? NO_ATTRIBUTES,
      diff,
      reviewer.maxFileDiffBytes,
    );
    return { ...diff, leftOut: reason };
  });
  // The size check counts every file that is not vendored or not diffable:
  // leaving a huge real-code file out of the prompt must not hide it.
  const bytes = files
    .filter(
      (file) =>
        !excludedByAttribute(
          attributes.get(file.path) ?? NO_ATTRIBUTES,
          file,
        ),
    )
    .reduce((sum, file) => sum + file.bytes, 0);
  const included = files.filter((file) => file.leftOut === undefined);
  const leftOut = files.filter((file) => file.leftOut !== undefined);
  return {
    files,
    included,
    leftOut,
    bytes,
    includedBytes: included.reduce((sum, file) => sum + file.bytes, 0),
  };
}

/** The line that tells the reviewer a file was left out and why. */
export function leftOutLine(file: FileDiff): string {
  return `- ${file.path} (+${file.added}/-${file.removed}) — ${file.leftOut ?? "left out"}`;
}

function severityRank(severity: string): number {
  if (severity === "critical") return 3;
  if (severity === "major") return 2;
  if (severity === "minor") return 1;
  return 0;
}

function levelRank(level: FixLevel): number {
  return severityRank(level);
}

function atOrAbove(severity: string, level: FixLevel): boolean {
  return severityRank(severity) >= levelRank(level);
}

interface FindingShape {
  readonly file: string;
  readonly line: number;
  readonly severity: string;
  readonly summary: string;
  readonly trigger: string;
}

function parseFinding(value: unknown): FindingShape | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.file !== "string" || value.file.length === 0) return undefined;
  const severity = value.severity;
  if (
    severity !== "critical" &&
    severity !== "major" &&
    severity !== "minor"
  ) {
    return undefined;
  }
  // Every field the prompt asks for is required: a finding without them is a
  // malformed report, and the step retries instead of recording a blank one.
  const line = value.line;
  if (typeof line !== "number" || !Number.isFinite(line)) return undefined;
  if (typeof value.summary !== "string") return undefined;
  if (typeof value.trigger !== "string") return undefined;
  return {
    file: value.file,
    line,
    severity,
    summary: value.summary,
    trigger: value.trigger,
  };
}

interface Report {
  readonly findings: readonly FindingShape[];
  readonly verified: readonly string[];
}

function parseReport(text: string): Report | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.findings)) return undefined;
  if (!Array.isArray(value.verified)) return undefined;
  if (!value.verified.every((item) => typeof item === "string")) return undefined;
  const findings: FindingShape[] = [];
  for (const item of value.findings) {
    const finding = parseFinding(item);
    if (finding === undefined) return undefined;
    findings.push(finding);
  }
  return {
    findings,
    verified: value.verified as readonly string[],
  };
}

function reviewPrompt(
  task: TaskData,
  sha: string,
  base: string,
  prepared: PreparedDiff,
  resultPath: string,
): string {
  const pieces: string[] = [
    `Review the changes of task ${task.title}.`,
    "## Brief",
    briefText(task).trim(),
  ];
  if (prepared.included.length === 0) {
    pieces.push("## Diff", "The change has no diff to review.");
  } else {
    pieces.push(
      "## Diff",
      `The diff from the merge base ${base} to the verified commit ${sha}:`,
      prepared.included.map((file) => file.patch).join(""),
    );
  }
  if (prepared.leftOut.length > 0) {
    pieces.push(
      "## Files left out of the diff",
      "These files changed but their content is not in the diff:",
      prepared.leftOut.map(leftOutLine).join("\n"),
    );
  }
  pieces.push(
    "## What to write",
    [
      `Write a JSON object to ${resultPath}. The file must contain exactly:`,
      '{ "findings": [{ "file": "<path>", "line": <number>, "severity": "critical|major|minor", "summary": "<one line>", "trigger": "<what causes it>" }], "verified": ["<what you checked>"] }',
      "A finding on a file the change did not touch is pre-existing; say so in its summary.",
      "Write only the JSON file. Do not change the worktree.",
    ].join("\n"),
  );
  return pieces.join("\n\n");
}

/** What one call to a reviewer harness step produced. */
interface ReviewerCall {
  readonly outcome: "report" | "invalid" | "unavailable" | "timed_out" | "failed";
  readonly report?: Report | undefined;
  readonly message: string;
}

/** The largest review report the gate reads; anything bigger is not a report. */
const MAX_REPORT_BYTES = 1_000_000;

interface ReportRead {
  readonly text?: string;
  readonly message?: string;
}

/**
 * Reads a reviewer report without trusting the path. The reviewer owns the
 * gate worktree and can leave a FIFO or a link at the report path; the file is
 * opened non-blocking without following a link, and the descriptor must still
 * be a bounded regular file before anything is read.
 */
function readReport(resultPath: string): ReportRead {
  let details;
  try {
    details = lstatSync(resultPath);
  } catch {
    return { message: `the reviewer wrote no report at ${resultPath}` };
  }
  if (!details.isFile()) {
    return {
      message: `the review report at ${resultPath} is not a regular file`,
    };
  }
  if (details.size > MAX_REPORT_BYTES) {
    return {
      message: `the review report at ${resultPath} is over ${MAX_REPORT_BYTES} bytes`,
    };
  }
  let fd: number;
  try {
    fd = openSync(
      resultPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    return { message: `cannot read ${resultPath}: ${String(error)}` };
  }
  try {
    // The path may have changed between `lstat` and `open`; the descriptor is
    // what is read, so a swap to a FIFO is caught here and cannot block.
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      return {
        message: `the review report at ${resultPath} is not a regular file`,
      };
    }
    if (opened.size > MAX_REPORT_BYTES) {
      return {
        message: `the review report at ${resultPath} is over ${MAX_REPORT_BYTES} bytes`,
      };
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      let count: number;
      try {
        count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      } catch (error) {
        return { message: `cannot read ${resultPath}: ${String(error)}` };
      }
      if (count === 0) break;
      offset += count;
    }
    return { text: buffer.subarray(0, offset).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** The model a harness step names, or its step name when it names none. */
function modelOf(use: string, args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--model") {
      const value = args[index + 1];
      return typeof value === "string" && value.length > 0 ? value : use;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      return value.length > 0 ? value : use;
    }
  }
  return use;
}

/** The `kind` a harness reports for a model error, in its usual shapes. */
function modelErrorKind(data: Record<string, unknown>): string | undefined {
  for (const key of ["modelError", "model_error", "error", "failure"]) {
    const value = data[key];
    if (typeof value === "string") return value;
    if (isRecord(value) && typeof value.kind === "string") return value.kind;
    if (isRecord(value)) {
      const nested = value.kind;
      if (typeof nested === "string") return nested;
    }
  }
  if (typeof data.kind === "string") return data.kind;
  return undefined;
}

/** True when a value carries an HTTP 429 or its phrase. */
function contains429(value: unknown, depth = 0): boolean {
  if (typeof value === "number") return value === 429;
  if (typeof value === "string") {
    return /\b429\b/.test(value) || /too many requests/i.test(value);
  }
  if (depth >= 3) return false;
  if (Array.isArray(value)) {
    return value.some((item) => contains429(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).some((item) => contains429(item, depth + 1));
  }
  return false;
}

/** Why a reviewer run failed: unavailable, timed out, or anything else. */
function failureOutcome(
  data: Record<string, unknown>,
  message: string,
): "unavailable" | "timed_out" | "failed" {
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  if (reason === "wall" || reason === "stall" || reason === "timeout") {
    return "timed_out";
  }
  if (reason === "unavailable" || reason === "usage_limit") {
    return "unavailable";
  }
  const kind = modelErrorKind(data);
  if (kind === "unavailable" || kind === "usage_limit") return "unavailable";
  const status = data.statusCode ?? data.status ?? data.httpStatus;
  if (status === 429) return "unavailable";
  if (contains429(message) || contains429(data)) return "unavailable";
  return "failed";
}

async function callReviewer(
  ctx: StepContext,
  context: TaskContext,
  gatePath: string,
  prompt: string,
  resultPath: string,
  reviewer: { readonly use: string; readonly args: readonly string[] },
): Promise<ReviewerCall> {
  const runStep = ctx.runStep;
  if (runStep === undefined) {
    return {
      outcome: "failed",
      message: "the kernel did not offer a way to run the reviewer",
    };
  }
  const settings = context.settings.reviewer;
  try {
    rmSync(resultPath, { force: true });
  } catch {
    // A result file that cannot be removed is read only if it is fresh enough.
  }
  let outcome: PluginStepResult | undefined;
  try {
    outcome = await runStep(
      reviewer.use,
      {
        prompt,
        cwd: gatePath,
        args: reviewer.args,
        wallTimeSecs: settings.timeoutSecs,
        ...(settings.stallSecs === undefined
          ? {}
          : { stallSecs: settings.stallSecs }),
        resultPath,
      },
      stepOptions(ctx, gatePath),
    );
  } catch (error) {
    const message = messageOf(error);
    return { outcome: failureOutcome({}, message), message };
  }
  if (outcome.result !== "done") {
    const data = isRecord(outcome.data) ? outcome.data : {};
    const message =
      typeof data.message === "string"
        ? data.message
        : `the reviewer ended "${outcome.result}"`;
    return { outcome: failureOutcome(data, message), message };
  }
  const read = readReport(resultPath);
  if (read.text === undefined) {
    return {
      outcome: "invalid",
      message: read.message ?? `cannot read ${resultPath}`,
    };
  }
  const report = parseReport(read.text);
  if (report === undefined) {
    return {
      outcome: "invalid",
      message: `the review report at ${resultPath} is not the expected JSON`,
    };
  }
  return { outcome: "report", report, message: "" };
}

function reviewData(
  result: string,
  sha: string,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { result, sha, ...extra };
}

/** The step result a finished review record stands for. */
function stepResultOf(record: ReviewRecord): string {
  if (record.decision === "passed") return "pass";
  if (record.decision === "findings") return "fail";
  if (record.decision === "unavailable") return "unavailable";
  if (record.decision === "timed_out") return "timed_out";
  if (record.result === "pass" || record.result === "passed") return "pass";
  if (record.result === "fail" || record.result === "findings") return "fail";
  return "failed";
}

/** A review step that runs again after a crash reads the round it recorded. */
function replayReview(
  record: ReviewRecord,
  attempt: TaskAttempt,
): PluginStepResult {
  const stepResult = stepResultOf(record);
  return {
    result: stepResult,
    data: reviewData(stepResult, record.sha ?? "", {
      attempt: attempt.number,
      ...(record.decision === undefined || record.decision === null
        ? {}
        : { decision: record.decision }),
      ...(record.round === undefined || record.round === null
        ? {}
        : { round: record.round }),
      ...(record.model === undefined || record.model === null
        ? {}
        : { model: record.model }),
      ...(record.retryAt === undefined || record.retryAt === null
        ? {}
        : { retryAt: record.retryAt }),
      ...(record.runs === undefined ? {} : { runs: record.runs }),
      ...(record.findings === undefined ? {} : { findings: record.findings }),
      ...(record.verified === undefined ? {} : { verified: record.verified }),
      ...(record.message === undefined || record.message === null
        ? {}
        : { message: record.message }),
      replayed: true,
    }),
  };
}

interface ReviewAction {
  readonly role: ReviewRunRole;
  readonly reason: ReviewRunReason;
}

type ReviewNext =
  | ReviewAction
  | "done"
  | "wait-unavailable"
  | "wait-timed-out"
  | "failed";

/**
 * What the next run of a review round is. A report ends the round; an
 * unavailable primary goes to the fallback once; a timeout is retried once on
 * the same model; an invalid report is retried once. Every other state ends
 * the round for a person or for a wait.
 */
function nextReviewAction(
  runs: readonly ReviewRunRecord[],
  fallback: ReviewerFallback | undefined,
): ReviewNext {
  const last = runs[runs.length - 1];
  if (last === undefined) return { role: "primary", reason: "initial" };
  switch (last.outcome) {
    case "report":
      return "done";
    case "unavailable":
      // A round uses its fallback exactly once, even when it runs again after
      // `retryAt`: a later primary failure waits instead of trying it again.
      if (
        last.role === "primary" &&
        fallback !== undefined &&
        !runs.some((run) => run.role === "fallback")
      ) {
        return { role: "fallback", reason: "fallback" };
      }
      return "wait-unavailable";
    case "timed_out": {
      const before = runs[runs.length - 2];
      if (
        before !== undefined &&
        before.outcome === "timed_out" &&
        before.role === last.role
      ) {
        return "wait-timed-out";
      }
      return { role: last.role, reason: "retry" };
    }
    case "invalid": {
      const before = runs[runs.length - 2];
      if (
        before !== undefined &&
        before.outcome === "invalid" &&
        before.role === last.role
      ) {
        return "failed";
      }
      return { role: last.role, reason: "retry" };
    }
    case "failed":
      return "failed";
  }
}

/** One run in words a person can read. */
function runPhrase(run: ReviewRunRecord): string {
  const who = run.role === "fallback" ? `fallback ${run.model}` : run.model;
  switch (run.outcome) {
    case "report":
      return `${who} reviewed`;
    case "unavailable":
      return `${who} was unavailable${run.message === undefined || run.message === null ? "" : ` (${run.message})`}`;
    case "timed_out":
      return `${who} timed out`;
    case "invalid":
      return `${who} wrote an invalid report`;
    case "failed":
      return `${who} failed${run.message === undefined || run.message === null ? "" : ` (${run.message})`}`;
  }
}

/** Why a round ended the way it did, as the history line shows it. */
function reviewMessage(
  decision: "passed" | "findings" | "unavailable" | "timed_out",
  runs: readonly ReviewRunRecord[],
  retryAt?: number,
): string {
  if (decision === "timed_out") return "review timed out twice";
  const parts = runs.map(runPhrase);
  if (decision === "unavailable" && retryAt !== undefined) {
    parts.push(`it runs again at ${new Date(retryAt).toISOString()}`);
  }
  return parts.join("; ");
}

/** Test-only hooks: a child process crashes at a named point in a review. */
export const reviewTestHooks: {
  now?: (() => number) | undefined;
  /** Waits instead of the real timer, so a test can move the clock. */
  wait?:
    | ((ms: number, signal: AbortSignal | undefined) => Promise<boolean>)
    | undefined;
  beforeRun?:
    | ((run: { readonly role: ReviewRunRole; readonly reason: ReviewRunReason }) => void)
    | undefined;
  afterRunSaved?: ((run: ReviewRunRecord) => void) | undefined;
} = {};

/** Step `dev/review`: have the reviewer read the verified commit's diff. */
export async function runReview(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const task = context.task;
  const attempt = attemptOf(ctx, task);
  const reviews =
    typeof attempt.reviews === "number" ? attempt.reviews : 0;
  const round = reviews + 1;
  const now = reviewTestHooks.now?.() ?? Date.now();
  const previous = attempt.review;

  // A record without a decision came from before review rounds existed; a
  // record with one is read back when the same round already ended.
  if (
    previous !== undefined &&
    previous !== null &&
    previous.decision === undefined &&
    previous.run === ctx.runId
  ) {
    return replayReview(previous, attempt);
  }
  if (previous !== undefined && previous !== null) {
    const finished =
      previous.decision === "passed" ||
      previous.decision === "findings" ||
      previous.decision === "timed_out";
    if (finished && (previous.round === round || previous.run === ctx.runId)) {
      return replayReview(previous, attempt);
    }
    if (previous.round === round && previous.decision === "unavailable") {
      const retryAt =
        typeof previous.retryAt === "number" ? previous.retryAt : 0;
      // Wait until the recorded time; a recovered step asks no model again.
      if (now < retryAt) return replayReview(previous, attempt);
    }
  }

  const sha = attempt.verified;
  let current: TaskAttempt = attempt;
  const finish = async (
    record: ReviewRecord,
    stepResult: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<PluginStepResult> => {
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...task,
        // A findings review continues to the rework step; every other ending
        // is a wait, either for a person or for the next review time.
        phase:
          record.decision === "findings" || record.result === "fail"
            ? "review"
            : "waiting",
        run: ctx.runId,
        attempts: Math.max(task.attempts, attempt.number),
        attempt: {
          ...current,
          run: ctx.runId,
          review: record,
          // An unavailable round is not finished: the same round runs again.
          reviews: record.decision === "unavailable" ? round - 1 : round,
        },
        ...(record.decision === "passed" ? { reworkStreak: 0 } : {}),
        retryAt:
          record.decision === "unavailable" && typeof record.retryAt === "number"
            ? record.retryAt
            : null,
      },
      "dev:review",
    );
    if (!written) return cancelledStep();
    return {
      result: stepResult,
      data: reviewData(stepResult, typeof sha === "string" ? sha : "", {
        attempt: attempt.number,
        round,
        ...(record.decision === undefined || record.decision === null
          ? {}
          : { decision: record.decision }),
        ...(record.model === undefined || record.model === null
          ? {}
          : { model: record.model }),
        ...(record.retryAt === undefined || record.retryAt === null
          ? {}
          : { retryAt: record.retryAt }),
        ...(record.runs === undefined ? {} : { runs: record.runs }),
        ...(record.findings === undefined ? {} : { findings: record.findings }),
        ...(record.verified === undefined ? {} : { verified: record.verified }),
        ...(record.message === undefined || record.message === null
          ? {}
          : { message: record.message }),
        ...extra,
      }),
    };
  };

  if (typeof sha !== "string" || sha.length === 0) {
    const record: ReviewRecord = {
      result: "failed",
      run: ctx.runId,
      round,
      reason: "no_verified_commit",
      message: "the verify step recorded no commit to review",
    };
    return finish(record, "failed", {
      reason: "no_verified_commit",
      message: record.message,
    });
  }

  git(context.repository.path, [
    "fetch",
    "--prune",
    context.settings.remote,
  ]);
  const base = mergeBase(context.repository.path, context.settings, sha);
  if (base === undefined) {
    const record: ReviewRecord = {
      result: "failed",
      run: ctx.runId,
      sha,
      round,
      reason: "no_merge_base",
      message: `cannot find the merge base of ${context.settings.remote}/${context.settings.mainBranch} and ${sha}`,
    };
    return finish(record, "failed", {
      reason: "no_merge_base",
      message: record.message,
    });
  }

  const path = gateWorktreePath(
    context.repository.path,
    context.settings,
    context.taskId,
  );
  const preparedWorktree = recreateGateWorktree(
    context.repository.path,
    path,
    sha,
  );
  if (preparedWorktree !== undefined) {
    const record: ReviewRecord = {
      result: "failed",
      run: ctx.runId,
      sha,
      round,
      reason: "worktree",
      message: preparedWorktree,
    };
    return finish(record, "failed", {
      reason: "worktree",
      message: preparedWorktree,
    });
  }

  // The gate worktree is at the verified commit, so its `.gitattributes` are
  // the ones that decide which changed files belong in the review diff.
  const prepared = prepareDiff(
    context.repository.path,
    base,
    sha,
    context.settings.reviewer,
    path,
  );

  if (prepared.bytes > context.settings.reviewer.maxDiffBytes) {
    const largest = [...prepared.files]
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 5)
      .map((file) => ({
        path: file.path,
        bytes: file.bytes,
        added: file.added,
        removed: file.removed,
      }));
    const message = `the diff is ${prepared.bytes} bytes, over the ${context.settings.reviewer.maxDiffBytes}-byte review limit`;
    await ctx.facts.append({
      type: "dev/review_too_large",
      ...(ctx.object === undefined
        ? {}
        : { object: { type: ctx.object.type, id: ctx.object.id } }),
      cause: "dev:review",
      data: {
        bytes: prepared.bytes,
        limit: context.settings.reviewer.maxDiffBytes,
        largest,
      },
    });
    const record: ReviewRecord = {
      result: "failed",
      run: ctx.runId,
      sha,
      round,
      reason: "diff_size",
      message,
    };
    return finish(record, "failed", {
      reason: "diff_size",
      message,
      bytes: prepared.bytes,
      limit: context.settings.reviewer.maxDiffBytes,
      largest,
    });
  }

  // Nothing changed between the base and the verified commit: there is no
  // review to ask a model for. A change made only of left-out files still runs
  // the reviewer: the list is what tells it those files exist.
  if (prepared.files.length === 0) {
    const record: ReviewRecord = {
      result: "passed",
      decision: "passed",
      run: ctx.runId,
      sha,
      round,
      runs: [],
      findings: [],
      verified: [],
      reason: "empty",
    };
    return finish(record, "pass", {
      reason: "empty",
      leftOut: prepared.leftOut.map(leftOutLine),
    });
  }

  const reviewDir = join(ctx.store.root, "dev", "reviews", ctx.runId);
  mkdirSync(reviewDir, { recursive: true });
  const resultPath = join(
    reviewDir,
    `${context.taskId}-attempt-${attempt.number}-review-${round}.json`,
  );
  const prompt = reviewPrompt(task, sha, base, prepared, resultPath);
  // Keep the prompt for a person to read without putting its bytes in a fact.
  const promptPath = join(
    reviewDir,
    `${context.taskId}-attempt-${attempt.number}-review-${round}.prompt.md`,
  );
  try {
    writeFileSync(promptPath, prompt);
  } catch {
    // A prompt file is a convenience; the reviewer still gets the text.
  }

  const settings = context.settings.reviewer;
  // The retry is the same review round, so it keeps the round's arguments:
  // the first review of an attempt still gets `firstArgs` on its retry.
  const useFirst = reviews === 0 && settings.firstArgs !== undefined;
  const roundArgs = useFirst ? settings.firstArgs ?? [] : settings.args;
  const changed = new Set(prepared.files.map((file) => file.path));
  // The runs of this round survive a crash; a fresh round starts with none.
  const runs: ReviewRunRecord[] = (attempt.reviewRuns ?? []).filter(
    (run) =>
      run.round === round &&
      (run.attempt === undefined ||
        run.attempt === null ||
        run.attempt === attempt.number),
  );
  // The recorded unavailable round holds the runs it had when it waited. Once
  // the time has passed, a primary run starts the round again; a run saved
  // after that point is resumed instead of started twice.
  const recordedRuns = (previous?.runs ?? []).filter(
    (run) =>
      run.round === round &&
      (run.attempt === undefined ||
        run.attempt === null ||
        run.attempt === attempt.number),
  );
  const retryAfterWait =
    previous !== undefined &&
    previous !== null &&
    previous.round === round &&
    previous.decision === "unavailable" &&
    now >= (typeof previous.retryAt === "number" ? previous.retryAt : 0) &&
    runs.length <= recordedRuns.length;
  let next: ReviewNext = retryAfterWait
    ? { role: "primary", reason: "retry" }
    : nextReviewAction(runs, settings.fallback);

  while (typeof next === "object") {
    const use =
      next.role === "fallback"
        ? settings.fallback?.use ?? settings.use
        : settings.use;
    const args =
      next.role === "fallback" ? settings.fallback?.args ?? [] : roundArgs;
    const model = modelOf(use, args);
    reviewTestHooks.beforeRun?.({ role: next.role, reason: next.reason });
    const call = await callReviewer(ctx, context, path, prompt, resultPath, {
      use,
      args,
    });
    let runRecord: ReviewRunRecord;
    if (call.outcome === "report" && call.report !== undefined) {
      const findings: ReviewFinding[] = call.report.findings.map((finding) => {
        const preExisting = !changed.has(normalizePath(finding.file));
        return {
          ...finding,
          ...(preExisting ? { preExisting: true, pre_existing: true } : {}),
        };
      });
      const counted = findings.filter(
        (finding) =>
          finding.preExisting !== true &&
          finding.pre_existing !== true &&
          atOrAbove(finding.severity, settings.fixLevel),
      ).length;
      runRecord = {
        attempt: attempt.number,
        round,
        role: next.role,
        use,
        args,
        model,
        reason: next.reason,
        outcome: "report",
        run: ctx.runId,
        findings,
        verified: call.report.verified,
        counted,
      };
    } else {
      runRecord = {
        attempt: attempt.number,
        round,
        role: next.role,
        use,
        args,
        model,
        reason: next.reason,
        outcome: call.outcome,
        run: ctx.runId,
        ...(call.message.length === 0 ? {} : { message: call.message }),
      };
    }
    runs.push(runRecord);
    current = {
      ...current,
      run: ctx.runId,
      reviewRuns: [...(current.reviewRuns ?? []), runRecord],
    };
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...task,
        run: ctx.runId,
        attempts: Math.max(task.attempts, attempt.number),
        attempt: current,
      },
      "dev:review",
    );
    if (!written) return cancelledStep();
    reviewTestHooks.afterRunSaved?.(runRecord);
    next = nextReviewAction(runs, settings.fallback);
  }

  const last = runs[runs.length - 1];
  if (next === "done" && last !== undefined) {
    const counted = last.counted ?? 0;
    const decision = counted === 0 ? "passed" : "findings";
    const stepResult = decision === "passed" ? "pass" : "fail";
    const result: ReviewResult = decision;
    const findings = last.findings ?? [];
    const countedFindings = findings.filter(
      (finding) =>
        finding.preExisting !== true &&
        finding.pre_existing !== true &&
        atOrAbove(finding.severity, settings.fixLevel),
    );
    const preExistingCount = findings.filter(
      (finding) =>
        finding.preExisting === true || finding.pre_existing === true,
    ).length;
    const findingsMessage = countedFindings
      .map(
        (finding) =>
          `${finding.file}:${finding.line} ${finding.severity}: ${finding.summary}`,
      )
      .join("; ");
    const message = [reviewMessage(decision, runs), findingsMessage]
      .filter((piece) => piece.length > 0)
      .join("; ");
    const record: ReviewRecord = {
      result,
      decision,
      run: ctx.runId,
      sha,
      round,
      model: last.model,
      runs,
      findings,
      verified: last.verified ?? [],
      log: resultPath,
      message,
      ...(decision === "findings" ? { reason: "findings" } : {}),
    };
    return finish(record, stepResult, {
      counted,
      preExisting: preExistingCount,
      pre_existing: preExistingCount,
      leftOut: prepared.leftOut.map(leftOutLine),
      log: resultPath,
      prompt: promptPath,
    });
  }

  if (next === "wait-unavailable") {
    const retryAt =
      (reviewTestHooks.now?.() ?? Date.now()) + settings.retrySecs * 1000;
    const message = reviewMessage("unavailable", runs, retryAt);
    const record: ReviewRecord = {
      result: "unavailable",
      decision: "unavailable",
      run: ctx.runId,
      sha,
      round,
      ...(last === undefined ? {} : { model: last.model }),
      runs,
      retryAt,
      message,
      reason: "unavailable",
      log: resultPath,
    };
    return finish(record, "unavailable", {
      reason: "unavailable",
      message,
      retryAt,
      log: resultPath,
      prompt: promptPath,
    });
  }

  if (next === "wait-timed-out") {
    const message = "review timed out twice";
    const record: ReviewRecord = {
      result: "timed_out",
      decision: "timed_out",
      run: ctx.runId,
      sha,
      round,
      ...(last === undefined ? {} : { model: last.model }),
      runs,
      message,
      reason: "timed_out",
      log: resultPath,
    };
    return finish(record, "timed_out", {
      reason: "timed_out",
      message,
      log: resultPath,
      prompt: promptPath,
    });
  }

  const message =
    last?.message === undefined || last.message === null
      ? reviewMessage("passed", runs)
      : [reviewMessage("passed", runs), last.message]
          .filter((piece) => piece.length > 0)
          .join("; ");
  const record: ReviewRecord = {
    result: "failed",
    run: ctx.runId,
    sha,
    round,
    ...(last === undefined ? {} : { model: last.model }),
    runs,
    message,
    reason: last?.outcome === "invalid" ? "invalid_json" : "review_failed",
    log: resultPath,
  };
  return finish(record, "failed", {
    reason: record.reason,
    message,
    log: resultPath,
    prompt: promptPath,
  });
}

/** Waits for a timer, or returns false when the run is cancelled. */
function waitFor(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Step `dev/review_due`: the wait a review enters when its model was
 * unavailable. It holds until the recorded `retryAt`, then lets the flow run
 * the same review round again without polling. A wait longer than one step run
 * is split into pieces below the step timeout.
 */
export async function runReviewDue(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) {
    return { result: "interrupted", data: { reason: "cancelled" } };
  }
  const review = context.task.attempt?.review;
  const retryAt =
    typeof context.task.retryAt === "number"
      ? context.task.retryAt
      : review !== undefined &&
          review !== null &&
          review.decision === "unavailable" &&
          typeof review.retryAt === "number"
        ? review.retryAt
        : undefined;
  const now = reviewTestHooks.now?.() ?? Date.now();
  if (retryAt === undefined || retryAt <= now) {
    return { result: "ready", data: { at: now } };
  }
  const waitMs = Math.min(retryAt - now, REVIEW_WAIT_CHUNK_MS);
  const wait = reviewTestHooks.wait ?? waitFor;
  const waited = await wait(waitMs, ctx.signal);
  if (!waited) return { result: "interrupted", data: { reason: "cancelled" } };
  const after = reviewTestHooks.now?.() ?? Date.now();
  if (after < retryAt) {
    // The piece ended early: the review step replays its unavailable round and
    // the flow enters this wait again for the next piece.
    return { result: "ready", data: { at: after, retryAt, waitedMs: waitMs } };
  }
  return {
    result: "ready",
    data: { at: retryAt, waitedMs: retryAt - now },
  };
}

function gateSource(task: TaskData): "verify" | "review" {
  const review = task.attempt?.review;
  if (review !== undefined && review !== null) {
    if (review.decision === "findings") return "review";
    if (
      review.result === "fail" ||
      review.result === "findings" ||
      review.result === "failed"
    ) {
      return "review";
    }
  }
  return "verify";
}

function findingText(finding: ReviewFinding): string {
  const place = `${finding.file}:${finding.line}`;
  const trigger =
    finding.trigger.length === 0 ? "" : ` — ${finding.trigger}`;
  return `- \`${place}\` ${finding.severity}: ${finding.summary}${trigger}`;
}

/** The instruction every rework section ends with. */
export const REWORK_INSTRUCTION =
  "Fix them and nothing else, append commits to the branch, and do not rebase.";

/** Step `dev/rework`: add the gate failure to the brief and decide who fixes it. */
export async function runRework(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const task = context.task;
  const attempt = attemptOf(ctx, task);
  // A rework that saved its task but lost its step result is replayed by the
  // runner; the section and the streak are already recorded, so reuse them.
  const previous = attempt.rework;
  if (
    previous !== undefined &&
    previous !== null &&
    previous.run === ctx.runId
  ) {
    return {
      result: previous.result,
      data: {
        attempt: attempt.number,
        source: previous.source,
        rework: previous.streak,
        streak: previous.streak,
        maxAutoRework: context.settings.maxAutoRework,
        brief: task.brief,
        replayed: true,
      },
    };
  }
  const source = gateSource(task);
  const pieces: string[] = [];

  if (source === "review") {
    const review = attempt?.review;
    const level = context.settings.reviewer.fixLevel;
    const findings = (review?.findings ?? []).filter(
      (finding) =>
        finding.preExisting !== true &&
        finding.pre_existing !== true &&
        atOrAbove(finding.severity, level),
    );
    if (findings.length > 0) {
      pieces.push(
        "The review failed with these findings:",
        findings.map(findingText).join("\n"),
      );
    } else {
      pieces.push(
        `The review failed: ${review?.message ?? "no review report was produced"}`,
      );
    }
  } else {
    const verify = attempt?.verify;
    if (
      typeof verify?.command === "string" &&
      verify.command.length > 0
    ) {
      pieces.push(
        `The verify command failed: \`${verify.command}\``,
        ...(typeof verify.log === "string" && verify.log.length > 0
          ? [`Log: \`${verify.log}\``]
          : []),
      );
    } else {
      pieces.push(
        `The gate failed: ${verify?.message ?? "verify recorded no reason"}`,
      );
    }
  }
  pieces.push(REWORK_INSTRUCTION);

  const withRework = appendRework(task, source, pieces.join("\n\n"));
  const streak = (task.reworkStreak ?? 0) + 1;
  const again = streak <= context.settings.maxAutoRework;
  const record: ReworkRecord = {
    run: ctx.runId,
    source,
    streak,
    result: again ? "again" : "ask",
  };
  const next: TaskData = {
    ...withRework,
    phase: again ? "review" : "waiting",
    run: ctx.runId,
    attempts: Math.max(task.attempts, attempt.number),
    reworkStreak: streak,
    attempt: { ...attempt, run: ctx.runId, rework: record },
  };
  if (!(await saveTaskGuarded(ctx, context.taskKey, next, "dev:rework"))) {
    return cancelledStep();
  }
  return {
    result: again ? "again" : "ask",
    data: {
      attempt: attempt.number,
      source,
      rework: streak,
      streak,
      maxAutoRework: context.settings.maxAutoRework,
      brief: next.brief,
    },
  };
}

/** The recorded verified commit of a task, for a caller that wants to look. */
export function verifiedCommitOf(task: TaskData): string | undefined {
  const sha = task.attempt?.verified;
  return typeof sha === "string" && sha.length > 0 ? sha : undefined;
}

/** The branch head a task's worktree is on, for tests and views. */
export function taskHead(path: string): string | undefined {
  return headOf(path);
}

/** The worktree path the gate uses, for tests and views. */
export function taskGatePath(context: TaskContext): string {
  return gateWorktreePath(
    context.repository.path,
    context.settings,
    context.taskId,
  );
}
