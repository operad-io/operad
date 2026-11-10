import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../bin/operad.ts", import.meta.url));

describe("a reader that closes the pipe", () => {
  test("ends the command with status 141, no stack trace and nothing on stderr", async () => {
    // `true` exits at once, so the command's first write meets a closed
    // pipe. bash reports the command's own status, not head's.
    const child = Bun.spawn({
      cmd: [
        "bash",
        "-c",
        '"$@" | true; echo "status=${PIPESTATUS[0]}"',
        "operad",
        process.execPath,
        CLI_ENTRY,
        "help",
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(err).toBe("");
    expect(out.trim()).toBe("status=141");
  });
});
