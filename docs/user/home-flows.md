---
description: Your own flows in the home, written as one file each, without a plugin.
---

# Flows in the home

A flow does not have to come from a plugin. A file `<home>/flows/<name>.flow.ts` whose default export is a `defineFlow` value is a flow named `home:<name>`. It can call the steps of every plugin that is loaded.

For example, `~/.operad/flows/nightly.flow.ts` is the flow `home:nightly`:

```ts
import { defineFlow } from "@operad-io/engine";

export default defineFlow({
  name: "nightly",
  entry: "run",
  steps: [
    {
      id: "run",
      kind: "plugin",
      params: { use: "shell/command", params: { line: "date" } },
      replay: "safe",
      next: { pass: "end_done", fail: "end_failed", interrupted: "end_failed" },
    },
    { id: "end_done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "end_failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});
```

Import `defineFlow` from `@operad-io/engine`, as above: it is the same engine operad itself runs, whether operad was installed globally or runs from a source checkout. To make that work operad keeps a link at `<home>/node_modules/@operad-io/engine` and renews it when the install moves; a real folder you put there is left alone. Other `@operad-io` packages are not linked. A step of a plugin is named by its string, `"<plugin>/<step>"`, and needs no import.

The name the file gives inside `defineFlow` does not matter; the file name does. A file name uses letters, digits, `.`, `_` and `-`, and starts with a letter or digit.

## Using them

- `operad flows` lists them with the plugin column `home`.
- `operad routines add --flow home:nightly --schedule "0 3 * * *"` starts one on a schedule.

- `operad routines to-flow <id>` turns a routine that runs one command into such a file, ready to edit, and points the routine at it.

## Loading

The files load when operad starts, and `serve` reloads when a file in `<home>/flows` changes, as it does for a plugin's code (see [cli](cli.md)). A file that does not load is refused: the reason names the file and goes to the error output. The other files, and `serve`, are not affected. A name another flow already uses is refused the same way.
