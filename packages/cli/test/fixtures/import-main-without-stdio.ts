/**
 * Imports the CLI with process.stdout and process.stderr unreadable, the way
 * Bun's stale epoll registration made the stream's creation fail under
 * `bun test --isolate` (oven-sh/bun#37968). This stands in for the failure
 * deterministically: the upstream issue is Linux-only and has no standalone
 * reproduction, so the test does not wait for the real collision.
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
