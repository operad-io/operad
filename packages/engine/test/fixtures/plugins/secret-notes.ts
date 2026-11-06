import { definePlugin } from "../../../src/index.ts";

/**
 * Reads a plugin secret inside a step and records only whether it was there
 * and whether any value in the process environment equals it.
 */
export default definePlugin({
  name: "secret-notes",
  kind: "domain",
  version: "0.0.1",
  steps: [
    {
      name: "use",
      results: ["ok"],
      async run(ctx) {
        const secret = await ctx.secrets.get("token");
        const value = secret?.reveal();
        const leakedInEnv =
          value === undefined
            ? false
            : Object.values(process.env).some((item) => item === value);
        await ctx.facts.append({
          type: "secret_used",
          data: { present: secret !== undefined, leakedInEnv },
        });
        return { result: "ok" };
      },
    },
  ],
});
