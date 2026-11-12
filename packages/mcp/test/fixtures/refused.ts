import { definePlugin } from "../../../engine/src/index.ts";

/** A plugin the registry refuses: it asks for an API version this engine is not. */
export default definePlugin({
  name: "refused",
  kind: "domain",
  version: "0.0.1",
  requires: { api: "^99.0.0" },
});
