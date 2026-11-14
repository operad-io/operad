/**
 * Runs one CLI command with process.stdout, process.stderr and process.stdin
 * unreadable. Reading any of them fails, as Bun's stale epoll registration did
 * under `bun test --isolate` (oven-sh/bun#37968).
 */
const home = process.argv[2] ?? "";
const tty = process.argv[3] === "tty";
const argv = process.argv.slice(4);
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
let out = "";
let err = "";
try {
  const { main } = await import("../../src/main.ts");
  code = await main(argv, {
    home,
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        err += text;
      },
    },
    ...(tty ? { isTTY: true } : {}),
  });
} catch (error) {
  failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  for (const name of ["stdin", "stdout", "stderr"] as const) {
    const descriptor = saved[name];
    if (descriptor !== undefined) Object.defineProperty(process, name, descriptor);
  }
}

process.stdout.write(`${JSON.stringify({ code, out, err, touched, failure })}\n`);
