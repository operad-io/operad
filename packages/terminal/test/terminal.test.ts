import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@operad-io/engine";
import { repositoryOf } from "../src/folders.ts";
import { loginShell, REMOTE_REFUSAL, Session, type TerminalInfo, type TerminalList } from "../src/index.ts";
import { addWorktree, closeAll, git, lingering, makeWorld, render, serve, type Refusal } from "./support.ts";

afterEach(closeAll);

describe("starting a terminal", () => {
  test("runs the command in the folder, passes output on, and takes input", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({
      command: 'echo "in:$PWD"; read line; echo "got:$line"; read rest',
      folder: world.repository,
    });
    expect(terminal.state).toBe("running");
    const stream = await served.stream(terminal.id);
    await stream.shows(terminal.id, new RegExp(`in:${world.repository}`));
    await served.input(terminal.id, "hello\r");
    await stream.shows(terminal.id, /got:hello/);
  });

  test("resize reaches the program, the list and the readers", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({
      command: 'stty size; read go; echo "now:$(stty size)"; read rest',
      folder: world.repository,
      cols: 90,
      rows: 20,
    });
    const stream = await served.stream(terminal.id);
    await stream.shows(terminal.id, /20 90/);
    const resized = await served.request<{ terminal: TerminalInfo }>(
      "POST",
      `/v1/terminal/${terminal.id}/resize`,
      { cols: 101, rows: 33 },
    );
    expect(resized.body.terminal).toMatchObject({ cols: 101, rows: 33 });
    const told = await stream.until((event) => event.name === "resize");
    expect(told.data).toEqual({ id: terminal.id, cols: 101, rows: 33 });
    await served.input(terminal.id, "\r");
    await stream.shows(terminal.id, /now:33 101/);
    const late = await served.stream(terminal.id);
    const screen = await late.until((event) => event.name === "screen");
    expect(screen.data).toMatchObject({ cols: 101, rows: 33 });
  });

  test("runs the command line in the login shell with -ilc, and an empty one opens the shell", async () => {
    const world = await makeWorld();
    const shell = join(world.root, "shell");
    writeFileSync(shell, '#!/bin/sh\nfor word in "$@"; do printf "<%s>" "$word"; done\necho " end"\nread line\n');
    chmodSync(shell, 0o755);
    const served = await serve(world, { plugin: { shell } });
    const command = await served.start({ command: "bun run dev --port 1", folder: world.repository });
    const empty = await served.start({ command: "  ", folder: world.repository });
    expect(empty.command).toBe("");
    const stream = await served.stream(command.id, empty.id);
    await stream.shows(command.id, /<-ilc><bun run dev --port 1> end/);
    await stream.shows(empty.id, /<-il> end/);
  });

  test("the login shell is $SHELL, or the system's usual one", () => {
    expect(loginShell({ SHELL: "/opt/fish" }, "darwin")).toBe("/opt/fish");
    expect(loginShell({}, "darwin")).toBe("/bin/zsh");
    expect(loginShell({ SHELL: "" }, "linux")).toBe("/bin/sh");
  });

  test("starts in the home folder and in a folder outside every repository, which name none", async () => {
    const world = await makeWorld();
    const outside = join(world.root, "outside");
    const inside = join(world.repository, "src");
    mkdirSync(outside);
    mkdirSync(inside);
    const served = await serve(world);
    for (const folder of [realpathSync(homedir()), outside, inside]) {
      const terminal = await served.start({ command: 'echo "at:$PWD:"; read x', folder });
      expect(terminal).toMatchObject({ folder, repository: null });
      const stream = await served.stream(terminal.id);
      await stream.shows(terminal.id, new RegExp(`at:${folder}:`));
      const screen = await stream.until((event) => event.name === "screen");
      expect(screen.data.repository).toBeNull();
    }
    expect((await served.list()).terminals.map((t) => t.repository)).toEqual([null, null, null]);
  });

  test("in a repository or one of its worktrees names that repository", async () => {
    const world = await makeWorld();
    const worktree = addWorktree(world, "TK1");
    // A worktree outside the repository's folder is its worktree too.
    const apart = join(world.root, "apart");
    git(world.repository, "worktree", "add", "-q", "--detach", apart);
    const served = await serve(world);
    for (const folder of [world.repository, worktree, apart]) {
      const terminal = await served.start({ command: "read x", folder });
      expect(terminal).toMatchObject({ folder, repository: "repository" });
    }
    const listed = (await served.list()).terminals;
    expect(listed.map((t) => t.repository)).toEqual(["repository", "repository", "repository"]);
    const stream = await served.stream(listed[1]?.id ?? "");
    const screen = await stream.until((event) => event.name === "screen");
    expect(screen.data.repository).toBe("repository");
  });

  test("a repository's own folder names it before another repository's worktree", async () => {
    const world = await makeWorld();
    const worktree = addWorktree(world, "TK1");
    const outer = { name: "outer", path: world.repository };
    const inner = { name: "inner", path: worktree };
    // Listed first, "outer" would claim the folder as its worktree.
    expect(await repositoryOf(worktree, [outer, inner])).toBe("inner");
    // The worktree lists the main folder too, and does not claim it either.
    expect(await repositoryOf(world.repository, [inner, outer])).toBe("outer");
  });

  test("keeps the real path of a folder reached through a link", async () => {
    const world = await makeWorld();
    const link = join(world.root, "link");
    symlinkSync(world.repository, link);
    const served = await serve(world);
    expect(await served.start({ command: "read x", folder: link })).toMatchObject({
      folder: world.repository,
      repository: "repository",
    });
  });

  test("refuses a missing folder, a file, a relative path and ~, saying why", async () => {
    const world = await makeWorld();
    const file = join(world.root, "file");
    writeFileSync(file, "");
    const missing = join(world.root, "nothing");
    const under = join(file, "under");
    const loop = join(world.root, "loop");
    symlinkSync(loop, loop);
    const served = await serve(world);
    const relative = (folder: string) =>
      `the folder must be an absolute path, with no "~", and "${folder}" is not one`;
    for (const [folder, message] of [
      [missing, `there is no folder at "${missing}"`],
      [under, `there is no folder at "${under}"`],
      [file, `"${file}" is not a folder`],
      ["repository", relative("repository")],
      ["~", relative("~")],
      ["", relative("")],
    ] as const) {
      const refused = await served.request("POST", "/v1/terminal", { folder, cols: 80, rows: 24 });
      expect(refused.status).toBe(422);
      expect(refused.body.error).toEqual({ kind: "refused", message });
    }
    const looping = await served.request("POST", "/v1/terminal", { folder: loop, cols: 80, rows: 24 });
    expect(looping.status).toBe(422);
    expect(looping.body.error.message).toStartWith(`the folder "${loop}" cannot be opened: `);
    expect((await served.list()).terminals).toEqual([]);
  });

  test("refuses a size outside 1 to 1000 and a body without a folder", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    for (const body of [
      { folder: world.repository, cols: 0, rows: 24 },
      { folder: world.repository, cols: 80, rows: 1001 },
      { folder: world.repository, cols: 80.5, rows: 24 },
      { cols: 80, rows: 24 },
    ]) {
      expect((await served.request("POST", "/v1/terminal", body)).status).toBe(400);
    }
    expect((await served.list()).terminals).toEqual([]);
  });

  test("a shell that cannot start is refused with the reason, and nothing is listed", async () => {
    const world = await makeWorld();
    const served = await serve(world, { plugin: { shell: join(world.root, "no-shell") } });
    const refused = await served.request("POST", "/v1/terminal", {
      folder: world.repository,
      cols: 80,
      rows: 24,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toStartWith("the terminal did not start: ");
    expect((await served.list()).terminals).toEqual([]);
  });

  test("offers the loaded agents as command lines", async () => {
    const world = await makeWorld();
    const harness = (name: string) => definePlugin({ name, kind: "harness", version: "1.0.0" });
    const own = definePlugin({
      name: "pi",
      kind: "harness",
      version: "1.0.0",
      interactiveCommand: () => "/home/x/bin/pi",
    });
    const served = await serve(world, { plugins: [own, harness("radian"), harness("claude")] });
    expect((await served.list()).presets).toEqual([
      { name: "claude", command: "claude" },
      { name: "pi", command: "/home/x/bin/pi" },
    ]);
  });
});

