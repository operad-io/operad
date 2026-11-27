/**
 * The hand-over of a secret answer to the step that asked (ADR 0008 D8). The
 * process that takes the answer is usually not the one that runs the step, so
 * the text goes through a 0600 file under the home's `secrets` directory. The
 * step removes the file when it reads it. Each answer writes a file of its own,
 * named at random, so a refused second answer never touches the first one's.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../platform/index.ts";
import { secretsDirectory } from "../plugin/secrets.ts";
import type { AskQuestionAnswer } from "../plugin/types.ts";
import { isMissingFile, isRecord } from "../util.ts";

/**
 * A file older than this was left by a process that died: a waiting step reads
 * its answer within moments.
 */
export const SECRET_ANSWER_STALE_MS = 10 * 60 * 1000;

const REF = /^[0-9a-f-]{36}$/;

function answersDirectory(home: string): string {
  return join(secretsDirectory(home), "answers");
}

/** The start of every file name of one question. */
function prefixOf(runId: string, waitId: string): string {
  return `${createHash("sha256").update(JSON.stringify([runId, waitId])).digest("hex")}.`;
}

function pathOf(home: string, runId: string, waitId: string, ref: string): string {
  return join(answersDirectory(home), `${prefixOf(runId, waitId)}${ref}.json`);
}

async function names(home: string): Promise<readonly string[]> {
  try {
    return await readdir(answersDirectory(home));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

/** Removes the files no step came for. */
export async function sweepSecretAnswers(home: string, now: number = Date.now()): Promise<void> {
  for (const name of await names(home)) {
    const path = join(answersDirectory(home), name);
    try {
      if (now - (await stat(path)).mtimeMs > SECRET_ANSWER_STALE_MS) await rm(path, { force: true });
    } catch (error) {
      // The step that asked took it meanwhile.
      if (!isMissingFile(error)) throw error;
    }
  }
}

/** Writes one answer for the step; returns the name the claim records. */
export async function putSecretAnswers(
  home: string,
  runId: string,
  waitId: string,
  answers: readonly AskQuestionAnswer[],
): Promise<string> {
  for (const directory of [secretsDirectory(home), answersDirectory(home)]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  await sweepSecretAnswers(home);
  const ref = randomUUID();
  await writeJsonAtomic(pathOf(home, runId, waitId, ref), { answers }, { mode: 0o600 });
  return ref;
}

/** Reads an answer and removes it; undefined when it is no longer there. */
export async function takeSecretAnswers(
  home: string,
  runId: string,
  waitId: string,
  ref: string,
): Promise<readonly AskQuestionAnswer[] | undefined> {
  if (!REF.test(ref)) return undefined;
  const path = pathOf(home, runId, waitId, ref);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    // The error of a read names the file, never its text.
    throw error;
  }
  await rm(path, { force: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A parser's message can quote the text, so it is not passed on.
    throw new Error("the secret answer cannot be read");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.answers)) return undefined;
  return parsed.answers as unknown as readonly AskQuestionAnswer[];
}

/** Removes one answer that no step will read. */
export async function dropSecretAnswer(
  home: string,
  runId: string,
  waitId: string,
  ref: string,
): Promise<void> {
  await rm(pathOf(home, runId, waitId, ref), { force: true });
}

/** Removes every answer of a question whose step stopped waiting. */
export async function dropSecretAnswers(home: string, runId: string, waitId: string): Promise<void> {
  const prefix = prefixOf(runId, waitId);
  for (const name of await names(home)) {
    if (name.startsWith(prefix)) await rm(join(answersDirectory(home), name), { force: true });
  }
}
