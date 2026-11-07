/**
 * Minimal pi session ported from `examples/sdk/01-minimal.ts` and
 * `examples/sdk/11-sessions.ts` with the settings from decision 3 of
 * `docs/backlog/operad-harness-pi.md`: an explicit resource loader that loads
 * nothing from `~/.pi`, in-memory settings, a temporary `agentDir`, session
 * files in a temporary directory, and a `ModelRuntime` whose auth and model
 * files are temporary.
 */

import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = [
  "You are a spike assistant inside a test.",
  "Use the read tool when the prompt asks you to read a file.",
  "Be brief.",
].join("\n");

/** A resource loader that discovers nothing on disk. */
export function emptyResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export interface SpikeRuntimeOptions {
  authPath: string;
  modelsPath: string;
}

export async function createSpikeModelRuntime(options: SpikeRuntimeOptions): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: options.authPath,
    modelsPath: options.modelsPath,
    refreshOnCreate: false,
  });
}

export interface SpikeSessionOptions {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  sessionManager: SessionManager;
  tools?: string[];
}

export async function createSpikeSession(options: SpikeSessionOptions): Promise<AgentSession> {
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    model: options.model,
    thinkingLevel: "off",
    modelRuntime: options.modelRuntime,
    resourceLoader: emptyResourceLoader(),
    tools: options.tools ?? ["read"],
    sessionManager: options.sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  });
  return session;
}

/** A new persistent session in an explicit directory. */
export function newFileSession(cwd: string, sessionDir: string): SessionManager {
  return SessionManager.create(cwd, sessionDir);
}

/** Reopen an existing session file. */
export function openFileSession(path: string, sessionDir: string): SessionManager {
  return SessionManager.open(path, sessionDir);
}
