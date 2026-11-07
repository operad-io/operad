/**
 * The paragraph a prompt run gets when it continues after a question a person
 * answered. Every harness adds the same one, so a flow behaves alike whichever
 * harness runs it.
 */

/** The fixed paragraph; `{prompt}` and `{answer}` are filled in. */
export const ASK_NOTE_TEMPLATE = "You asked: {prompt}. The answer is: {answer}. Continue.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The words of an answer: the choice, with the note after it when there is one. */
function answerText(choice: unknown, note: unknown): string | undefined {
  const parts = [choice, note].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length === 0 ? undefined : parts.join(" - ");
}

/**
 * The note for the `askAnswer` a step's params carry, or undefined when the
 * params carry none.
 */
export function askNote(askAnswer: unknown): string | undefined {
  if (!isRecord(askAnswer) || typeof askAnswer.prompt !== "string") return undefined;
  const answer = answerText(askAnswer.choice, askAnswer.note);
  if (answer === undefined) return undefined;
  const prompt = askAnswer.prompt;
  // One pass, so text in the prompt or the answer is never read as a placeholder.
  return ASK_NOTE_TEMPLATE.replace(/\{(prompt|answer)\}/g, (_, name: string) =>
    name === "prompt" ? prompt : answer,
  );
}
