/**
 * Imports the CLI with process.stdout and process.stderr unreadable. Reading
 * either during the import fails, as Bun's stale epoll registration made the
 * stream's creation fail under `bun test --isolate` (oven-sh/bun#37968).
 */
const saved = {
  stdout: Object.getOwnPropertyDescriptor(process, "stdout"),
  stderr: Object.getOwnPropertyDescriptor(process, "stderr"),
};
let touched: string | undefined;
for (const name of ["stdout", "stderr"] as const) {
  Object.defineProperty(process, name, {
    configurable: true,
    get() {
      touched = name;
      throw new Error(`read process.${name}`);
    },
  });
}

let failure: string | undefined;
try {
  await import("../../src/main.ts");
} catch (error) {
  failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  for (const name of ["stdout", "stderr"] as const) {
    const descriptor = saved[name];
    if (descriptor !== undefined) Object.defineProperty(process, name, descriptor);
  }
}

if (touched !== undefined || failure !== undefined) {
  console.error(JSON.stringify({ touched, failure }));
  process.exitCode = 1;
} else {
  process.stdout.write("imported\n");
}
