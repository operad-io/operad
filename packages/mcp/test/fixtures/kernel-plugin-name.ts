import { definePlugin } from "../../../engine/src/index.ts";

/** A plugin whose name is also a kernel command. */
export default definePlugin({
  name: "serve",
  kind: "domain",
  version: "0.0.1",
  commands: [
    {
      name: "start",
      args: "<text>",
      run(_ctx, argv) {
        return `plugin start: ${argv.join(" ")}`;
      },
    },
  ],
});
