/**
 * The memory plugin: the shared wiki and the bot's memory. It owns the wiki
 * directory setting, the `memory` skill every bot mounts, and the commit that
 * records what a reply wrote. The wiki is also read-only objects for the apps:
 * its folders and notes, projected from the Markdown directory.
 */

import pkg from "../package.json" with { type: "json" };
import { definePlugin, type JsonValue, type ObjectStore } from "@operad-io/engine";
import { watchDirectory } from "@operad-io/engine/platform";
import { MEMORY_SETTINGS, ensureWiki, wikiDirectory } from "./memory.ts";
import { runMemoryCommit } from "./commit.ts";
import { openMemorySearch } from "./search/service.ts";
import { runMemoryRead, runMemorySearch } from "./search/command.ts";
import { botMemoryDirectories } from "./search/sources.ts";
import {
  WIKI_FOLDER_TYPE,
  WIKI_NOTE_TYPE,
  resolveWikiFolderId,
  resolveWikiNoteId,
  syncWikiObjects,
  wikiFolderViews,
  wikiNoteViews,
} from "./wiki.ts";

const WIKI_FILTERS = [
  { name: "live", states: ["open"], default: true },
  { name: "removed", states: ["removed"] },
] as const;

/** The one scan both wiki types share, so a read does not rebuild it twice. */
function prepareWiki(
  store: ObjectStore,
  home: string,
  settings: Readonly<Record<string, JsonValue>>,
): Promise<void> {
  return syncWikiObjects(store, home, settings);
}

/**
 * A wiki path is claimed only when the wiki holds it, so a bare id that names
 * another plugin's object (a task such as `T-0597-...`) is not made ambiguous
 * by a folder or note that does not exist.
 */
async function claimIfStored(
  store: ObjectStore,
  type: string,
  path: string | undefined,
): Promise<string | undefined> {
  if (path === undefined) return undefined;
  return (await store.get(type, path)) === undefined ? undefined : path;
}

/** Builds the memory plugin. */
export function createMemoryPlugin() {
  return definePlugin({
    name: "memory",
    kind: "domain",
    // The version comes from package.json so the two cannot drift apart.
    version: pkg.version,
    settings: MEMORY_SETTINGS,
    objects: [
      {
        name: WIKI_FOLDER_TYPE,
        filters: WIKI_FILTERS,
        resolve: (ctx, type, id) => claimIfStored(ctx.store, type, resolveWikiFolderId(id)),
        // This scan writes the notes too, so only one type declares it.
        prepare: ({ store, home, settings }) => prepareWiki(store, home, settings),
      },
      {
        name: WIKI_NOTE_TYPE,
        filters: WIKI_FILTERS,
        resolve: (ctx, type, id) => claimIfStored(ctx.store, type, resolveWikiNoteId(id)),
      },
    ],
    steps: [{ name: "commit", results: ["done", "failed"], run: runMemoryCommit }],
    commands: [
      { name: "search", args: "[--scope <scope>] [--field <name>=<value>] [--limit <n>] <query>", run: runMemorySearch },
      { name: "read", args: "<id> [from] [to] [--json]", run: runMemoryRead },
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
        pending = syncWikiObjects(ctx.store, ctx.home, ctx.settings, search)
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
    views: {
      [WIKI_FOLDER_TYPE]: wikiFolderViews,
      [WIKI_NOTE_TYPE]: wikiNoteViews,
    },
  });
}

export default createMemoryPlugin();

export * from "./memory.ts";
export * from "./commit.ts";
export * from "./tidy.ts";
export * from "./search/types.ts";
export * from "./search/backend.ts";
export * from "./search/service.ts";
export * from "./search/frontmatter.ts";
export * from "./search/chunks.ts";
export * from "./links.ts";
export * from "./link-report.ts";
export * from "./search/sources.ts";
export * from "./search/command.ts";
export * from "./wiki.ts";
