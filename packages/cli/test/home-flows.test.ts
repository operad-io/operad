import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeHome } from "@operad-io/engine/testing";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots } from "../../engine/test/plugin/support.ts";

afterAll(cleanupTempRoots);

const cronPlugin = fileURLToPath(new URL("../../source-cron/src/index.ts", import.meta.url));
const stepsPlugin = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/home-steps.ts", import.meta.url),
);
const engine = fileURLToPath(new URL("../../engine/src/index.ts", import.meta.url));

const flowText = `import { defineFlow } from ${JSON.stringify(engine)};
export default defineFlow({
  name: "whatever",
  entry: "one",
  steps: [
    { id: "one", kind: "plugin", params: { use: "home-steps/touch", params: {} }, replay: "safe", next: { ok: "end_done" } },
    { id: "end_done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});
`;

function capture(): { io: CliIo; text(): string; errors(): string } {
  let out = "";
  let err = "";
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        err += text;
      },
    },
    text: () => out,
    errors: () => err,
  };
}

async function homeWithFlows(files: Record<string, string>): Promise<string> {
  const { home } = await makeHome({ plugins: [stepsPlugin, cronPlugin] });
  await mkdir(join(home, "flows"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(home, "flows", name), text);
  }
  return home;
}

describe("flows in the home", () => {
  test("operad flows lists them and a routine can start one", async () => {
    const home = await homeWithFlows({ "tidy.flow.ts": flowText });
    const listed = capture();
    expect(await main(["flows"], { home, io: listed.io })).toBe(0);
    expect(listed.text()).toContain("home:tidy  home");

    const added = capture();
    expect(
      await main(["routines", "add", "--flow", "home:tidy", "--schedule", "0 8 * * *"], {
        home,
        io: added.io,
      }),
    ).toBe(0);
    expect(added.text()).toContain("routine home:tidy");
  });

  test("a bad file is named on the error stream and the other flows still list", async () => {
    const home = await homeWithFlows({
      "tidy.flow.ts": flowText,
      "broken.flow.ts": "export default ;",
    });
    const listed = capture();
    expect(await main(["flows"], { home, io: listed.io })).toBe(0);
    expect(listed.text()).toContain("home:tidy");
    expect(listed.text()).not.toContain("broken");
    expect(listed.errors()).toContain("broken.flow.ts");
  });

  test("a refused file is not a load problem that keeps older code", async () => {
    const home = await homeWithFlows({ "broken.flow.ts": "export default ;" });
    const checked = capture();
    expect(await main(["check-load"], { home, io: checked.io })).toBe(0);
    expect(checked.text()).not.toContain("broken.flow.ts");
  });
});
