/** Opens `$EDITOR` on a task's editable brief body. */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DevError } from "./model.ts";

export interface EditorOptions {
  /** A directory the temporary file lives under. */
  readonly root: string;
  readonly editor?: string | undefined;
}

function quote(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

/** Runs the editor on `text` and returns what the person saved. */
export async function editText(
  text: string,
  options: EditorOptions,
): Promise<string> {
  const editor = options.editor ?? process.env.EDITOR ?? process.env.VISUAL;
  if (editor === undefined || editor.trim().length === 0) {
    throw new DevError("EDITOR", "no editor is set; set $EDITOR");
  }

  const directory = await mkdtemp(join(options.root, "dev-edit-"));
  const file = join(directory, "brief.md");
  await writeFile(file, text, "utf8");
  try {
    const child = Bun.spawn({
      cmd: ["/bin/sh", "-c", `${editor} "$1"`, "sh", file],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    if (code !== 0) {
      throw new DevError(
        "EDITOR",
        `${quote(editor)} exited with code ${code}`,
      );
    }
    return await readFile(file, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
