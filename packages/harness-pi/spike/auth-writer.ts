/**
 * One writer for the deterministic auth.json locking check.
 *
 * pi 1.5.0 does not export `AuthStorage` or `FileAuthStorageBackend` from the
 * package root, so the test cannot ask pi to hold the lock. It holds the same
 * `proper-lockfile` lock on the same `auth.json` path with the options pi uses
 * (`realpath: false`, `stale: 30s`), and a second process does its write
 * through pi's own `ModelRuntime.login` path.
 *
 * Usage: bun spike/auth-writer.ts <mode> <authPath> <modelsPath> <gatePath> <providerId>
 *
 * Modes:
 *   hold           take the lock, write one credential under it, print "held",
 *                  wait for <gatePath> to appear, release, print "released"
 *   blocked-write  probe the lock with no retries; print "blocked" on ELOCKED
 *                  (or "acquired-early" when the lock is not held), then write
 *                  one credential through pi's `ModelRuntime.login`
 *   unlocked-read  read the file, print "read", wait for <gatePath>, then write
 *                  the stale snapshot plus one credential; the lost-update
 *                  control for the locking test
 *   unlocked-write read the file, add one credential, write it, print "wrote"
 */

import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { getPackageDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

interface LockfileOptions {
  realpath?: boolean;
  retries?: number;
  stale?: number;
}

interface Lockfile {
  lock(path: string, options?: LockfileOptions): Promise<() => Promise<void>>;
}

const require = createRequire(`${getPackageDir()}/package.json`);
const lockfile = require("proper-lockfile") as Lockfile;

const LOCK_OPTIONS: LockfileOptions = { realpath: false, stale: 30_000 };

interface AuthFile {
  [providerId: string]: unknown;
}

function credential(providerId: string): unknown {
  return {
    type: "oauth",
    access: `access-${providerId}`,
    refresh: `refresh-${providerId}`,
    expires: Date.now() + 3_600_000,
  };
}

function readAuth(authPath: string): AuthFile {
  if (!existsSync(authPath)) return {};
  const text = readFileSync(authPath, "utf-8");
  if (text.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("auth.json is not an object");
  }
  return parsed as AuthFile;
}

function writeAuth(authPath: string, data: AuthFile): void {
  writeFileSync(authPath, JSON.stringify(data, null, 2));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Resolve when the file exists, driven by the directory watcher, never a sleep. */
async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      // Directory events may name a different file in the same directory, so
      // the gate's existence is the event this waits for.
      if (existsSync(path)) {
        watcher.close();
        resolve();
      }
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    // Close the window between the check above and the watcher starting.
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

async function hold(authPath: string, gatePath: string, providerId: string): Promise<void> {
  const release = await lockfile.lock(authPath, LOCK_OPTIONS);
  try {
    const data = readAuth(authPath);
    data[providerId] = credential(providerId);
    writeAuth(authPath, data);
    console.log("held");
    await waitForFile(gatePath);
  } finally {
    await release();
  }
  console.log("released");
}

async function blockedWrite(authPath: string, modelsPath: string, providerId: string): Promise<void> {
  try {
    const probe = await lockfile.lock(authPath, { ...LOCK_OPTIONS, retries: 0 });
    await probe();
    console.log("acquired-early");
  } catch (error) {
    if (errorCode(error) !== "ELOCKED") throw error;
    console.log("blocked");
  }

  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    refreshOnCreate: false,
  });
  runtime.registerProvider(providerId, {
    name: providerId,
    baseUrl: "https://spike.invalid",
    oauth: {
      name: providerId,
      login: async () => ({
        refresh: `refresh-${providerId}`,
        access: `access-${providerId}`,
        expires: Date.now() + 3_600_000,
      }),
      refreshToken: async (credentials) => credentials,
      getApiKey: (credentials) => credentials.access,
    },
  });
  console.log("ready");
  await runtime.login(providerId, "oauth", {
    prompt: async () => "",
    notify: () => {},
  });
  console.log("wrote");
}

async function unlockedRead(authPath: string, gatePath: string, providerId: string): Promise<void> {
  const data = readAuth(authPath);
  console.log("read");
  await waitForFile(gatePath);
  data[providerId] = credential(providerId);
  writeAuth(authPath, data);
  console.log("wrote");
}

function unlockedWrite(authPath: string, providerId: string): void {
  const data = readAuth(authPath);
  data[providerId] = credential(providerId);
  writeAuth(authPath, data);
  console.log("wrote");
}

const [mode, authPath, modelsPath, gatePath, providerId] = process.argv.slice(2);
if (
  mode === undefined ||
  authPath === undefined ||
  modelsPath === undefined ||
  gatePath === undefined ||
  providerId === undefined
) {
  console.error(
    "usage: auth-writer.ts <hold|blocked-write|unlocked-read|unlocked-write> <authPath> <modelsPath> <gatePath> <providerId>",
  );
  process.exit(2);
}

switch (mode) {
  case "hold":
    await hold(authPath, gatePath, providerId);
    break;
  case "blocked-write":
    await blockedWrite(authPath, modelsPath, providerId);
    break;
  case "unlocked-read":
    await unlockedRead(authPath, gatePath, providerId);
    break;
  case "unlocked-write":
    unlockedWrite(authPath, providerId);
    break;
  default:
    console.error(`unknown mode: ${mode}`);
    process.exit(2);
}
