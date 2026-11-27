/**
 * The screen as text to write into an empty terminal. The serialize addon
 * leaves out whether the cursor is hidden and which lines scroll, so a replayed
 * full-screen program would show a stray cursor or scroll the wrong lines until
 * it drew again; both are added here.
 */

import type { SerializeAddon } from "@xterm/addon-serialize";

/** The part of the pinned headless terminal that holds what its interface does not tell. */
interface ScreenCore {
  readonly coreService: {
    readonly isCursorHidden: boolean;
    readonly decPrivateModes: { readonly origin: boolean };
  };
  /** The buffer in use; the lines that scroll, counted from 0. */
  readonly buffer: {
    readonly x: number;
    readonly y: number;
    readonly scrollTop: number;
    readonly scrollBottom: number;
  };
}

export function replayOf(
  screen: { readonly rows: number },
  serializer: Pick<SerializeAddon, "serialize">,
): string {
  const { coreService, buffer } = (screen as unknown as { readonly _core: ScreenCore })._core;
  let data = serializer.serialize();
  const origin = coreService.decPrivateModes.origin;
  // Setting origin mode, as the addon does last, and setting the lines that
  // scroll both move the cursor, so it is put back after them.
  if (origin || buffer.scrollTop !== 0 || buffer.scrollBottom !== screen.rows - 1) {
    const row = buffer.y - (origin ? buffer.scrollTop : 0);
    data += `\u001b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r\u001b[${row + 1};${buffer.x + 1}H`;
  }
  if (coreService.isCursorHidden) data += "\u001b[?25l";
  return data;
}
