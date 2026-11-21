import { definePlugin } from "@operad-io/engine";

/** A plugin whose name is also a kernel verb. */
export default definePlugin({
  name: "settings",
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
