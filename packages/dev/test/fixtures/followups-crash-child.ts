/**
 * Collects a plan's follow-up and kills itself after the follow-up task was
 * proposed and before its tasks were marked. The parent proves a later call
 * proposes nothing more.
 */

import { SqlitePluginStore } from "@operad-io/engine";
import { collectFollowups, followupTestHooks } from "../../src/followups.ts";
import { validateDevSettings } from "../../src/settings.ts";

const [storeRoot, name] = process.argv.slice(2);
if (storeRoot === undefined || name === undefined) {
  throw new Error("usage: followups-crash-child <store> <repository>");
}

const store = new SqlitePluginStore({ root: storeRoot });
followupTestHooks.afterPropose = () => {
  process.kill(process.pid, "SIGKILL");
};
await collectFollowups(store, name, validateDevSettings({}));
