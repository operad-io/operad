import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createViews } from "@operad-io/engine";
import { PROPOSAL_TYPE, proposalData, readPiped, setupDevPrompt } from "../src/index.ts";
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

  test("the action opens a chat whose first message is the prepared prompt", async () => {
    const r = await rig();
    const path = repository(r);
    const text = String(await r.act("bot", "default", "setup-dev", { path }));
    const chat = /C-\d+/.exec(text)?.[0];
    if (chat === undefined) throw new Error(`no chat in ${text}`);
    const messages = (await r.store.facts().filter((fact) => fact.object?.id === chat && fact.type === "chat.message"))
      .map((fact) => String((fact.data as { text?: unknown }).text));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`Set up operad's dev for the repository at ${path}`);
    expect(messages[0]).toContain("arguments `default`");
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

  test("it refuses a directory without a remote, text that is not a JSON object and a registered repository", async () => {
    const r = await rig();
    const bare = repository(r, false);
    await expect(r.command("bot", "setup-dev", ["default", bare], DEV_JSON)).rejects.toThrow("no git remote");
    const path = join(r.root, "plain");
    mkdirSync(path);
    await expect(r.command("bot", "setup-dev", ["default", path], DEV_JSON)).rejects.toThrow("not the root of a git work tree");
    mkdirSync(join(bare, "sub"));
    await expect(r.command("bot", "setup-dev", ["default", join(bare, "sub")], DEV_JSON)).rejects.toThrow("not the root of a git work tree");
    execFileSync("git", ["-C", bare, "remote", "add", "origin", "https://example.com/repo.git"], { stdio: "ignore" });
    const real = bare;
    await expect(r.command("bot", "setup-dev", ["default", real], "[1]")).rejects.toThrow("must be a JSON object");
    await expect(r.command("bot", "setup-dev", ["default", real], "not json")).rejects.toThrow("not JSON");
    await r.store.put("repo", "repo", { name: "repo", path: realpathSync(real) }, "test");
    await expect(r.command("bot", "setup-dev", ["default", real], DEV_JSON)).rejects.toThrow("already registered");
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
    expect(page).toContain(setupDevPrompt("default", "<repository directory>"));
  });
});
