import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { createViews, guideBody } from "@operad-io/engine";
import { PROPOSAL_TYPE, proposalData, readPiped, renderGuide } from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

function repository(r: Rig, remote = true): string {
  const path = join(r.root, "repo");
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", path, ...args], { stdio: "ignore" });
  };
  git("init", "-q");
  if (remote) git("remote", "add", "origin", "https://example.com/repo.git");
  return path;
}

const DEV_JSON = JSON.stringify({ name: "repo", remote: "origin", mainBranch: "main", gate: { commands: ["bun test"] } });

function plugins(r: Rig): Record<string, { enabled?: boolean }> {
  return (JSON.parse(readFileSync(join(r.home, "config.json"), "utf8")) as { plugins: Record<string, { enabled?: boolean }> })
    .plugins;
}

async function proposalId(r: Rig): Promise<string> {
  const id = (await r.registry.standing())[0]?.object?.id;
  if (id === undefined) throw new Error("no proposal item");
  return id;
}

describe("Setup Dev", () => {
  test("with no dev.json the command answers the steps and proposes nothing", async () => {
    const r = await rig();
    const path = repository(r);
    const steps = String(await r.command("bot", "setup-dev", ["default", path]));
    expect(steps).toContain(path);
    expect(steps).toContain("verb `setup-dev`");
    expect(await r.registry.standing()).toEqual([]);
  });

  test("a bot chat starts with the line that says how Setup Dev is proposed", async () => {
    const r = await rig();
    const chat = await r.open("default");
    await r.say(chat, "hello");
    await r.reply(chat);
    const prompt = String(r.calls[0]?.params.prompt ?? "");
    expect(prompt).toContain("Setup Dev");
    expect(prompt).toContain("verb `setup-dev`");
  });

  test("the action opens a chat that shows its title and gives the agent the prepared prompt", async () => {
    const r = await rig();
    const path = repository(r);
    const text = String(await r.act("bot", "default", "setup-dev", { path }));
    const chat = /C-\d+/.exec(text)?.[0];
    if (chat === undefined) throw new Error(`no chat in ${text}`);
    const messages = (await r.store.facts().filter((fact) => fact.object?.id === chat && fact.type === "chat.message"))
      .map((fact) => fact.data as { text?: unknown; instruction?: unknown });
    expect(messages).toHaveLength(1);
    const title = `Setup Dev (${basename(path)})`;
    expect(messages[0]?.text).toBe(title);
    expect(String(messages[0]?.instruction)).toContain(`Set up operad's dev for the repository at ${path}`);
    expect(String(messages[0]?.instruction)).toContain("arguments `default`");
    await r.reply(chat);
    const sent = String(r.calls[0]?.params.prompt ?? "");
    expect(sent).toContain(`${title}\n\n`);
    expect(sent).toContain(String(messages[0]?.instruction));
    expect(sent.indexOf(title)).toBeLessThan(sent.indexOf("Set up operad's dev"));
  });

  test("a proposal turns nothing on and writes nothing; its review shows what approve does", async () => {
    const r = await rig();
    const path = repository(r);
    const said = await r.command("bot", "setup-dev", ["default", path], DEV_JSON);
    expect(String(said)).toContain("proposed Setup Dev");
    expect(existsSync(join(path, ".operad"))).toBe(false);
    expect(Object.keys(plugins(r))).toEqual(["bot"]);
    expect(existsSync(join(r.home, "dev-register"))).toBe(false);

    const id = await proposalId(r);
    const proposal = await r.store.get(PROPOSAL_TYPE, id);
    if (proposal === undefined) throw new Error("no proposal");
    expect(proposalData(proposal).kind).toBe("dev");
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const review = await views.section(`${PROPOSAL_TYPE}:${id}`, "review", undefined, { full: true });
      expect(review.markdown).toContain("dev, shell, pool");
      expect(review.markdown).toContain('"bun test"');
    } finally {
      views.close();
    }
  });

  test("approve turns dev, shell and pool on, writes dev.json and leaves the request; reject leaves nothing", async () => {
    const r = await rig();
    const path = repository(r);
    await r.command("bot", "setup-dev", ["default", path], DEV_JSON);
    const id = await proposalId(r);
    await r.act(PROPOSAL_TYPE, id, "approve");
    expect(plugins(r).dev?.enabled).toBe(true);
    expect(plugins(r).shell?.enabled).toBe(true);
    expect(plugins(r).pool?.enabled).toBe(true);
    expect(plugins(r).bot).toBeDefined();
    expect(JSON.parse(readFileSync(join(path, ".operad", "dev.json"), "utf8")).gate.commands).toEqual(["bun test"]);
    const requests = readdirSync(join(r.home, "dev-register"));
    expect(requests).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(r.home, "dev-register", requests[0] ?? ""), "utf8")).path).toContain("repo");

    const other = await rig();
    const otherPath = repository(other);
    await other.command("bot", "setup-dev", ["default", otherPath], DEV_JSON);
    await other.act(PROPOSAL_TYPE, await proposalId(other), "reject");
    expect(existsSync(join(otherPath, ".operad"))).toBe(false);
    expect(Object.keys(plugins(other))).toEqual(["bot"]);
  });

  test("it refuses a subfolder of a repository naming the root, text that is not a JSON object and a registered repository", async () => {
    const r = await rig();
    const bare = repository(r, false);
    mkdirSync(join(bare, "sub"));
    await expect(r.command("bot", "setup-dev", ["default", join(bare, "sub")], DEV_JSON)).rejects.toThrow(
      `is inside the git repository at "${realpathSync(bare)}"`,
    );
    execFileSync("git", ["-C", bare, "remote", "add", "origin", "https://example.com/repo.git"], { stdio: "ignore" });
    const real = bare;
    await expect(r.command("bot", "setup-dev", ["default", real], "[1]")).rejects.toThrow("must be a JSON object");
    await expect(r.command("bot", "setup-dev", ["default", real], "not json")).rejects.toThrow("not JSON");
    await r.store.put("repo", "repo", { name: "repo", path: realpathSync(real) }, "test");
    await expect(r.command("bot", "setup-dev", ["default", real], DEV_JSON)).rejects.toThrow("already registered");
  });
});

