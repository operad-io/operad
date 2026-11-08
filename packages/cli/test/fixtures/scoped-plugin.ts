import { basename } from "node:path";
import { definePlugin } from "../../../engine/src/index.ts";

/**
 * A plugin whose bare ids are scoped by the directory a command runs in, as
 * dev scopes tasks to the repository of the current directory: inside a
 * directory named `repo-a` a bare id means `a/<id>`; anywhere else the plugin
 * does not claim it and the kernel's suffix lookup runs.
 */
export default definePlugin({
  name: "scopedtest",
  kind: "domain",
  version: "0.0.1",
  objects: [
    {
      name: "task",
      resolve(ctx, _type, id) {
        return basename(ctx.cwd) === "repo-a" ? `a/${id}` : undefined;
      },
    },
  ],
  views: {
    task: {
      row: (object) => ({
        id: object.id,
        title: String(object.data.title ?? ""),
        state: "new",
      }),
      sections: () => [],
      load: () => ({ markdown: "" }),
    },
  },
});
