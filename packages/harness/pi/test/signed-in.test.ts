/**
 * The pi harness's `signedIn`: an answer from pi's auth file, for the provider
 * it will use; absent when the file cannot be read. No credential field is
 * read or returned.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempRoots, tempRoot } from "../../process/test/support.ts";
import { createPiHarnessPlugin } from "../src/index.ts";

afterAll(cleanupTempRoots);

function authFile(root: string, name = "auth.json"): string {
  return join(root, name);
}

describe("pi's signedIn answer", () => {
  test("is true when the auth file holds a credential for the model's provider", async () => {
    const root = await tempRoot();
    const authPath = authFile(root);
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "a-secret" } }));
    const plugin = createPiHarnessPlugin({ piSettingsPath: join(root, "settings.json") });
    expect(await plugin.signedIn?.({ authPath, model: "anthropic/claude" })).toBe(true);
  });

  test("is false when the credential is for another provider", async () => {
    const root = await tempRoot();
    const authPath = authFile(root);
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "a-secret" } }));
    const plugin = createPiHarnessPlugin({ piSettingsPath: join(root, "settings.json") });
    expect(await plugin.signedIn?.({ authPath, model: "anthropic/claude" })).toBe(false);
  });

  test("falls back to pi's default provider", async () => {
    const root = await tempRoot();
    const authPath = authFile(root);
    const settingsPath = join(root, "settings.json");
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "a-secret" } }));
    writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "anthropic" }));
    const plugin = createPiHarnessPlugin({ piSettingsPath: settingsPath });
    expect(await plugin.signedIn?.({ authPath })).toBe(false);
    expect(await plugin.signedIn?.({ authPath, model: "openai/gpt" })).toBe(true);
  });

  test("counts any stored credential when no provider is known", async () => {
    const root = await tempRoot();
    const authPath = authFile(root);
    writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "a-secret" } }));
    const plugin = createPiHarnessPlugin({ piSettingsPath: join(root, "settings.json") });
    expect(await plugin.signedIn?.({ authPath })).toBe(true);
  });

  test("is absent when the file cannot be read, and false when it is missing", async () => {
    const root = await tempRoot();
    const malformed = authFile(root, "malformed.json");
    writeFileSync(malformed, "not json");
    const notAnObject = authFile(root, "array.json");
    writeFileSync(notAnObject, "[]");
    const plugin = createPiHarnessPlugin({ piSettingsPath: join(root, "settings.json") });
    expect(await plugin.signedIn?.({ authPath: malformed })).toBeUndefined();
    expect(await plugin.signedIn?.({ authPath: notAnObject })).toBeUndefined();
    expect(await plugin.signedIn?.({ authPath: join(root, "absent.json") })).toBe(false);
  });
});
