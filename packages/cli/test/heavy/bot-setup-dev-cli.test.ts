// Setup Dev from the command line (ADR 0030 D15): `operad bot setup-dev` reads
// a piped dev.json, `operad bot:setup-dev --path` opens the chat, and
// `operad pending` names a proposal by the object its actions take.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempRoots } from "../../../engine/test/plugin/support.ts";
import { makeHome } from "@operad-io/engine/testing";
import { operad } from "@operad-io/test-support";

afterAll(cleanupTempRoots);

const HARNESS = fileURLToPath(new URL("../fixtures/idle-harness.ts", import.meta.url));
const DEV_JSON = JSON.stringify({ name: "repo", remote: "origin", mainBranch: "main" });

async function setup() {
  const made = await makeHome({
    plugins: {
      chat: { module: "@operad-io/chat", enabled: true },
      bot: { module: "@operad-io/bot", enabled: true },
      idle: { module: HARNESS, enabled: true },
    },
    extra: { http: { enabled: false } },
  });
  const repo = join(made.root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  };
  git("init", "-q");
  git("remote", "add", "origin", "https://example.com/repo.git");
  return { ...made, repo };
}

describe("Setup Dev on the command line", () => {
  test("a piped dev.json proposes, and pending prints an id the item's actions take", async () => {
    const { home, repo } = await setup();
    const proposed = await operad(home, ["bot", "setup-dev", "default", repo], { input: DEV_JSON });
    expect(proposed.err).toBe("");
    expect(proposed.out).toContain("proposed Setup Dev");

    const pending = await operad(home, ["pending"]);
    const first = pending.out.split("\n")[0] ?? "";
    const id = first.split(/\s+/)[0] ?? "";
    expect(id).toMatch(/^bot-proposal:p-/);
    // The item reads as a title, not as its id (T-0747).
    const folder = repo.split("/").pop() ?? "";
    expect(pending.out).toContain(`Setup Dev: ${folder} (proposed by bot default) is waiting for your review`);

    const review = await operad(home, ["bot:review", id]);
    expect(review.err).not.toContain("no object");
    expect(review.out).toContain("Setup Dev for");
  });

  test("with no stdin it answers the steps and proposes nothing", async () => {
    const { home, repo } = await setup();
    const steps = await operad(home, ["bot", "setup-dev", "default", repo]);
    expect(steps.code).toBe(0);
    expect(steps.out).toContain("verb `setup-dev`");
    expect((await operad(home, ["pending"])).out).toContain("nothing is waiting");
  });

  test("the action takes its directory as --path and opens the chat", async () => {
    const { home, repo } = await setup();
    const opened = await operad(home, ["bot:setup-dev", "default", "--path", repo]);
    expect(opened.err).toBe("");
    expect(opened.out).toContain("opened chat");
  });
});
