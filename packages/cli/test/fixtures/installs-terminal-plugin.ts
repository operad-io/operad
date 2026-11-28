// A plugin whose load stands for another process installing the terminal
// package while `serve` is still loading its plugins.

import { definePlugin } from "@operad-io/engine";
import { installTerminalElsewhere } from "./install-terminal.ts";

installTerminalElsewhere(process.env.OPERAD_HOME ?? "");

export default definePlugin({ name: "installer", kind: "domain", version: "0.0.0" });
