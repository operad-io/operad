/**
 * Zero-token probe for the Claude Agent SDK under Bun.
 *
 * Run it with `bun packages/harness-claude/spike/probe.ts`. It starts the
 * user's `claude` binary through the SDK, reads the initialization reply and
 * the account information, and never sends a prompt: the prompt stream stays
 * open without yielding a message. Tools are denied, not run.
 *
 * It prints only version, model, and account-source labels. It never prints a
 * credential, an email address, a session id, or anything under `~/.claude`.
 */
import { realpathSync } from "node:fs";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const DENY_MESSAGE = "operad spike: every tool call is denied";

function fail(message: string): never {
  console.error(`probe: ${message}`);
  process.exit(1);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A prompt stream that stays open and sends nothing, so no model request happens. */
async function* silentPrompt(): AsyncIterable<SDKUserMessage> {
  await new Promise<void>(() => {});
}

const onPath = Bun.which("claude");
if (onPath === null) {
  fail("no `claude` on PATH; install Claude Code or put its binary on PATH");
}

let executable: string;
try {
  executable = realpathSync(onPath);
} catch (error) {
  fail(`the \`claude\` on PATH (${onPath}) cannot be resolved: ${describeError(error)}`);
}

const denied: string[] = [];
const session = query({
  prompt: silentPrompt(),
  options: {
    pathToClaudeCodeExecutable: executable,
    settingSources: [],
    permissionMode: "default",
    canUseTool: async (toolName, input) => {
      denied.push(toolName);
      console.error(`probe: denied ${toolName} ${JSON.stringify(input)}`);
      return { behavior: "deny", message: DENY_MESSAGE };
    },
  },
});

try {
  const initialization = await session.initializationResult();
  const account = await session.accountInfo();
  console.log(
    JSON.stringify(
      {
        claudeCodeVersion: initialization.claude_code_version ?? null,
        models: initialization.models.length,
        account: {
          subscriptionType: account.subscriptionType ?? null,
          apiProvider: account.apiProvider ?? null,
          apiKeySource: account.apiKeySource ?? null,
          tokenSource: account.tokenSource ?? null,
        },
        deniedToolCalls: denied.length,
        tokenRequestsSent: 0,
      },
      null,
      2,
    ),
  );
} catch (error) {
  fail(`the initialization probe failed: ${describeError(error)}`);
} finally {
  session.close();
}
