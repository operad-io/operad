import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FilePluginStore,
  NOTIFIED_FACT,
  ensureHttpToken,
  openConfigLog,
  readConfig,
} from "@operad-io/engine";
import { waitForChange } from "@operad-io/engine/platform";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));
const pluginPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/presentation.ts", import.meta.url),
);

interface Home {
  readonly root: string;
  readonly home: string;
}

async function makeHome(command: string): Promise<Home> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
      http: { enabled: false },
      notify: { command },
    }),
  );
  return { root, home };
}

function seed(root: string, id: string, title: string): void {
  new FilePluginStore({ root: join(root, "store", "plugins") }).put(
    "item",
    id,
    { title, state: "new" },
    "seed",
  );
}

async function wait(home: string, object: string, waitId: string, prompt: string): Promise<void> {
  const log = openConfigLog(await readConfig(home));
  try {
    const info = await log.startRun("demo-flow", object);
    await log.append(info.runId, 0, [
      {
        kind: "waiting_for_person",
        payload: { waitId, step: "ask", prompt, choices: ["yes"], waitKind: "step", effectId: null },
        cause: "test",
      },
    ]);
  } finally {
    await log.close();
  }
}

/**
 * Resolves once `file` holds at least `count` lines. The directory watch is the
 * fast path; a look every 100 ms besides, because a watch can miss the event of
 * a file the other process created or wrote.
 */
async function waitForLines(
  file: string,
  count: number,
  keep: (line: string) => boolean = () => true,
  timeoutMs = 20_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "" && keep(line))
      : [];
    if (lines.length >= count) return lines;
    if (Date.now() > deadline) throw new Error(`${file} never reached ${count} lines`);
    await waitForChange(dirname(file), basename(file), 100);
  }
}

function startServe(home: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, "serve"],
    cwd: home,
    env: {
      ...(process.env as Record<string, string>),
      OPERAD_HOME: home,
      OPERAD_SERVE_INTERVAL_MS: "60",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Resolves once `count` notices are recorded as facts: only then is a stop clean. */
function waitForRecorded(root: string, count: number): Promise<string[]> {
  return waitForLines(
    join(root, "store", "global-facts.jsonl"),
    count,
    (line) => line.includes(`"${NOTIFIED_FACT}"`),
  );
}

async function stop(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  child.kill("SIGTERM");
  const [, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return errors;
}

describe("waiting for a line another process writes", () => {
  test("a watch that cannot see the directory is backed by the 100 ms look", async () => {
    const root = await tempRoot();
    const directory = join(root, "store");
    const file = join(directory, "global-facts.jsonl");
    // The directory does not exist when the wait starts, so there is nothing
    // to watch. The file appears before the fallback look; only that look can
    // find it.
    const waiting = waitForLines(file, 1, () => true, 2_000);
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, '{"kind":"notified"}\n');
    expect(await waiting).toEqual(['{"kind":"notified"}']);
  });
});

describe("operad serve notify", () => {
  test("runs the command once per wait with the four variables, not again after a restart, and never with the token", async () => {
    const { root, home } = await makeHome(
      `printf '%s|%s|%s|%s\\n' "$OPERAD_ID" "$OPERAD_TITLE" "$OPERAD_REASON" "$OPERAD_LINK" >> notices.txt; env > env.txt`,
    );
    const token = (await ensureHttpToken(home)).token;
    seed(root, "one", "First item");
    seed(root, "two", "Second item");
    await wait(home, "item:one", "ask:1", "Approve the first?");
    const notices = join(home, "notices.txt");

    const first = startServe(home);
    let lines: string[];
    try {
      await waitForRecorded(root, 1);
    } finally {
      await stop(first);
    }
    lines = await waitForLines(notices, 1);
    expect(lines).toEqual([
      "item:one|First item|Approve the first?|operad://objects/item%3Aone",
    ]);
    expect(readFileSync(join(home, "env.txt"), "utf8")).not.toContain(token);

    // After the restart the first wait stays quiet; a second wait is the barrier
    // that shows the new serve has already passed over the first.
    await wait(home, "item:two", "ask:1", "Approve the second?");
    const second = startServe(home);
    try {
      await waitForRecorded(root, 2);
    } finally {
      await stop(second);
    }
    lines = await waitForLines(notices, 2);
    expect(lines).toEqual([
      "item:one|First item|Approve the first?|operad://objects/item%3Aone",
      "item:two|Second item|Approve the second?|operad://objects/item%3Atwo",
    ]);

    const log = openConfigLog(await readConfig(home));
    try {
      const kinds: string[] = [];
      for await (const fact of log.readGlobal()) kinds.push(fact.kind);
      expect(kinds.filter((kind) => kind === NOTIFIED_FACT)).toHaveLength(2);
    } finally {
      await log.close();
    }
  });

  test("a failing command is logged with its exit code and stderr, and run once", async () => {
    const { root, home } = await makeHome(`echo ran >> runs.txt; echo oops >&2; exit 4`);
    seed(root, "one", "First item");
    seed(root, "two", "Second item");
    await wait(home, "item:one", "ask:1", "Approve?");
    await wait(home, "item:two", "ask:1", "Approve?");
    const child = startServe(home);
    let errors: string;
    try {
      await waitForRecorded(root, 2);
    } finally {
      errors = await stop(child);
    }
    expect(errors).toContain("exited 4");
    expect(errors).toContain("oops");
    expect(readFileSync(join(home, "runs.txt"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });
});
