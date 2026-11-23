// A stand-in answerer: reads the case input on stdin and answers from its memory text.
if (process.argv.includes("--fail")) process.exit(3);
const input: unknown = JSON.parse(await Bun.stdin.text());
const question =
  typeof input === "object" && input !== null && "question" in input ? String((input as { question: unknown }).question) : "";
process.stdout.write(question.includes("code") ? "The code is the blue heron." : "I do not know.");
export {};