describe("the list", () => {
  test("shows each terminal, and close stops everything it started and takes it off", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const job = lingering(world, "job");
    // A job of the interactive shell is in a process group of its own.
    const running = await served.start({
      command: `bash -c "${job.command}"; echo after`,
      folder: world.repository,
    });
    const other = await served.start({ command: "read x", folder: world.repository });
    await job.up;
    expect((await served.list()).terminals.map((terminal) => [terminal.id, terminal.state])).toEqual([
      [running.id, "running"],
      [other.id, "running"],
    ]);
    const stream = await served.stream(running.id);
    const closed = await served.request<{ terminal: TerminalInfo }>(
      "POST",
      `/v1/terminal/${running.id}/close`,
      {},
    );
    expect(closed.status).toBe(200);
    expect(closed.body.terminal).toMatchObject({ state: "ended", reason: null });
    await job.gone;
    await stream.until((event) => event.name === "closed" && event.data.id === running.id);
    expect((await served.list()).terminals.map((terminal) => terminal.id)).toEqual([other.id]);
    const again = await served.request("POST", `/v1/terminal/${running.id}/close`, {});
    expect(again.status).toBe(404);
  });

  test("an ended terminal stays with its exit code, takes no input, and closes", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({ command: "read go; echo bye; exit 7", folder: world.repository });
    const stream = await served.stream(terminal.id);
    await served.input(terminal.id, "\r");
    const exit = await stream.until((event) => event.name === "exit");
    expect(exit.data).toEqual({ id: terminal.id, exitCode: 7, signal: null, reason: null });
    // The exit comes after the last output.
    expect(stream.output(terminal.id)).toContain("bye");
    expect(await served.ended(terminal.id)).toMatchObject({ state: "ended", exitCode: 7 });
    const late = await served.stream(terminal.id);
    const screen = await late.until((event) => event.name === "screen");
    expect(screen.data).toMatchObject({ state: "ended", exitCode: 7 });
    for (const [path, body] of [
      ["input", { data: "x" }],
      ["resize", { cols: 10, rows: 10 }],
    ] as const) {
      const refused = await served.request("POST", `/v1/terminal/${terminal.id}/${path}`, body);
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toContain("has ended");
    }
    expect((await served.request("POST", `/v1/terminal/${terminal.id}/close`, {})).status).toBe(200);
    expect((await served.list()).terminals).toEqual([]);
  });

  test("a stream naming a terminal that is not there is told it is closed", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const stream = await served.stream("t-gone");
    const closed = await stream.until((event) => event.name === "closed");
    expect(closed.data).toEqual({ id: "t-gone" });
  });

  test("a stream is told when the list changes", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const stream = await served.stream();
    const terminal = await served.start({ command: "read x", folder: world.repository });
    await stream.until((event) => event.name === "change" && event.data.id === terminal.id);
    expect(stream.events.some((event) => event.name === "output" || event.name === "screen")).toBe(false);
  });
});