describe("Setup Dev without a remote", () => {
  test("a git repository with no remote is proposed, and the file written names no remote", async () => {
    const r = await rig();
    const path = repository(r, false);
    await r.command("bot", "setup-dev", ["default", path], DEV_JSON);
    await r.act(PROPOSAL_TYPE, await proposalId(r), "approve");
    const written = JSON.parse(readFileSync(join(path, ".operad", "dev.json"), "utf8")) as Record<string, unknown>;
    expect("remote" in written).toBe(false);
    expect(written.mainBranch).toBe("main");
  });
});


function refusingGit(root: string): { restore(): void } {
  const real = Bun.which("git");
  if (real === undefined) throw new Error("git is not on PATH");
  const bin = join(root, "refusing-git");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      'case "$*" in *"rev-parse --show-toplevel"*)',
      "  echo 'fatal: detected dubious ownership in repository at /somewhere' >&2",
      "  exit 128;;",
      "esac",
      `exec '${real}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  return {
    restore() {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    },
  };
}

describe("Setup Dev without git", () => {
  test("a repository git refuses is refused with git's message, not set up as a folder", async () => {
    const r = await rig();
    const path = repository(r, false);
    const stub = refusingGit(r.root);
    try {
      await expect(r.command("bot", "setup-dev", ["default", path], DEV_JSON)).rejects.toThrow(
        "fatal: detected dubious ownership in repository",
      );
    } finally {
      stub.restore();
    }
    expect(await r.registry.standing()).toEqual([]);
  });

  test("a folder with no git is proposed, and the file written works in place with no remote", async () => {
    const r = await rig();
    const path = join(r.root, "plain");
    mkdirSync(path);
    const text = JSON.stringify({ name: "plain", remote: "origin", workIn: "worktree", concurrency: 2, mainBranch: "main" });
    await r.command("bot", "setup-dev", ["default", path], text);
    await r.act(PROPOSAL_TYPE, await proposalId(r), "approve");
    const written = JSON.parse(readFileSync(join(path, ".operad", "dev.json"), "utf8")) as Record<string, unknown>;
    expect("remote" in written).toBe(false);
    expect("concurrency" in written).toBe(false);
    expect(written.workIn).toBe("branch");
    expect(existsSync(join(path, ".git"))).toBe(false);
  });

  test("the guide does not ask about git, and stops for a subfolder", () => {
    const guide = readFileSync(join(import.meta.dir, "../../dev/skills/setup/SKILL.md"), "utf8");
    const body = renderGuide(guideBody(guide), "default", "/repo");
    expect(body).toContain("do not run `git` in a folder that is not a");
    expect(body).toContain("do not ask me about git");
    expect(body).toContain("inside another git repository, tell me that repository's folder and stop");
    expect(body).toContain("Skip this question when /repo is");
  });
});

describe("the Setup Dev page", () => {
  test("piped input: a stream with dev.json is read whole; a silent one or a given text is not waited for", async () => {
    async function* chunks(): AsyncGenerator<string> {
      yield DEV_JSON.slice(0, 5);
      yield DEV_JSON.slice(5);
    }
    expect(await readPiped(undefined, { stream: chunks() })).toBe(DEV_JSON);
    expect(await readPiped("given", { stream: chunks() })).toBe("given");
    let destroyed = false;
    const silent = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => undefined) }),
      destroy: () => {
        destroyed = true;
      },
    };
    expect(await readPiped(undefined, { stream: silent, giveUp: Promise.resolve() })).toBe("");
    expect(destroyed).toBe(true);
  });

  test("shows the prompt the bot is given", () => {
    const page = readFileSync(join(import.meta.dir, "../../../docs/user/setup-prompt.md"), "utf8");
    const guide = readFileSync(join(import.meta.dir, "../../dev/skills/setup/SKILL.md"), "utf8");
    expect(page).toContain(
      renderGuide(guideBody(guide), "default", "<repository directory>"),
    );
  });

  test("the guide asks which way to work in plain words and writes workIn", () => {
    const guide = readFileSync(join(import.meta.dir, "../../dev/skills/setup/SKILL.md"), "utf8");
    const body = renderGuide(guideBody(guide), "default", "/repo");
    const ask = body.slice(body.indexOf("Ask me which way to work"), body.indexOf("Write the `.operad/dev.json`"));
    expect(ask).toContain("new branch in this folder");
    expect(ask).toContain("own separate folder");
    expect(ask).toContain("do not use the words clone, worktree or concurrency");
    expect(ask).toContain("choose the first");
    expect(body).toContain('"workIn": "<branch or worktree, from my answer>"');
    expect(body).toContain('`"branch"` for the first way and `"worktree"` for the second');
  });
});
