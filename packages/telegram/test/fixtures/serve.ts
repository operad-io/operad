/**
 * A real process for the restart test: build the world, poll the fake Bot API
 * once, say which updates it handled, and stay alive until the test kills it.
 */

import { readFileSync } from "node:fs";
import { FakeApi, createTelegramWorld, type WorldOptions } from "../support.ts";
import { TelegramSource } from "../../src/source.ts";
import type { TelegramUpdate } from "../../src/api.ts";

const root = process.env.TELEGRAM_ROOT;
const updatesPath = process.env.TELEGRAM_UPDATES;
const users = (process.env.TELEGRAM_USERS ?? "")
  .split(",")
  .map((value) => Number(value))
  .filter((value) => Number.isInteger(value) && value > 0);
if (root === undefined || updatesPath === undefined) {
  console.error("usage: TELEGRAM_ROOT=... TELEGRAM_UPDATES=... bun serve.ts");
  process.exit(2);
}

const options: WorldOptions = { root, users };
const world = await createTelegramWorld(options);
const updates = JSON.parse(readFileSync(updatesPath, "utf8")) as readonly TelegramUpdate[];
const api = new FakeApi();
api.updates = updates;
api.ignoreOffset = true;

const source = new TelegramSource(world.ctx, { api, clock: () => 1_700_000_000_000 });
await source.poll();
process.stdout.write(`processed ${updates.map((update) => update.update_id).join(",")}\n`);
// Stay alive: the test kills this process, it does not let it exit.
await new Promise<never>(() => undefined);
