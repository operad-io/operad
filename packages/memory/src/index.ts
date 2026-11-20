/**
 * The memory plugin: the shared wiki and the bot's memory. It owns the wiki
 * directory setting, the `memory` skill every bot mounts, and the commit that
 * records what a reply wrote. It declares no objects: what a bot wrote stays a
 * file a person sees in the memory directory or the wiki.
 */

import pkg from "../package.json" with { type: "json" };
import { definePlugin } from "@operad-io/engine";
import { MEMORY_SETTINGS, ensureWiki } from "./memory.ts";
import { runMemoryCommit } from "./commit.ts";

/** Builds the memory plugin. */
export function createMemoryPlugin() {
  return definePlugin({
    name: "memory",
    kind: "domain",
    // The version comes from package.json so the two cannot drift apart.
    version: pkg.version,
    settings: MEMORY_SETTINGS,
    steps: [{ name: "commit", results: ["done", "failed"], run: runMemoryCommit }],
    // The wiki is there before the first bot needs it; a directory that is
    // already a git repository is used as it is.
    start: async (ctx) => {
      ensureWiki(ctx.home, ctx.settings);
      return { stop: () => undefined };
    },
  });
}

export default createMemoryPlugin();

export * from "./memory.ts";
export * from "./commit.ts";
export * from "./tidy.ts";
