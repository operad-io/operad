#!/usr/bin/env bun
import { EXIT_CLOSED_PIPE, main, outputWasClosed } from "../src/main.ts";

const code = await main(process.argv.slice(2));
process.exitCode = code;
// A write to a closed pipe can fail after main returned; look again as the
// process ends. A status other than 0 (a failure, a reload) is kept.
process.on("exit", () => {
  if (code === 0 && outputWasClosed()) process.exitCode = EXIT_CLOSED_PIPE;
});
