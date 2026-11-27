import { describe, expect, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import { replayOf } from "../src/index.ts";

function terminal() {
  const screen = new headless.Terminal({ cols: 20, rows: 8, allowProposedApi: true });
  const serializer = new SerializeAddon();
  screen.loadAddon(serializer as unknown as Parameters<typeof screen.loadAddon>[0]);
  const write = (data: string) => new Promise<void>((resolve) => screen.write(data, resolve));
  const lines = () =>
    Array.from({ length: screen.rows }, (_, row) =>
      screen.buffer.active.getLine(screen.buffer.active.baseY + row)?.translateToString(true) ?? "",
    );
  const cursor = () => [screen.buffer.active.cursorX, screen.buffer.active.cursorY];
  return { screen, serializer, write, lines, cursor };
}

/** What a program set up, then what it draws after a client joined. */
async function joined(setUp: string, after: string) {
  const first = terminal();
  await first.write(setUp);
  const second = terminal();
  await second.write(replayOf(first.screen, first.serializer));
  expect(second.cursor()).toEqual(first.cursor());
  await first.write(after);
  await second.write(after);
  expect(second.lines()).toEqual(first.lines());
  expect(second.cursor()).toEqual(first.cursor());
  return { first, second };
}

const hidden = (screen: object): boolean =>
  (screen as { _core: { coreService: { isCursorHidden: boolean } } })._core.coreService.isCursorHidden;

const rows = "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8";

describe("a replayed screen", () => {
  test("keeps the cursor hidden, and only when it was", async () => {
    const away = await joined("shown\u001b[?25l", "");
    expect(hidden(away.second.screen)).toBe(true);
    const back = await joined("shown\u001b[?25l\u001b[?25h", "");
    expect(hidden(back.second.screen)).toBe(false);
  });

  test("scrolls the same lines, with the cursor where it was", async () => {
    // Lines 2 to 5 scroll; the line feeds at the bottom of them move those only.
    await joined(`${rows}\u001b[2;5r\u001b[5;3H`, "\r\n\r\nnew");
    await joined(`\u001b[?1049h${rows}\u001b[2;5r\u001b[3;4H`, "x\r\n\r\n\r\nnew");
  });

  test("keeps the cursor where it was when rows count from the lines that scroll", async () => {
    await joined(`${rows}\u001b[3;6r\u001b[?6h\u001b[2;3H`, "x\u001b[1;1Hy");
  });
});
