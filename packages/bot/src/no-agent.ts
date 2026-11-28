/** The refusal when no agent is offered. */

/**
 * `otherwise` when no harness is loaded; else how to set up each loaded one
 * whose agent is not on this machine (ADR 0022 D14).
 */
export function noAgent(missing: Readonly<Record<string, string>> | undefined, otherwise: string): string {
  const setup = Object.entries(missing ?? {}).map(([name, sentence]) => `${name}: ${sentence}`);
  return setup.length === 0 ? otherwise : `no agent is set up; ${setup.join("; ")}`;
}
