import { SUPERVISED_ENV } from "../src/code-reload.ts";

/**
 * The environment for a child process a test starts. A test run from inside a
 * supervised serve carries the supervisor's flag; the child it starts must not
 * think it is supervised because of that.
 */
export function testEnv(
  extra: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env[SUPERVISED_ENV];
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}
