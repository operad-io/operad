import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { makeHome } from "@operad-io/engine/testing";
import { cleanupTempRoots } from "../../engine/test/plugin/support.ts";
import { main, type CliIo } from "../src/main.ts";

afterAll(cleanupTempRoots);

const notesPath = fileURLToPath(
  new URL("../../engine/test/fixtures/plugins/notes.ts", import.meta.url),
);

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

function lines(text: string): readonly string[] {
  return text.trim().split("\n").filter((line) => line.length > 0);
}

describe("a command line mistake", () => {
  test("an unknown command names the closest command, then points at --help", async () => {
    const { home } = await makeHome();
    const output = capture();
    expect(await main(["pendng"], { home, io: output.io })).toBe(2);
    expect(output.errors()).toContain('unknown command "pendng"');
    expect(output.errors()).toContain("closest:");
    expect(output.errors()).toContain("pending");
    expect(output.errors()).toContain("run `operad --help` for all commands");
    expect(output.errors()).not.toContain("usage: operad <command> [options]");
    expect(lines(output.errors()).length).toBeLessThanOrEqual(5);
    expect(output.text()).toBe("");
  });

  test("a missing argument prints the command's one-line usage", async () => {
    const { home } = await makeHome();
    const output = capture();
    expect(await main(["list"], { home, io: output.io })).toBe(2);
    expect(output.errors()).toContain("list needs an object type");
    expect(output.errors()).toContain("usage: operad list <type> [options]");
    expect(output.errors()).toContain("run `operad --help` for all commands");
    expect(output.errors()).not.toContain("usage: operad <command> [options]");
    expect(lines(output.errors()).length).toBeLessThanOrEqual(5);
  });

  test("a missing subcommand prints that command's one-line usage", async () => {
    const { home } = await makeHome();
    const output = capture();
    expect(await main(["plugin"], { home, io: output.io })).toBe(2);
    expect(output.errors()).toContain(
      "plugin needs list, enable, disable or check",
    );
    expect(output.errors()).toContain(
      "usage: operad plugin <list|add|enable|disable|check>",
    );
    expect(output.errors()).not.toContain("usage: operad <command> [options]");
    expect(lines(output.errors()).length).toBeLessThanOrEqual(5);
  });

  test("version is short and names the way to print it", async () => {
    const { home } = await makeHome();
    const output = capture();
    expect(await main(["version"], { home, io: output.io })).toBe(2);
    expect(output.errors()).toContain('unknown command "version"');
    expect(output.errors()).toContain("closest:");
    expect(output.errors()).toContain("--version");
    expect(output.errors()).toContain("run `operad --help` for all commands");
    expect(output.errors()).not.toContain("usage: operad <command> [options]");
    expect(lines(output.errors()).length).toBeLessThanOrEqual(5);
  });

  test("a mistyped plugin command names the command it declares", async () => {
    const { home } = await makeHome({ plugins: [notesPath] });
    const output = capture();
    expect(await main(["ads"], { home, io: output.io })).toBe(2);
    expect(output.errors()).toContain('unknown command "ads"');
    expect(output.errors()).toContain("closest:");
    expect(output.errors()).toContain("add");
    expect(lines(output.errors()).length).toBeLessThanOrEqual(5);
  });
});
