/** Writing a config file, for a test only. */

import { mkdir, writeFile } from "node:fs/promises";
import { configJson, configPath, type OperadConfig } from "../config/config.ts";

/** Writes a config file, replacing it atomically enough for one command. */
export async function writeConfig(
  home: string,
  config: OperadConfig,
): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(
    configPath(home),
    `${JSON.stringify(configJson(config), null, 2)}\n`,
  );
}
