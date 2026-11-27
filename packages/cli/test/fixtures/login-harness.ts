/**
 * A harness whose login asks one question carrying a command, or fails before
 * any question when the home holds a file named `login-fails`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, type PluginStepResult } from "../../../engine/src/index.ts";

export const LOGIN_FIXTURE_COMMAND = "'/home/a b/.bin/tool' auth login some-provider";

export default definePlugin({
  name: "login",
  kind: "harness",
  version: "0.0.0",
  capabilities: { accessLevels: ["ask", "full"] },
  models: { list: ["login/a"], default: "login/a" },
  efforts: { list: [], default: null },
  signedIn: async () => false,
  steps: [
    {
      name: "login",
      results: ["done", "failed"],
      async run(ctx): Promise<PluginStepResult> {
        if (existsSync(join(ctx.home, "login-fails"))) return { result: "failed" };
        await ctx.ask({
          prompt: "Log in?",
          command: LOGIN_FIXTURE_COMMAND,
          choices: ["a"],
          onTimeout: "reject_once",
        });
        return { result: "failed" };
      },
    },
  ],
});
