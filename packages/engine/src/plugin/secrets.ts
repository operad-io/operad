/**
 * Secrets live outside the fact log: one 0600 JSON file per plugin in a 0700
 * directory under the operad home. A value only leaves as a `Secret`, so the
 * log's existing refusal still protects it.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Secret } from "../log/secret.ts";
import type { SecretStore } from "./types.ts";
import { isRecord } from "../util.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The directory that holds every plugin's secret file. */
export function secretsDirectory(home: string): string {
  return join(home, "secrets");
}

/** The file one plugin's secrets live in. */
export function secretsPathFor(home: string, plugin: string): string {
  return join(secretsDirectory(home), `${plugin}.json`);
}

function assertName(value: string, kind: string): string {
  if (!NAME.test(value)) {
    throw new Error(`${kind} "${value}": must be letters, digits, dot, dash or underscore`);
  }
  return value;
}

/** One plugin's secrets. A missing file means the plugin has none. */
export class FileSecretStore implements SecretStore {
  readonly #home: string;
  readonly #plugin: string;

  constructor(options: { readonly home: string; readonly plugin: string }) {
    this.#home = options.home;
    this.#plugin = assertName(options.plugin, "plugin");
  }

  async get(name: string): Promise<Secret<string> | undefined> {
    assertName(name, "secret");
    const values = await this.#read();
    const value = values[name];
    return typeof value === "string" ? new Secret(value) : undefined;
  }

  async set(name: string, value: string | Secret<string>): Promise<void> {
    assertName(name, "secret");
    const text = value instanceof Secret ? value.reveal() : value;
    if (typeof text !== "string") {
      throw new TypeError(`secret "${name}": value must be a string`);
    }
    const values = await this.#read();
    values[name] = text;
    await this.#write(values);
  }

  async delete(name: string): Promise<void> {
    assertName(name, "secret");
    const values = await this.#read();
    if (!(name in values)) return;
    delete values[name];
    await this.#write(values);
  }

  async names(): Promise<readonly string[]> {
    return Object.keys(await this.#read()).sort();
  }

  async #read(): Promise<Record<string, string>> {
    const path = secretsPathFor(this.#home, this.#plugin);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {};
      }
      throw new Error(`secrets for plugin "${this.#plugin}": cannot read: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`secrets for plugin "${this.#plugin}": the file is not valid JSON`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`secrets for plugin "${this.#plugin}": the file must hold an object`);
    }
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") values[name] = value;
    }
    return values;
  }

  async #write(values: Record<string, string>): Promise<void> {
    const directory = secretsDirectory(this.#home);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = secretsPathFor(this.#home, this.#plugin);
    if (Object.keys(values).length === 0) {
      try {
        await unlink(path);
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
      return;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, {
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new Error(
        `secrets for plugin "${this.#plugin}": cannot write: ${String(error)}`,
      );
    }
  }
}
