/**
 * Runs `secret set` with stdin reported as a terminal and with process.stdin,
 * process.stdout and process.stderr unreadable. A caller that injects its io
 * without readLine must stop before it reads those streams.
 */
import { expect, mock, test } from "bun:test";

const home = process.env["OPERAD_TEST_SECRET_HOME"] ?? "";

test("secret set with terminal stdin does not read process.stdin", async () => {
  mock.module("node:tty", () => ({
    isatty: (fd: number) => fd === 0,
  }));
  const saved = {
    stdin: Object.getOwnPropertyDescriptor(process, "stdin"),
    stdout: Object.getOwnPropertyDescriptor(process, "stdout"),
    stderr: Object.getOwnPropertyDescriptor(process, "stderr"),
  };
  let touched: string | undefined;
  for (const name of ["stdin", "stdout", "stderr"] as const) {
    Object.defineProperty(process, name, {
      configurable: true,
      get() {
        touched = name;
        throw new Error(`read process.${name}`);
      },
    });
  }

  let code: number | undefined;
  let failure: string | undefined;
  let err = "";
  try {
    const { main } = await import("../../src/main.ts");
    code = await main(["secret", "set", "notes", "token"], {
      home,
      io: {
        write: () => undefined,
        error: (text) => {
          err += text;
        },
      },
    });
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    for (const name of ["stdin", "stdout", "stderr"] as const) {
      const descriptor = saved[name];
      if (descriptor !== undefined) Object.defineProperty(process, name, descriptor);
    }
  }

  expect(failure).toBeUndefined();
  expect(touched).toBeUndefined();
  expect(code).toBe(2);
  expect(err).toContain("secret set: no value was read");
});
