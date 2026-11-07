import { definePlugin } from "../../../engine/src/index.ts";

/** A plugin whose command name is also a kernel command. */
export default definePlugin({
  name: "echo",
  kind: "domain",
  version: "0.0.1",
  commands: [
    {
      name: "show",
      args: "<text>",
      run(_ctx, argv) {
        return `plugin show: ${argv.join(" ")}`;
      },
    },
  ],
});
