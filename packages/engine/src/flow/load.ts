import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlowDefinition, StepTypeRegistry } from "./types.ts";
import { FlowError, validateFlow } from "./validate.ts";
import { messageOf } from "../plugin/errors.ts";

let loadCount = 0;

/**
 * Imports a TypeScript module whose default export is a `defineFlow` value and
 * validates it. The file is named in every error that comes from the import.
 */
export async function loadFlow(
  path: string,
  registry: StepTypeRegistry = [],
): Promise<FlowDefinition> {
  const absolute = resolve(path);
  const url = pathToFileURL(absolute);
  loadCount += 1;
  url.searchParams.set("operad-load", String(loadCount));

  let module: Record<string, unknown>;
  try {
    module = (await import(url.href)) as Record<string, unknown>;
  } catch (error) {
    throw new FlowError(`flow file "${path}": import failed: ${messageOf(error)}`, { cause: error });
  }

  const exported = module.default;
  if (exported === undefined) {
    throw new FlowError(`flow file "${path}": no default export`);
  }
  try {
    return validateFlow(exported, registry);
  } catch (error) {
    if (error instanceof FlowError) {
      throw new FlowError(`flow file "${path}": ${error.message}`, { cause: error });
    }
    throw error;
  }
}
