import { describe, expect, test } from "bun:test";
import {
  MemoryPluginStore,
  PluginRegistry,
  definePlugin,
  type TriggerEvent,
} from "@operad-io/engine";

function plugin() {
  return definePlugin({
    name: "talk",
    kind: "domain",
    version: "0.0.0",
    objects: [{ name: "room" }],
    actions: [
      {
        name: "say",
        on: "room",
        when: () => true,
        async run(ctx, args) {
          const source = (args as { source: string }).source;
          if (ctx.emit === undefined) return "no emit";
          await ctx.emit({ source, type: "said", key: "k1", object: `room:${ctx.object.id}` });
          return "sent";
        },
      },
    ],
  });
}

function registry(onEvent?: (event: TriggerEvent) => void) {
  return new PluginRegistry([plugin()], {
    home: "/tmp/operad-test-home",
    store: new MemoryPluginStore({ root: "/tmp/operad-test-store" }),
    onLog: () => undefined,
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}

const options = {
  object: { type: "room", id: "r1", data: {} },
  actor: { via: "cli", id: "me" },
} as const;

describe("ctx.emit in an action", () => {
  test("the event goes to the host with the source the action named and no hops", async () => {
    const seen: TriggerEvent[] = [];
    const run = await registry((event) => seen.push(event)).runAction("talk/say", { source: "ios" }, options);
    expect(run.value).toBe("sent");
    expect(seen).toEqual([{ source: "ios", type: "said", key: "k1", object: "room:r1", hops: 0 }]);
  });

  test("the source operad is reserved for the kernel", async () => {
    const seen: TriggerEvent[] = [];
    await expect(
      registry((event) => seen.push(event)).runAction("talk/say", { source: "operad" }, options),
    ).rejects.toThrow('source must be a name other than "operad"');
    expect(seen).toEqual([]);
  });

  test("a host that cannot route events gives the action no emit", async () => {
    const run = await registry().runAction("talk/say", { source: "ios" }, options);
    expect(run.value).toBe("no emit");
  });
});
