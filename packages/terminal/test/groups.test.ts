import { afterEach, describe, expect, test } from "bun:test";
import type { GroupInfo, TerminalInfo } from "../src/index.ts";
import { addWorktree, closeAll, makeWorld, serve, type Served } from "./support.ts";

afterEach(closeAll);

async function rename(served: Served, id: string, name: string) {
  return await served.request<{ group: GroupInfo }>("POST", `/v1/terminal/groups/${id}`, { name });
}

describe("groups", () => {
  test("are created, renamed and deleted", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const stream = await served.stream();
    const first = await served.group("  dev servers  ");
    const second = await served.group("agents");
    expect(first).toMatchObject({ name: "dev servers", terminals: [] });
    expect((await served.list()).groups.map((group) => group.name)).toEqual(["agents", "dev servers"]);
    expect((await rename(served, first.id, "servers")).body.group).toMatchObject({
      id: first.id,
      name: "servers",
    });
    expect((await served.request("POST", `/v1/terminal/groups/${second.id}/delete`, {})).status).toBe(200);
    expect((await served.list()).groups.map((group) => group.name)).toEqual(["servers"]);
    await stream.until((event) => event.name === "change" && event.data.group === second.id);
    expect((await rename(served, second.id, "again")).status).toBe(404);
    expect((await served.request("POST", `/v1/terminal/groups/${second.id}/delete`, {})).status).toBe(404);
    expect((await served.request("POST", "/v1/terminal/groups", { name: "  " })).status).toBe(400);
    expect((await rename(served, first.id, "x".repeat(101))).status).toBe(400);
  });

  test("take terminals of any folder, one group for each, at the start or after", async () => {
    const world = await makeWorld();
    const worktree = addWorktree(world, "TK1");
    const served = await serve(world);
    const servers = await served.group("servers");
    const others = await served.group("others");
    const one = await served.start({ command: "read x", folder: world.repository, group: servers.id });
    const two = await served.start({ command: "read x", folder: worktree });
    expect(one.group).toBe(servers.id);
    expect(two.group).toBeNull();
    const assign = async (id: string, group: string | null) =>
      await served.request<{ terminal: TerminalInfo }>("POST", `/v1/terminal/${id}/group`, { group });
    expect((await assign(two.id, servers.id)).body.terminal.group).toBe(servers.id);
    const members = async () =>
      Object.fromEntries((await served.list()).groups.map((group) => [group.name, group.terminals]));
    expect(await members()).toEqual({ servers: [one.id, two.id], others: [] });
    await assign(one.id, others.id);
    expect(await members()).toEqual({ servers: [two.id], others: [one.id] });
    await assign(two.id, null);
    expect(await members()).toEqual({ servers: [], others: [one.id] });
    expect((await assign(two.id, "g-none")).status).toBe(404);
    const refused = await served.request("POST", "/v1/terminal", {
      folder: world.repository,
      cols: 80,
      rows: 24,
      group: "g-none",
    });
    expect(refused.status).toBe(404);
    expect((await served.list()).terminals).toHaveLength(2);
  });

  test("deleting a group leaves its terminals running, in no group", async () => {
    const world = await makeWorld();
    const served = await serve(world);
    const group = await served.group("servers");
    const terminal = await served.start({
      command: 'read x; echo "got:$x"; read rest',
      folder: world.repository,
      group: group.id,
    });
    await served.request("POST", `/v1/terminal/groups/${group.id}/delete`, {});
    expect((await served.list()).terminals).toMatchObject([
      { id: terminal.id, state: "running", group: null },
    ]);
    await served.input(terminal.id, "still\r");
    await (await served.stream(terminal.id)).shows(terminal.id, /got:still/);
  });

  test("stay when their terminals end, and over a serve restart", async () => {
    const world = await makeWorld();
    const first = await serve(world);
    const group = await first.group("servers");
    const terminal = await first.start({ command: "exit 0", folder: world.repository, group: group.id });
    await first.ended(terminal.id);
    expect((await first.list()).groups).toMatchObject([{ id: group.id, terminals: [terminal.id] }]);
    await first.request("POST", `/v1/terminal/${terminal.id}/close`, {});
    expect((await first.list()).groups).toMatchObject([{ id: group.id, terminals: [] }]);
    await first.start({ command: "read x", folder: world.repository, group: group.id });
    await first.stop();
    const second = await serve(world);
    expect(await second.list()).toMatchObject({
      terminals: [],
      groups: [{ id: group.id, name: "servers", terminals: [] }],
    });
  });
});
