import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(
  new URL("../fixtures/import-main-without-stdio.ts", import.meta.url),
);

describe("the CLI's module", () => {
  test("does not touch process.stdout or process.stderr when it is imported", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, FIXTURE],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `${out}${err}`).toBe(0);
    expect(out).toBe("imported\n");
    expect(err).toBe("");
  });
});
