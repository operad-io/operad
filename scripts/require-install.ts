// Test preload (bunfig.toml): a stale install stops `bun test` with one line.
import { dirname } from "node:path";
import { requireFreshInstall } from "./check-install.ts";

requireFreshInstall(dirname(import.meta.dir));
