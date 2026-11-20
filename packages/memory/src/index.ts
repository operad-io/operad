/**
 * The memory plugin: the shared wiki and the bot's memory. It owns the wiki
 * directory setting, the `memory` skill every bot mounts, and the commit that
 * records what a reply wrote. It declares no objects: what a bot wrote stays a
 * file a person sees in the memory directory or the wiki.
 */

import pkg from "../package.json" with { type: "json" };
import { definePlugin } from "@operad-io/engine";
import { watchDirectory } from "@operad-io/engine/platform";
import { MEMORY_SETTINGS, ensureWiki, wikiDirectory } from "./memory.ts";
import { runMemoryCommit } from "./commit.ts";
import { openMemorySearch } from "./search/service.ts";
import { runMemoryRead, runMemorySearch } from "./search/command.ts";
import { botMemoryDirectories } from "./search/sources.ts";

/** Builds the memory plugin. */
export function createMemoryPlugin() {
  return definePlugin({
    name: "memory",
    kind: "domain",
    // The version comes from package.json so the two cannot drift apart.
    version: pkg.version,
    settings: MEMORY_SETTINGS,
    steps: [{ name: "commit", results: ["done", "failed"], run: runMemoryCommit }],
    commands: [
      { name: "search", args: "[--scope <scope>] [--field <name>=<value>] [--limit <n>] <query>", run: runMemorySearch },
      { name: "read", args: "<id> [from] [to]", run: runMemoryRead },
    ],
    // The wiki is there before the first bot needs it; a directory that is
    // already a git repository is used as it is. The index is brought up to
    // date once, then a directory watch and the store's change listener make
    // changes visible to a long-running server. A search refreshes too, so a
    // change this process did not see is never missed.
    start: async (ctx) => {
      ensureWiki(ctx.home, ctx.settings);
      const search = openMemorySearch(ctx.home, ctx.settings);
      let stopped = false;
      let pending: Promise<void> | undefined;
      const refresh = (): void => {
        if (stopped || pending !== undefined) return;
        pending = search
          .refresh(ctx.store)
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            pending = undefined;
          });
      };
      void refresh();
      const stops: (() => void)[] = [];
      const watch = (directory: string): void => {
        stops.push(watchDirectory(directory, () => refresh()));
      };
      watch(wikiDirectory(ctx.home, ctx.settings));
      for (const memory of botMemoryDirectories(ctx.home)) watch(memory);
      const unsubscribe = ctx.store.subscribe(() => refresh());
      return {
        stop: () => {
          stopped = true;
          for (const stop of stops) stop();
          unsubscribe();
          search.close();
        },
      };
    },
  });
}

export default createMemoryPlugin();

export * from "./memory.ts";
export * from "./commit.ts";
export * from "./search/types.ts";
export * from "./search/backend.ts";
export * from "./search/service.ts";
export * from "./search/frontmatter.ts";
export * from "./search/chunks.ts";
export * from "./search/sources.ts";
export * from "./search/command.ts";
