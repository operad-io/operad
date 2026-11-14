import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "./support.ts";
import {
  defaultAgentUse,
  DEFAULT_WORKER_USE,
  readDevSettings,
} from "../src/settings.ts";

afterAll(cleanupTempRoots);

function homeWith(
  root: string,
  plugins: Readonly<Record<string, { readonly module: string; readonly enabled?: boolean }>>,
): string {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ plugins }));
  return home;
}

async function underHome<T>(home: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.OPERAD_HOME;
  process.env.OPERAD_HOME = home;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.OPERAD_HOME;
    else process.env.OPERAD_HOME = previous;
  }
}

describe("the agent of a repository that names no worker", () => {
  test("is the first enabled harness in the fixed order", async () => {
    const root = await tempRoot();
    const home = homeWith(root, {
      shell: { module: "@operad-io/shell" },
      pi: { module: "@operad-io/harness-pi" },
      claude: { module: "@operad-io/harness-claude" },
      radian: { module: "@operad-io/harness-radian", enabled: false },
    });
    expect(defaultAgentUse(home)).toBe("claude/agent");
  });

  test("comes from the home's config, and the reviewer follows it", async () => {
    const root = await tempRoot();
    const home = homeWith(root, {
      shell: { module: "@operad-io/shell" },
      pi: { module: "@operad-io/harness-pi" },
    });
    const repository = join(root, "repository");
    mkdirSync(join(repository, ".operad"), { recursive: true });
    writeFileSync(
      join(repository, ".operad", "dev.json"),
      JSON.stringify({ name: "repository" }),
    );
    const settings = await underHome(home, () => readDevSettings(repository));
    expect(settings.worker.use).toBe("pi/agent");
    expect(settings.workers.workers.map((worker) => worker.use)).toEqual(["pi/agent"]);
    expect(settings.reviewer.use).toBe("pi/agent");
  });

  test("also applies when dev.json is missing", async () => {
    const root = await tempRoot();
    const home = homeWith(root, {
      claude: { module: "@operad-io/harness-claude" },
    });
    const repository = join(root, "repository");
    mkdirSync(repository, { recursive: true });
    const settings = await underHome(home, () => readDevSettings(repository));
    expect(settings.worker.use).toBe("claude/agent");
    expect(settings.reviewer.use).toBe("claude/agent");
  });

  test("keeps radian when the home enables no harness", async () => {
    const root = await tempRoot();
    expect(defaultAgentUse(join(root, "no-home"))).toBe(DEFAULT_WORKER_USE);
  });

  test("an enabled codex is still a harness", async () => {
    const root = await tempRoot();
    const home = homeWith(root, {
      codex: { module: "@operad-io/harness-codex" },
    });
    expect(defaultAgentUse(home)).toBe("codex/agent");
  });
});
