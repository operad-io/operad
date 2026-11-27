/**
 * `operad bot login` prints the command its login question carries, alone on
 * its own line, and does not wait when no question can come.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  openConfigLog,
  readConfig,
  recordAnswer,
  serveLockPath,
  type AskTimer,
} from "@operad-io/engine";
import { main } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { LOGIN_FIXTURE_COMMAND } from "./fixtures/login-harness.ts";

afterAll(cleanupTempRoots);

const chatPath = fileURLToPath(new URL("../../chat/src/index.ts", import.meta.url));
const botPath = fileURLToPath(new URL("../../bot/src/index.ts", import.meta.url));
const harnessPath = fileURLToPath(new URL("./fixtures/login-harness.ts", import.meta.url));

/** A timer that never fires, so a command that should not wait hangs if it does. */
const never: AskTimer = () => () => undefined;

async function loginHome(): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [chatPath, botPath, harnessPath],
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  return home;
}

/** Starts `operad bot login default`; `said` resolves once the action has answered. */
function login(home: string, timer: AskTimer) {
  let out = "";
  let heard: () => void = () => undefined;
  const said = new Promise<void>((resolve) => {
    heard = resolve;
  });
  const done = main(["bot", "login", "default"], {
    home,
    isTTY: false,
    loginTimer: timer,
    io: {
      write: (text) => {
        out += text;
        heard();
      },
      error: () => undefined,
    },
  });
  return { said, done, text: () => out };
}

async function loginRun(home: string): Promise<string> {
  const log = openConfigLog(await readConfig(home));
  try {
    const run = (await log.runs({ object: "bot:default" })).at(-1);
    if (run === undefined) throw new Error("no login run");
    return run.runId;
  } finally {
    await log.close();
  }
}

/** Runs the login as `serve` would. */
function drive(home: string, runId: string): Promise<number> {
  return main(["run-internal", runId], {
    home,
    io: { write: () => undefined, error: () => undefined },
  });
}

const shown = `  waiting: Log in?\n    ${LOGIN_FIXTURE_COMMAND}\n`;

describe("operad bot login", () => {
  test("waits for the question serve asks and prints its command on its own line", async () => {
    const home = await loginHome();
    const serve = acquireLock(serveLockPath(home));
    try {
      const first = login(home, never);
      await first.said;
      const runId = await loginRun(home);
      const run = drive(home, runId);
      expect(await first.done).toBe(0);
      expect(first.text()).toBe(`logging in\n${shown}`);

      // Asked again while the question is open: the same command.
      const second = login(home, never);
      expect(await second.done).toBe(0);
      expect(second.text()).toBe(`logging in\n${shown}`);

      const log = openConfigLog(await readConfig(home));
      try {
        await recordAnswer({ log, runId, choice: "a", actor: { via: "cli", id: "me" } });
      } finally {
        await log.close();
      }
      expect(await run).toBe(0);
    } finally {
      serve.release();
    }
  }, 30_000);

  test("does not wait when no serve is running", async () => {
    const home = await loginHome();
    const command = login(home, never);
    expect(await command.done).toBe(0);
    expect(command.text()).toStartWith("logging in\n");
    expect(command.text()).not.toContain(LOGIN_FIXTURE_COMMAND);
  }, 30_000);

  test("stops waiting when the login ends without a question", async () => {
    const home = await loginHome();
    writeFileSync(join(home, "login-fails"), "");
    const serve = acquireLock(serveLockPath(home));
    try {
      const command = login(home, never);
      await command.said;
      await drive(home, await loginRun(home));
      expect(await command.done).toBe(0);
      expect(command.text()).toBe("logging in\n");
    } finally {
      serve.release();
    }
  }, 30_000);

  test("stops waiting after 30 seconds without a question", async () => {
    const home = await loginHome();
    const serve = acquireLock(serveLockPath(home));
    let delay = 0;
    let fire: () => void = () => undefined;
    let armed: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      armed = resolve;
    });
    try {
      const command = login(home, (ms, expire) => {
        delay = ms;
        fire = expire;
        armed();
        return () => undefined;
      });
      await waiting;
      fire();
      expect(await command.done).toBe(0);
      expect(delay).toBe(30_000);
      expect(command.text()).toBe("logging in\n");
    } finally {
      serve.release();
    }
  }, 30_000);
});
