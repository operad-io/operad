/**
 * The base plugin installed with operad: it runs one command and keeps the
 * command's output in a file. The kernel never runs a command itself.
 */

import { definePlugin } from "../define-plugin.ts";

/** How much output one command may hold in memory before the log gets the rest. */
const MAX_CAPTURE = 8 * 1024 * 1024;

function param(params: unknown, key: string): unknown {
  return typeof params === "object" && params !== null && key in params
    ? (params as Record<string, unknown>)[key]
    : undefined;
}

async function capture(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    if (text.length >= MAX_CAPTURE) break;
    text += decoder.decode(chunk, { stream: true });
  }
  return `${text}${decoder.decode()}`.slice(0, MAX_CAPTURE);
}

export default definePlugin({
  name: "shell",
  kind: "harness",
  version: "0.0.0",
  steps: [
    {
      name: "command",
      results: ["ok", "failed"],
      async run(ctx, params) {
        const command = param(params, "command");
        if (typeof command !== "string" || command.trim().length === 0) {
          throw new Error(
            "shell/command: params.command: must be a non-empty string",
          );
        }

        const child = Bun.spawn(["sh", "-c", command], {
          cwd: ctx.cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
          capture(child.stdout),
          capture(child.stderr),
        ]);
        const code = await child.exited;
        const log = await ctx.logger.write(`${stdout}${stderr}`);

        if (code !== 0) {
          return {
            result: "failed",
            data: { reason: `\`${command}\` exited ${code}`, log },
          };
        }
        return { result: "ok", data: { log } };
      },
    },
  ],
  check() {
    return "ready";
  },
});