describe("clients come and go", () => {
  test("a terminal keeps running when its client disconnects", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({
      command: 'read one; echo "one:$one"; read two; echo "two:$two"; read rest',
      folder: world.repository,
    });
    const first = await served.stream(terminal.id);
    await first.until((event) => event.name === "screen");
    first.close();
    await served.left();
    await served.outlast(world.repository);
    expect((await served.list()).terminals).toMatchObject([{ id: terminal.id, state: "running" }]);
    await served.input(terminal.id, "a\r");
    const second = await served.stream(terminal.id);
    await second.shows(terminal.id, /one:a/);
    await served.input(terminal.id, "b\r");
    await second.shows(terminal.id, /two:b/);
  });

  test("a client that reconnects gets the screen first, then only what follows", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({
      command:
        'printf "\\033[31mred\\033[0m\\n"; echo "first-$((40+2))"; read go; echo "second-$((50+2))"; read rest',
      folder: world.repository,
    });
    const first = await served.stream(terminal.id);
    await first.shows(terminal.id, /first-42/);
    first.close();
    const second = await served.stream(terminal.id);
    const screen = await second.until((event) => event.name === "screen");
    expect(second.events.filter((event) => event.name !== "change")[0]).toBe(screen);
    const replayed = String(screen.data.data);
    expect(await render(replayed)).toContain("first-42");
    expect(replayed).toContain("\u001b[31mred");
    await served.input(terminal.id, "\r");
    await second.shows(terminal.id, /second-52/);
    expect(second.output(terminal.id)).not.toContain("first-42");
    const lines = await render(replayed + second.output(terminal.id));
    expect(lines.filter((line) => line === "first-42")).toHaveLength(1);
    expect(lines.filter((line) => line === "second-52")).toHaveLength(1);
  });

  test("the replayed scrollback is capped at 5000 lines", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({
      command: "for ((n=1; n<=5200; n++)); do echo line-$n; done; echo done-$((1+1)); read rest",
      folder: world.repository,
    });
    const live = await served.stream(terminal.id);
    await live.shows(terminal.id, /done-2/);
    const late = await served.stream(terminal.id);
    const screen = await late.until((event) => event.name === "screen");
    const lines = (await render(String(screen.data.data))).filter((line) => line.startsWith("line-"));
    // 5000 lines above a screen of 24, two of which are `done-2` and the cursor's.
    expect(lines.at(-1)).toBe("line-5200");
    expect(lines).toHaveLength(5000 + 24 - 2);
  });

  test("a client that joins in the middle of a sequence or a character gets it whole", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({
      command:
        "stty -echo; printf 'a\\033[3'; read go; printf '1mred \\344\\270'; read go; printf '\\255 end\\n'; read rest",
      folder: world.repository,
    });
    const first = await served.stream(terminal.id);
    await first.shows(terminal.id, /a/);
    const second = await served.stream(terminal.id);
    await second.until((event) => event.name === "screen");
    await served.input(terminal.id, "\r");
    await second.shows(terminal.id, /red /);
    expect(second.output(terminal.id)).toContain("\u001b[31mred ");
    const third = await served.stream(terminal.id);
    await third.until((event) => event.name === "screen");
    await served.input(terminal.id, "\r");
    await third.shows(terminal.id, /end/);
    expect(third.output(terminal.id)).toContain("\u4e2d end");
  });

  test("with no reader the headless terminal answers a program's question", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({
      command: `read go; printf '\\033[6n'; IFS= read -rs -d R at; echo "at:\${at#*[}"`,
      folder: world.repository,
    });
    await served.input(terminal.id, "\r");
    await served.ended(terminal.id);
    const stream = await served.stream(terminal.id);
    await stream.shows(terminal.id, /at:2;1/);
  });

  test("with a reader the reader answers, and serve stays quiet", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({
      command: `read go; printf '\\033[6n'; IFS= read -rs -d R at; echo "at:\${at#*[}"; read rest`,
      folder: world.repository,
    });
    const stream = await served.stream(terminal.id);
    await stream.until((event) => event.name === "screen");
    await served.input(terminal.id, "\r");
    await stream.shows(terminal.id, /\u001b\[6n/);
    await served.input(terminal.id, "\u001b[9;7R");
    await stream.shows(terminal.id, /at:9;7/);
  });
});

