import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileSecretStore, readHttpToken } from "@operad-io/engine";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { decode, matrixFromRender } from "./qr-decode.ts";

afterAll(cleanupTempRoots);

/** A fixed token: a test never prints a real one. */
const TOKEN = "test-token-0123456789_abcdefghijklmnopqrstuvwxyz";

interface Output {
  readonly io: CliIo;
  text(): string;
  errors(): string;
}

function capture(): Output {
  let out = "";
  let err = "";
  return {
    io: {
      write: (text) => {
        out += text;
      },
      error: (text) => {
        err += text;
      },
    },
    text: () => out,
    errors: () => err,
  };
}

async function makeHome(http: Record<string, unknown>): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [],
      store: { backend: "jsonl", path: join(root, "store") },
      http,
    }),
  );
  await new FileSecretStore({ home, plugin: "http" }).set("token", TOKEN);
  return home;
}

const LAN = { enabled: true, port: 7480, listen: ["127.0.0.1", "192.168.1.20"] };

describe("operad pair", () => {
  test("prints the url, the token and a QR code that decodes to the pairing link", async () => {
    const home = await makeHome(LAN);
    const output = capture();
    expect(await main(["pair"], { home, io: output.io, isTTY: true })).toBe(0);
    const text = output.text();
    expect(text).toContain("url http://192.168.1.20:7480\n");
    expect(text).toContain(`token ${TOKEN}\n`);

    const decoded = decode(matrixFromRender(text));
    expect(decoded.text).toBe(
      `operad://pair?url=${encodeURIComponent("http://192.168.1.20:7480")}&token=${TOKEN}`,
    );
  });

  test("--url names the address, such as a Tailscale HTTPS name", async () => {
    const home = await makeHome({ enabled: true, port: 7480, listen: ["127.0.0.1"] });
    const output = capture();
    expect(
      await main(["pair", "--url", "https://mac.tail1234.ts.net/"], {
        home,
        io: output.io,
        isTTY: true,
      }),
    ).toBe(0);
    expect(output.text()).toContain("url https://mac.tail1234.ts.net\n");
    expect(decode(matrixFromRender(output.text())).text).toBe(
      `operad://pair?url=${encodeURIComponent("https://mac.tail1234.ts.net")}&token=${TOKEN}`,
    );
  });

  test("an IPv6 listen address is bracketed in the url", async () => {
    const home = await makeHome({ enabled: true, port: 9000, listen: ["fd7a:115c:a1e0::1"] });
    const output = capture();
    expect(await main(["pair"], { home, io: output.io, isTTY: true })).toBe(0);
    expect(output.text()).toContain("url http://[fd7a:115c:a1e0::1]:9000\n");
  });

  test("refuses without a terminal and prints nothing of the token", async () => {
    const home = await makeHome(LAN);
    const output = capture();
    expect(await main(["pair"], { home, io: output.io, isTTY: false })).toBe(2);
    expect(output.text()).toBe("");
    expect(output.errors()).toContain("--show-token");
    expect(output.errors()).not.toContain(TOKEN);
  });

  test("--show-token prints url, token and link without a terminal, and no QR", async () => {
    const home = await makeHome(LAN);
    const output = capture();
    expect(
      await main(["pair", "--show-token"], { home, io: output.io, isTTY: false }),
    ).toBe(0);
    expect(output.text()).toBe(
      [
        "url http://192.168.1.20:7480",
        `token ${TOKEN}`,
        `link operad://pair?url=${encodeURIComponent("http://192.168.1.20:7480")}&token=${TOKEN}`,
        "",
      ].join("\n"),
    );
  });

  test("no other command prints the token", async () => {
    const home = await makeHome(LAN);
    for (const argv of [["http", "token", "rotate"], ["plugin", "list"], ["pending"]]) {
      const output = capture();
      await main(argv, { home, io: output.io, isTTY: true });
      expect(output.text() + output.errors()).not.toContain(TOKEN);
    }
    expect((await readHttpToken(home))?.token).not.toBe(TOKEN);
  });

  test("refuses when http is off, when only loopback is listened on, and a bad --url", async () => {
    const off = capture();
    const offHome = await makeHome({ enabled: false, port: 7480, listen: ["192.168.1.20"] });
    expect(await main(["pair"], { home: offHome, io: off.io, isTTY: true })).toBe(2);
    expect(off.errors()).toContain("http.enabled");

    const loop = capture();
    const loopHome = await makeHome({ enabled: true, port: 7480, listen: ["127.0.0.1"] });
    expect(await main(["pair"], { home: loopHome, io: loop.io, isTTY: true })).toBe(2);
    expect(loop.errors()).toContain("--url");

    for (const bad of ["not a url", "ftp://host", "http://user:pw@host", "http://host?x=1"]) {
      const output = capture();
      expect(
        await main(["pair", "--url", bad], { home: loopHome, io: output.io, isTTY: true }),
      ).toBe(2);
      expect(output.errors()).not.toContain(TOKEN);
      expect(output.text()).toBe("");
    }
  });
});
