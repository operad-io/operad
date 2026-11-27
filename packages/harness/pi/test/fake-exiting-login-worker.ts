/**
 * A fake login child that asks for a key and then ends without an answer, as a
 * crashed pi login does. It ends when the test answers the request it makes to
 * the address in `<home>/exit-url`, with that answer as its reason on stderr.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

function write(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const start = JSON.parse(process.argv[2] ?? "{}") as { home: string };
const url = readFileSync(join(start.home, "exit-url"), "utf8");

createInterface({ input: process.stdin }).once("line", () => {
  write({ type: "prompt", id: 1, prompt: { type: "secret", message: "Enter openai API key" } });
  void fetch(url).then(async (response) => {
    process.stderr.write(`${await response.text()}\n`, () => process.exit(1));
  });
});
write({ type: "providers", providers: [{ id: "openai", name: "OpenAI", apiKey: { name: "OpenAI API key" } }] });