describe("a client that is joining when the terminal closes", () => {
  test("is told it closed", async () => {
    const world = await makeWorld();
    const session = new Session({
      id: "t-1",
      command: "exit 0",
      folder: world.repository,
      repository: null,
      cols: 80,
      rows: 24,
      group: null,
      home: world.home,
      shell: "/bin/bash",
      env: { HOME: world.home },
      now: () => 0,
      onChange: () => undefined,
      onLog: () => undefined,
    });
    await session.ended;
    const events: string[] = [];
    // Joined, and closed before the screen's turn came.
    session.attach((event) => events.push(event.name));
    await session.stop();
    session.dispose();
    expect(events).toEqual(["closed"]);
  });
});

describe("this machine only", () => {
  const away = { server: { peerAddress: () => "192.168.1.20" } };

  test("a request from another address may read the list and nothing else", async () => {
    const world = await makeWorld();
    let peer: string | undefined = "127.0.0.1";
    const served = await serve(world, { server: { peerAddress: () => peer } });
    const terminal = await served.start({ command: "read x", folder: world.repository });
    const group = await served.group("servers");
    peer = "192.168.1.20";
    for (const [path, body] of [
      ["/v1/terminal", { folder: world.repository, cols: 80, rows: 24 }],
      [`/v1/terminal/${terminal.id}/input`, { data: "x\r" }],
      [`/v1/terminal/${terminal.id}/resize`, { cols: 10, rows: 10 }],
      [`/v1/terminal/${terminal.id}/close`, {}],
      [`/v1/terminal/${terminal.id}/group`, { group: group.id }],
      ["/v1/terminal/groups", { name: "other" }],
      [`/v1/terminal/groups/${group.id}`, { name: "other" }],
      [`/v1/terminal/groups/${group.id}/delete`, {}],
    ] as const) {
      const refused = await served.request("POST", path, body);
      expect({ path, status: refused.status }).toEqual({ path, status: 403 });
      expect(refused.body.error).toEqual({ kind: "refused", message: REMOTE_REFUSAL });
    }
    const screen = await served.request("GET", `/v1/events?terminal=${terminal.id}`);
    expect(screen.status).toBe(403);
    expect(screen.body.error.message).toBe(REMOTE_REFUSAL);
    const list = await served.request<TerminalList>("GET", "/v1/terminal");
    expect(list.status).toBe(200);
    expect(list.body.terminals).toMatchObject([{ id: terminal.id, state: "running", cols: 80, group: null }]);
    expect(list.body.groups).toMatchObject([{ id: group.id, name: "servers" }]);
    const changes = await served.stream();
    expect(changes.status).toBe(200);
  });

  test("a start from another address starts nothing", async () => {
    const world = await makeWorld();
    const served = await serve(world, away);
    const refused = await served.request("POST", "/v1/terminal", {
      folder: world.repository,
      cols: 80,
      rows: 24,
    });
    expect(refused.status).toBe(403);
    expect((await served.list()).terminals).toEqual([]);
  });

  test("a request a proxy forwarded over loopback is refused", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const refused = await served.request<Refusal>(
      "POST",
      "/v1/terminal",
      { folder: world.repository, cols: 80, rows: 24 },
      { "x-forwarded-for": "100.64.0.9" },
    );
    expect(refused.status).toBe(403);
    expect((await served.list()).terminals).toEqual([]);
  });
});

