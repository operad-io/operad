import { fileURLToPath } from "node:url";
import { definePlugin } from "../../../src/index.ts";

/** A plugin that ships a setup guide and a check that reports two missing items. */
export default definePlugin({
  name: "guided",
  kind: "domain",
  version: "0.0.1",
  guide: fileURLToPath(new URL("./guided/SKILL.md", import.meta.url)),
  check: () => ({
    note: "not set up",
    missing: [
      { name: "token", description: "no token is stored" },
      { name: "user", description: "no user is listed" },
    ],
  }),
});
