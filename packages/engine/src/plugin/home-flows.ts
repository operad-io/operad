/**
 * Flows a person keeps in the operad home: each `<home>/flows/<name>.flow.ts`
 * whose default export is a `defineFlow` value is one flow named
 * `home:<name>`. It is loaded and validated like a plugin's flow, against the
 * steps of every loaded plugin. A file that does not load is refused with its
 * reason and the others still load.
 */

import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFlow } from "../flow/load.ts";
import type { FlowDefinition, StepTypeRegistry } from "../flow/types.ts";
import { messageOf } from "./errors.ts";

/** The prefix every flow of the home carries. */
export const HOME_FLOW_PREFIX = "home:";

/** What the owner of a home flow is called in `flows()`. */
export const HOME_FLOW_OWNER = "home";

const SUFFIX = ".flow.ts";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One flow file that loaded. */
export interface HomeFlow {
  readonly file: string;
  readonly flow: FlowDefinition;
}

/** One flow file that was refused, with the reason. The message names the file. */
export interface HomeFlowRefusal {
  readonly file: string;
  readonly message: string;
}

export interface HomeFlows {
  readonly flows: readonly HomeFlow[];
  readonly refused: readonly HomeFlowRefusal[];
}

/** The package directory of the running engine. */
const ENGINE_DIRECTORY = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));

/**
 * Makes `import { defineFlow } from "@operad-io/engine"` work in a flow file of
 * the home. The home is outside any package, so plain resolution from the file
 * finds nothing (or, with auto-install, a copy of another version). The home
 * gets `node_modules/@operad-io/engine`, a link to the engine the running
 * operad is made of, so a file imports the same code operad runs, from a
 * global install or from a source checkout alike. A link that points elsewhere
 * (the install moved or was upgraded) is renewed; a real directory the person
 * put there is left alone. A process that starts at the same time and wins the
 * race to write the link leaves the same link, so the loser has nothing to do.
 */
export function linkEngineIntoHome(home: string): void {
  const scope = join(home, "node_modules", "@operad-io");
  const link = join(scope, "engine");
  try {
    if (!lstatSync(link).isSymbolicLink() || realpathSync(link) === ENGINE_DIRECTORY) return;
  } catch {
    // Absent or dangling: written below.
  }
  try {
    mkdirSync(scope, { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(ENGINE_DIRECTORY, link, "dir");
  } catch {
    // A home that cannot be written: the import then fails, and the refusal names the file.
  }
}

/** The directory of the home's flows. */
export function homeFlowsDirectory(home: string): string {
  return join(home, "flows");
}

/** Reads every flow file of the home. A missing directory holds no flows. */
export async function loadHomeFlows(
  home: string,
  registry: StepTypeRegistry,
  taken: (name: string) => boolean = () => false,
): Promise<HomeFlows> {
  const directory = homeFlowsDirectory(home);
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(SUFFIX))
      .sort();
  } catch {
    return { flows: [], refused: [] };
  }
  linkEngineIntoHome(home);
  const flows: HomeFlow[] = [];
  const refused: HomeFlowRefusal[] = [];
  for (const entry of names) {
    const path = join(directory, entry);
    const file = basename(path);
    const short = entry.slice(0, -SUFFIX.length);
    const name = `${HOME_FLOW_PREFIX}${short}`;
    if (!NAME.test(short)) {
      refused.push({
        file,
        message: `home flow file "${path}": the name "${short}" may use letters, digits, ".", "_" and "-" and must start with a letter or digit`,
      });
      continue;
    }
    if (taken(name)) {
      refused.push({ file, message: `home flow file "${path}": flow "${name}" is already declared` });
      continue;
    }
    try {
      const loaded = await loadFlow(path, registry);
      flows.push({ file, flow: { ...loaded, name } });
    } catch (error) {
      const message = messageOf(error);
      refused.push({
        file,
        message: message.includes(path) ? message : `home flow file "${path}": ${message}`,
      });
    }
  }
  return { flows, refused };
}
