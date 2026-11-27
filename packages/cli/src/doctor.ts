/**
 * `operad doctor`: one read-only pass over a home. It asks an environment for
 * each fact and turns the answers into one line per fact; every problem line
 * ends with the next command to type. The environment is a parameter so a test
 * supplies the facts and nothing touches the machine or the network.
 */

import {
  ConfigError,
  missingAddressMessage,
  noListenAddressMessage,
} from "@operad-io/engine";

/** One plugin the home enables. */
export interface DoctorPlugin {
  readonly name: string;
  readonly loaded: boolean;
  /** Why it did not load. */
  readonly problem?: string | undefined;
}

/** One enabled agent (harness plugin). */
export interface DoctorAgent {
  readonly name: string;
  readonly version?: string | undefined;
  /** `undefined` when the agent cannot say. */
  readonly signedIn?: boolean | undefined;
  /** The bot whose agent this is, when operad's own login covers the agent. */
  readonly loginBot?: string | undefined;
  /** Why the agent cannot be used, when it cannot. */
  readonly problem?: string | undefined;
}

/** What `operad pending` reports as a setup problem. */
export interface DoctorSetupItem {
  readonly id: string;
  readonly prompt: string;
}

export interface DoctorEnv {
  /** Whether the home directory exists. */
  homeExists(): boolean;
  /** Whether `config.json` exists; throws with the reason when it is invalid. */
  config(): Promise<{ readonly present: boolean }>;
  plugins(): Promise<readonly DoctorPlugin[]>;
  agents(): Promise<readonly DoctorAgent[]>;
  /** `silent`: addresses this machine has where a serve that answers elsewhere does not. */
  serve(): Promise<{ readonly answering: boolean; readonly silent?: readonly string[] }>;
  /** The configured listen addresses this machine has and lacks; absent means the check is not made. */
  listenAddresses?(): Promise<{
    readonly present: readonly string[];
    readonly missing: readonly string[];
  }>;
  /** The test host when one is set; `undefined` when none is. */
  testHost(): Promise<{ readonly host: string; readonly reachable: boolean } | undefined>;
  setup(): Promise<readonly DoctorSetupItem[]>;
  /** Whether the git program is installed; absent means the check is not made. */
  gitInstalled?(): boolean;
}

export interface DoctorCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly message: string;
  /** The command to type next; present on every problem. */
  readonly next?: string | undefined;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

/**
 * The agent's own command that signs in, for an agent operad's login does not
 * cover. Each was checked against that agent's `--help`.
 */
const SIGN_IN: Readonly<Record<string, string>> = {
  claude: "claude auth login",
  codex: "codex login",
  pi: "pi auth login <provider>",
  radian: "radian login",
};

function good(id: string, message: string): DoctorCheck {
  return { id, ok: true, message };
}

