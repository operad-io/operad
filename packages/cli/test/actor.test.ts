import { describe, expect, test } from "bun:test";
import { actorOfCli } from "../src/main.ts";

describe("the CLI's actor", () => {
  test("is the user name, and `cli` when the name is empty so the action is not refused", () => {
    expect(actorOfCli("hai")).toEqual({ via: "cli", id: "hai" });
    expect(actorOfCli("")).toEqual({ via: "cli", id: "cli" });
  });
});
