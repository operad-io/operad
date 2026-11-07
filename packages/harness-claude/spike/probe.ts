/**
 * Zero-token probe, run by hand: `bun packages/harness-claude/spike/probe.ts`.
 *
 * It starts the Agent SDK client against the user's own `claude` binary with
 * the isolation the harness uses (no setting sources, manual permissions, a
 * `canUseTool` that logs and denies), reads `initializationResult()` and
 * `accountInfo()` and closes. No prompt is sent, so no model request is made.
 * It prints versions and the login kind; it never prints an e-mail, a token or
 * any credential, and it does not read a credentials file itself.
 */

import { realpathSync } from "node:fs";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class ClaudeNotFoundError extends Error {
  constructor() {
    super(
      "no `claude` command was found on PATH; install claude first (https://code.claude.com), then run the probe again",
    );
    this.name = "ClaudeNotFoundError";
  }
}

/** The real path of `claude` on PATH. */
export function findClaude(path: string | undefined = process.env.PATH): string {
  const found = Bun.which("claude", { PATH: path ?? "" });
  if (found === null) throw new ClaudeNotFoundError();
  return realpathSync(found);
}

/** What the probe reports; nothing in it is a secret. */
export interface ProbeReport {
  readonly claudePath: string;
  readonly claudeCodeVersion: string | undefined;
  readonly sdkVersion: string;
  readonly apiProvider: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly apiKeySource: string | undefined;
  readonly tokenSource: string | undefined;
  readonly deniedCalls: number;
}

export async function probe(path: string | undefined = process.env.PATH): Promise<ProbeReport> {
  const claudePath = findClaude(path);
  let denied = 0;
  // An input stream that never yields: the session starts but no prompt is sent.
  let end: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    end = resolve;
  });
  async function* noPrompt(): AsyncGenerator<SDKUserMessage, void> {
    await closed;
  }

  const session = query({
    prompt: noPrompt(),
    options: {
      pathToClaudeCodeExecutable: claudePath,
      settingSources: [],
      permissionMode: "default",
      permissionPrompts: "host",
      canUseTool: async (toolName) => {
        denied += 1;
        process.stderr.write(`canUseTool ${toolName}: denied\n`);
        return { behavior: "deny", message: "the probe allows no tool" };
      },
    },
  });
  try {
    const init = await session.initializationResult();
    const account = await session.accountInfo();
    const sdkManifest: unknown = await Bun.file(
      new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url),
    ).json();
    const sdkVersion =
      typeof sdkManifest === "object" && sdkManifest !== null && "version" in sdkManifest
        ? String(sdkManifest.version)
        : "unknown";
    return {
      claudePath,
      claudeCodeVersion: init.claude_code_version,
      sdkVersion,
      apiProvider: account.apiProvider,
      subscriptionType: account.subscriptionType,
      apiKeySource: account.apiKeySource,
      tokenSource: account.tokenSource,
      deniedCalls: denied,
    };
  } finally {
    end();
    session.close();
  }
}

if (import.meta.main) {
  try {
    const report = await probe();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