function bad(id: string, message: string, next: string): DoctorCheck {
  return { id, ok: false, message, next };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function silentAddressMessage(address: string): string {
  return `${address} is on this machine but serve does not answer there; restart serve if the address came back after serve started`;
}

/** Runs every check once. It never throws: a failed ask is a problem line. */
export async function runDoctor(env: DoctorEnv): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  let loadable = false;
  if (!env.homeExists()) {
    checks.push(bad("home", "the operad home does not exist", "operad init"));
  } else {
    try {
      const config = await env.config();
      if (config.present) {
        checks.push(good("home", "home and config.json are valid"));
        loadable = true;
      } else {
        checks.push(bad("home", "the home has no config.json", "operad init"));
      }
    } catch (error) {
      checks.push(
        bad(
          "home",
          `config.json is not valid: ${reasonOf(error)}`,
          "operad doctor",
        ),
      );
    }
  }

  if (loadable) {
    try {
      for (const plugin of await env.plugins()) {
        checks.push(
          plugin.loaded
            ? good(`plugin:${plugin.name}`, `plugin ${plugin.name} is loaded`)
            : bad(
                `plugin:${plugin.name}`,
                `plugin ${plugin.name} did not load: ${plugin.problem ?? "no reason given"}`,
                `operad plugin disable ${plugin.name}`,
              ),
        );
      }
      const agents = await env.agents();
      for (const agent of agents) {
        const id = `agent:${agent.name}`;
        const version = agent.version === undefined ? "" : ` ${agent.version}`;
        if (agent.problem !== undefined) {
          checks.push(
            bad(id, `agent ${agent.name} cannot be used: ${agent.problem}`, "operad init"),
          );
        } else if (agent.signedIn === false) {
          checks.push(
            bad(
              id,
              `agent ${agent.name}${version} is not signed in`,
              agent.loginBot === undefined
                ? (SIGN_IN[agent.name] ?? `sign in to ${agent.name}, then operad doctor`)
                : `operad bot:login ${agent.loginBot}`,
            ),
          );
        } else {
          checks.push(
            good(
              id,
              `agent ${agent.name}${version}${agent.signedIn === true ? ", signed in" : ""}`,
            ),
          );
        }
      }
      if (agents.length === 0) {
        checks.push(bad("agents", "no agent is enabled", "operad plugin enable pi"));
      }
    } catch (error) {
      checks.push(bad("plugins", `plugins could not be read: ${reasonOf(error)}`, "operad doctor"));
    }
  }

  let silent: readonly string[] = [];
  try {
    const serve = await env.serve();
    silent = serve.silent ?? [];
    checks.push(
      serve.answering
        ? good("serve", "serve is answering")
        : bad("serve", "serve is not answering", "operad serve"),
    );
  } catch (error) {
    checks.push(bad("serve", `serve could not be checked: ${reasonOf(error)}`, "operad serve"));
  }

  if (loadable && env.listenAddresses !== undefined) {
    try {
      const { present, missing } = await env.listenAddresses();
      if (present.length > 0) {
        // Not a problem: serve works on the other addresses.
        for (const address of missing) {
          checks.push(good(`listen:${address}`, missingAddressMessage(address)));
        }
      } else if (missing.length > 0) {
        checks.push(bad("listen", noListenAddressMessage(missing), "operad serve"));
      }
      // Not a problem either: what serve bound can differ from what the machine has now.
      for (const address of silent) {
        checks.push(good(`listen:${address}`, silentAddressMessage(address)));
      }
    } catch (error) {
      checks.push(
        bad(
          "listen",
          // A refused entry's reason already names `http.listen`.
          error instanceof ConfigError
            ? error.message
            : `http.listen could not be checked: ${reasonOf(error)}`,
          "operad doctor",
        ),
      );
    }
  }

  // Not a problem: chat and file changes work without git, which only a task needs.
  if (env.gitInstalled !== undefined && !env.gitInstalled()) {
    checks.push(good("git", "git is not installed: chat works without it, and a task needs it"));
  }

  if (loadable) {
    try {
      const host = await env.testHost();
      if (host !== undefined) {
        checks.push(
          host.reachable
            ? good("test-host", `test host ${host.host} is reachable`)
            : bad("test-host", `test host ${host.host} is not reachable`, `ssh ${host.host}`),
        );
      }
      for (const item of await env.setup()) {
        // A standing item that already names a command: that is the next step.
        const named = /`([^`]+)`/.exec(item.prompt)?.[1];
        checks.push(
          named === undefined
            ? bad(`setup:${item.id}`, item.prompt, "operad pending")
            : { id: `setup:${item.id}`, ok: false, message: item.prompt, next: named },
        );
      }
    } catch (error) {
      checks.push(bad("setup", `setup could not be read: ${reasonOf(error)}`, "operad pending"));
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

/** The lines `operad doctor` prints: `ok` or `problem`, then the fact and, for a problem, what to type. */
export function formatDoctor(report: DoctorReport): string {
  const lines = report.checks.map((check) => {
    if (check.ok) return `ok       ${check.message}`;
    const next = check.next === undefined ? "" : ` -> ${check.next}`;
    return `problem  ${check.message}${next}`;
  });
  return `${lines.join("\n")}\n`;
}
