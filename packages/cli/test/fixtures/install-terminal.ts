// What an install of the terminal package leaves in a home.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_VERSION, pluginProjectManifestPath, pluginProjectPath } from "@operad-io/engine";

export function installTerminalElsewhere(home: string): void {
  const directory = join(pluginProjectPath(home), "node_modules", "@operad-io", "terminal");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: ENGINE_VERSION, main: "index.js" }));
  writeFileSync(join(directory, "index.js"), "");
  writeFileSync(
    pluginProjectManifestPath(home),
    JSON.stringify({ dependencies: { "@operad-io/terminal": ENGINE_VERSION } }),
  );
}
