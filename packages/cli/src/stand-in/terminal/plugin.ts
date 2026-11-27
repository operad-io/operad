/**
 * What loads as `terminal` while its package is not installed (ADR 0040 D1):
 * it runs nothing, its check says it is not set up and it carries the guide.
 */

import { definePlugin, ENGINE_VERSION } from "@operad-io/engine";
import { fileURLToPath } from "node:url";

const NOT_INSTALLED =
  "the terminal package is not installed; `operad serve` installs it when it starts, or run `operad plugin enable terminal`";

export default definePlugin({
  name: "terminal",
  kind: "domain",
  version: ENGINE_VERSION,
  check() {
    return { note: `not set up: ${NOT_INSTALLED}`, missing: [{ name: "install", description: NOT_INSTALLED }] };
  },
  guide: fileURLToPath(new URL("./SKILL.md", import.meta.url)),
});
