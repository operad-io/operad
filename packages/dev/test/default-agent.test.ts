import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "./support.ts";
import {
  defaultAgentUse,
  DEFAULT_WORKER_USE,
  readDevSettings,
} from "../src/settings.ts";

afterAll(cleanupTempRoots);

// The agents of the machine that runs the tests must not change the choice.
const machinePath = process.env.PATH;
beforeAll(async () => {
  process.env.PATH = await tempRoot();
});
afterAll(() => {
  process.env.PATH = machinePath;
});

const every = {
  radian: { module: "@operad-io/harness-radian" },
  claude: { module: "@operad-io/harness-claude" },
  pi: { module: "@operad-io/harness-pi" },
  codex: { module: "@operad-io/harness-codex" },
};

function homeWith(
  root: string,
  plugins: Readonly<Record<string, { readonly module: string; readonly enabled?: boolean; readonly settings?: object }>>,
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

  test("reads the array form and skips an entry with enabled false", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [
          { name: "radian", module: "@operad-io/harness-radian", enabled: false },
          { name: "claude", module: "@operad-io/harness-claude", enabled: false },
          { name: "pi", module: "@operad-io/harness-pi" },
          { name: "codex", module: "@operad-io/harness-codex" },
        ],
      }),
    );
    expect(defaultAgentUse(home)).toBe("pi/agent");
  });

  test("the agent's own name as `command` does not make claude or pi count as there", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex"), 0o755);
    const home = homeWith(root, {
      claude: { module: "@operad-io/harness-claude", settings: { command: "claude" } },
      pi: { module: "@operad-io/harness-pi", settings: { command: "pi" } },
      codex: { module: "@operad-io/harness-codex" },
    });
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(defaultAgentUse(home)).toBe("codex/agent");
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  test("reads the array of module names", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ plugins: ["@operad-io/harness-claude", "@operad-io/harness-pi"] }),
    );
    expect(defaultAgentUse(home)).toBe("claude/agent");
  });

  test("keeps radian when the home enables no harness", async () => {
    const root = await tempRoot();
    expect(defaultAgentUse(join(root, "no-home"))).toBe(DEFAULT_WORKER_USE);
  });

  test("passes over an enabled harness whose agent is not on the machine", async () => {
    const root = await tempRoot();
    const home = homeWith(root, every);
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex"), 0o755);
    const empty = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(defaultAgentUse(home)).toBe("codex/agent");
    } finally {
      process.env.PATH = empty;
    }
  });

  test("counts the pi operad installed in the home", async () => {
    const root = await tempRoot();
    const home = homeWith(root, every);
    const dir = join(home, "plugins", "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    expect(defaultAgentUse(home)).toBe("pi/agent");
  });

  test("counts a harness whose command the owner set", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ plugins: { ...every, claude: { ...every.claude, settings: { command: "/opt/claude" } } } }),
    );
    expect(defaultAgentUse(home)).toBe("claude/agent");
  });

  test("an enabled codex is still a harness", async () => {
    const root = await tempRoot();
    const home = homeWith(root, {
      codex: { module: "@operad-io/harness-codex" },
    });
    expect(defaultAgentUse(home)).toBe("codex/agent");
  });
});
