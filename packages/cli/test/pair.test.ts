import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FileSecretStore, readHttpToken } from "@operad-io/engine";
import { makeHome } from "@operad-io/engine/testing";
import { main, type CliIo } from "../src/main.ts";
import { cleanupTempRoots } from "../../engine/test/plugin/support.ts";
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

async function makePairHome(http: Record<string, unknown>): Promise<string> {
  const { home } = await makeHome({ extra: { http } });
  await new FileSecretStore({ home, plugin: "http" }).set("token", TOKEN);
  return home;
}

// 9000 is an explicit, non-default port: the test shows the config's port reaches the URL.
const LAN = { enabled: true, port: 9000, listen: ["127.0.0.1", "192.168.1.20"] };

/** The machine's interfaces as the tests suppose them, whatever it really has. */
const interfaces = () => ({
  en0: [{ address: "192.168.1.20" }],
  utun0: [{ address: "fd7a:115c:a1e0::1" }],
});

describe("operad pair", () => {
  test("prints the url, the token and a QR code that decodes to the pairing link", async () => {
    const home = await makePairHome(LAN);
    const output = capture();
    expect(await main(["pair"], { home, io: output.io, interfaces, isTTY: true })).toBe(0);
    const text = output.text();
    expect(text).toContain("url http://192.168.1.20:9000\n");
    expect(text).toContain(`token ${TOKEN}\n`);

    const decoded = decode(matrixFromRender(text));
    expect(decoded.text).toBe(
      `operad://pair?url=${encodeURIComponent("http://192.168.1.20:9000")}&token=${TOKEN}`,
    );
  });

  test("--url names the address, such as a Tailscale HTTPS name", async () => {
    const home = await makePairHome({ enabled: true, listen: ["127.0.0.1"] });
    const output = capture();
    expect(
      await main(["pair", "--url", "https://mac.tail1234.ts.net/"], {
        home,
        io: output.io,
        interfaces,
        isTTY: true,
      }),
    ).toBe(0);
    expect(output.text()).toContain("url https://mac.tail1234.ts.net\n");
    expect(decode(matrixFromRender(output.text())).text).toBe(
      `operad://pair?url=${encodeURIComponent("https://mac.tail1234.ts.net")}&token=${TOKEN}`,
    );
  });

  test("an IPv6 listen address is bracketed in the url", async () => {
    const home = await makePairHome({ enabled: true, port: 9000, listen: ["fd7a:115c:a1e0::1"] });
    const output = capture();
    expect(await main(["pair"], { home, io: output.io, interfaces, isTTY: true })).toBe(0);
    expect(output.text()).toContain("url http://[fd7a:115c:a1e0::1]:9000\n");
  });

  test("an address this machine lacks is passed over for the next one a phone can reach", async () => {
    const home = await makePairHome({
      enabled: true,
      port: 9000,
      listen: ["127.0.0.1", "100.71.164.8", "192.168.1.20"],
    });
    const output = capture();
    expect(await main(["pair"], { home, io: output.io, interfaces, isTTY: true })).toBe(0);
    expect(output.text()).toContain("url http://192.168.1.20:9000\n");
  });

  test("refuses when this machine lacks every address a phone could reach", async () => {
    const home = await makePairHome({ enabled: true, port: 9000, listen: ["127.0.0.1", "100.71.164.8"] });
    const output = capture();
    expect(await main(["pair"], { home, io: output.io, interfaces, isTTY: true })).toBe(2);
    expect(output.errors()).toContain(
      "100.71.164.8 is not on this machine now, so a phone cannot reach it; connect that network or pass --url",
    );
    expect(output.text()).toBe("");
  });

  test("an entry serve refuses is reported as refused, not as missing", async () => {
    const home = await makePairHome({ enabled: true, port: 9000, listen: ["8.8.8.8"] });
    const output = capture();
    expect(await main(["pair"], { home, io: output.io, interfaces, isTTY: true })).not.toBe(0);
    expect(output.errors()).toContain('"8.8.8.8" is not a loopback');
    expect(output.text()).toBe("");
  });

  test("refuses without a terminal and prints nothing of the token", async () => {
    const home = await makePairHome(LAN);
    const output = capture();
    expect(await main(["pair"], { home, io: output.io, interfaces, isTTY: false })).toBe(2);
    expect(output.text()).toBe("");
    expect(output.errors()).toContain("--show-token");
    expect(output.errors()).not.toContain(TOKEN);
  });

  test("--show-token prints url, token and link without a terminal, and no QR", async () => {
    const home = await makePairHome(LAN);
    const output = capture();
    expect(
      await main(["pair", "--show-token"], { home, io: output.io, interfaces, isTTY: false }),
    ).toBe(0);
    expect(output.text()).toBe(
      [
        "url http://192.168.1.20:9000",
        `token ${TOKEN}`,
        `link operad://pair?url=${encodeURIComponent("http://192.168.1.20:9000")}&token=${TOKEN}`,
        "",
      ].join("\n"),
    );
  });

  test("no other command prints the token", async () => {
    const home = await makePairHome(LAN);
    for (const argv of [["http", "token", "rotate"], ["plugin", "list"], ["pending"]]) {
      const output = capture();
      await main(argv, { home, io: output.io, interfaces, isTTY: true });
      expect(output.text() + output.errors()).not.toContain(TOKEN);
    }
    expect((await readHttpToken(home))?.token).not.toBe(TOKEN);
  });

  test("refuses when http is off, when only loopback is listened on, and a bad --url", async () => {
    const off = capture();
    const offHome = await makePairHome({ enabled: false, listen: ["192.168.1.20"] });
    expect(await main(["pair"], { home: offHome, io: off.io, interfaces, isTTY: true })).toBe(2);
    expect(off.errors()).toContain("http.enabled");

    const loop = capture();
    const loopHome = await makePairHome({ enabled: true, listen: ["127.0.0.1"] });
    expect(await main(["pair"], { home: loopHome, io: loop.io, interfaces, isTTY: true })).toBe(2);
    expect(loop.errors()).toContain("--url");

    for (const bad of ["not a url", "ftp://host", "http://user:pw@host", "http://host?x=1"]) {
      const output = capture();
      expect(
        await main(["pair", "--url", bad], { home: loopHome, io: output.io, interfaces, isTTY: true }),
      ).toBe(2);
      expect(output.errors()).not.toContain(TOKEN);
      expect(output.text()).toBe("");
    }
  });

  test("with no http section pair is on by default: loopback only, so it asks for --url", async () => {
    const home = await makePairHome({});
    // `{}` still means the defaults: enabled, 127.0.0.1, port 8765.
    const plain = capture();
    expect(await main(["pair"], { home, io: plain.io, interfaces, isTTY: true })).toBe(2);
    expect(plain.errors()).toContain("http.listen has only loopback");
    expect(plain.errors()).not.toContain("http.enabled");

    const named = capture();
    expect(
      await main(["pair", "--url", "https://mac.example.ts.net"], {
        home,
        io: named.io,
        interfaces,
        isTTY: true,
      }),
    ).toBe(0);
    expect(named.text()).toContain("https://mac.example.ts.net");
  });
});
