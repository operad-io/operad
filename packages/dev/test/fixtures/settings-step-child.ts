/**
 * A stand-in for a running step in its own process: it reads the repository's
 * settings when the step starts, says so, waits for the parent's go, then reads
 * them again as the next step would and reports both reads.
 */

import { readDevSettings } from "../../src/settings.ts";

const [repository] = process.argv.slice(2);
if (repository === undefined) throw new Error("usage: settings-step-child <repository>");

const first = await readDevSettings(repository);
process.stdout.write(`started ${JSON.stringify(first.gate.commands)}\n`);

for await (const chunk of Bun.stdin.stream()) {
  if (new TextDecoder().decode(chunk).includes("go")) break;
}
const second = await readDevSettings(repository);
process.stdout.write(`finished ${JSON.stringify(second.gate.commands)}\n`);
