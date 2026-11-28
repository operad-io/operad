// Each shipped harness has a setup guide (ADR 0022 D14): the one a person reads
// when its agent is not on the machine, over the command line and the plugin
// list `serve` gives its clients.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeHome } from "@operad-io/engine/testing";
import { operad } from "@operad-io/test-support";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { openContext, pluginAdminFor } from "../../src/main.ts";

const HARNESSES = ["claude", "codex", "pi", "radian"] as const;

// No agent of the machine that runs the tests is found.
const machinePath = process.env.PATH;
let emptyPath = "";
beforeAll(async () => {
  emptyPath = await tempRoot();
  process.env.PATH = emptyPath;
});
afterAll(async () => {
  process.env.PATH = machinePath;
  await cleanupTempRoots();
});

/** A home with chat, bot and the harnesses, each on or off. */
async function homeWith(enabled: boolean): Promise<string> {
  const made = await makeHome({
    plugins: {
      chat: { module: "@operad-io/chat", enabled: true },
      bot: { module: "@operad-io/bot", enabled: true },
      ...Object.fromEntries(
        HARNESSES.map((name) => [name, { module: `@operad-io/harness-${name}`, enabled }]),
      ),
    },
    extra: { http: { enabled: false } },
  });
  return made.home;
}

/** The plugin rows and setup answers `serve` gives over HTTP. */
async function adminAnswers(home: string) {
  const context = await openContext(home, { write: () => undefined, error: () => undefined });
  try {
    const admin = pluginAdminFor(context);
    const rows = await admin.list();
    return await Promise.all(
      HARNESSES.map(async (name) => ({
        name,
        guide: rows.find((row) => row.name === name)?.guide,
        setup: await admin.setup?.(name),
      })),
    );
  } finally {
    context.views.close();
    await context.log.close();
  }
}

describe("a harness's setup guide", () => {
  test("a harness whose agent is missing shows a guide and the missing item `agent`", async () => {
    const home = await homeWith(true);
    for (const { name, guide, setup } of await adminAnswers(home)) {
      expect({ name, guide, enabled: setup?.enabled }).toEqual({ name, guide: true, enabled: true });
      expect(setup?.missing.map((item) => item.name)).toEqual(["agent"]);
    }
  });

  test("a harness that is off shows its guide with the item `enable`", async () => {
    const home = await homeWith(false);
    for (const { name, setup } of await adminAnswers(home)) {
      expect({ name, missing: setup?.missing.map((item) => item.name) }).toEqual({ name, missing: ["enable"] });
    }
  });

  test("`operad bot setup` answers the steps for the bot's agent", async () => {
    const home = await homeWith(true);
    for (const name of HARNESSES) {
      const steps = await operad(home, ["bot", "setup", "default", name], { env: { PATH: emptyPath } });
      expect({ name, code: steps.code, err: steps.err }).toEqual({ name, code: 0, err: "" });
      expect(steps.out).toContain("- agent: ");
      expect(steps.out).toContain(`and the arguments \`default\` and \`${name}\``);
    }
  });

  test("each guide has a step for every item and its package ships it", () => {
    for (const name of HARNESSES) {
      const directory = fileURLToPath(new URL(`../../../harness/${name}/`, import.meta.url));
      const guide = readFileSync(join(directory, "skills", "setup", "SKILL.md"), "utf8");
      for (const item of ["enable", "agent", "check"]) expect(guide).toContain(`\n- \`${item}\` (`);
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { files: string[] };
      expect(manifest.files).toContain("skills");
    }
  });
});
