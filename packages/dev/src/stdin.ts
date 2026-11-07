/** Reads the text a command takes on standard input. */
export async function readStdinText(input?: string): Promise<string> {
  if (input !== undefined) return input;
  const stdin = process.stdin;
  // A terminal has no piped request: an empty text is the only safe answer.
  if (stdin.isTTY === true) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin as AsyncIterable<Uint8Array | string>) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}