describe("several readers", () => {
  test("one is told to answer the program, and the next when it leaves", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const terminal = await served.start({ command: "read x", folder: world.repository });
    const first = await served.stream(terminal.id);
    const screenOf = async (stream: typeof first) =>
      (await stream.until((event) => event.name === "screen")).data.answers;
    expect(await screenOf(first)).toBe(true);
    const second = await served.stream(terminal.id);
    expect(await screenOf(second)).toBe(false);
    const third = await served.stream(terminal.id);
    expect(await screenOf(third)).toBe(false);
    first.close();
    expect((await second.until((event) => event.name === "answers")).data).toEqual({ id: terminal.id });
    await served.input(terminal.id, "\r");
    await third.until((event) => event.name === "exit");
    expect(third.events.filter((event) => event.name === "answers")).toEqual([]);
  });
});

describe("serve without trigger rules", () => {
  test("still serves terminals", async () => {
    const world = await makeWorld();
    const served = await serve(world, { rulesLoaded: false });
    expect((await served.list()).terminals).toEqual([]);
  });
});

describe("serve stops", () => {
  test("every terminal ends, and the next serve lists none", async () => {
    const world = await makeWorld();
    const first = await serve(world);
    const job = lingering(world, "server");
    const terminal = await first.start({ command: job.command, folder: world.repository });
    await job.up;
    await first.stop();
    await job.gone;
    const second = await serve(world);
    expect((await second.list()).terminals).toEqual([]);
    expect((await second.request("POST", `/v1/terminal/${terminal.id}/input`, { data: "x" })).status).toBe(404);
  });
});
