/**
 * Everything a server sends is text to draw, never a command to the terminal.
 * One function turns the control characters of such text into U+FFFD, so an
 * escape sequence in a log line or a title cannot move the cursor, change a
 * colour, write the clipboard or fake the screen's own styles.
 */

// C0 controls except \t (0x09) and \n (0x0a), DEL, and the C1 controls. ESC,
// BEL, \r and the 8-bit CSI/OSC introducers are all in here.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** The replacement a control character gets: visible, one column wide. */
export const CONTROL_REPLACEMENT = "�";

/** `text` with every control character replaced; `\n` and `\t` are kept. */
export function sanitize(text: string): string {
  return text.replace(CONTROL, CONTROL_REPLACEMENT);
}
