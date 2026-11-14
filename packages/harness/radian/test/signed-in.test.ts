/**
 * The radian harness's `signedIn`: an answer from radian's credentials file;
 * absent when the file cannot be read. No credential field is read or returned.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "../../process/test/support.ts";
import { createRadianHarnessPlugin } from "../src/index.ts";

afterAll(cleanupTempRoots);

describe("radian's signedIn answer", () => {
  test("is true when the credentials file holds a credential", async () => {
    const root = await tempRoot();
    const authPath = join(root, "auth.json");
    writeFileSync(authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: "a-secret" } }));
    const plugin = createRadianHarnessPlugin({ authPath });
    expect(await plugin.signedIn?.({})).toBe(true);
  });

  test("is false when the credentials file holds none", async () => {
    const root = await tempRoot();
    const authPath = join(root, "auth.json");
    writeFileSync(authPath, "{}");
    const plugin = createRadianHarnessPlugin({ authPath });
    expect(await plugin.signedIn?.({})).toBe(false);
  });

  test("is absent when the file cannot be read, and false when it is missing", async () => {
    const root = await tempRoot();
    const malformed = join(root, "malformed.json");
    writeFileSync(malformed, "not json");
    const notAnObject = join(root, "array.json");
    writeFileSync(notAnObject, "[]");
    const plugin = createRadianHarnessPlugin({ authPath: malformed });
    expect(await plugin.signedIn?.({})).toBeUndefined();
    expect(await createRadianHarnessPlugin({ authPath: notAnObject }).signedIn?.({})).toBeUndefined();
    expect(
      await createRadianHarnessPlugin({ authPath: join(root, "absent.json") }).signedIn?.({}),
    ).toBe(false);
  });
});
