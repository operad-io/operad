import { describe, expect, test } from "bun:test";
import { answerGrant, grantUse, hasGrants } from "../src/grants.ts";

describe("hasGrants", () => {
  test("is true only for a profile with at least one grant", () => {
    expect(hasGrants({ grants: [{ waitId: "w1" }] })).toBe(true);
    expect(hasGrants({ grants: [] })).toBe(false);
    expect(hasGrants({ denyCommands: ["rm"] })).toBe(false);
    expect(hasGrants({ grants: "w1" })).toBe(false);
    expect(hasGrants(undefined)).toBe(false);
    expect(hasGrants(null)).toBe(false);
    expect(hasGrants([{ waitId: "w1" }])).toBe(false);
  });
});

describe("grantUse", () => {
  test("reads a grant_use line and nothing else", () => {
    expect(grantUse('{"type":"grant_use","id":3,"waitId":"w9"}')).toEqual({ id: 3, waitId: "w9" });
    expect(grantUse('{"type":"result","note":"grant_use"}')).toBeUndefined();
    expect(grantUse('{"type":"grant_use","id":"3","waitId":"w9"}')).toBeUndefined();
    expect(grantUse('{"type":"grant_use","id":3}')).toBeUndefined();
    expect(grantUse('"grant_use"')).toBeUndefined();
    expect(grantUse("grant_use but not json")).toBeUndefined();
    expect(grantUse('{"type":"message_end"}')).toBeUndefined();
  });
});

describe("answerGrant", () => {
  const line = '{"type":"grant_use","id":2,"waitId":"w1"}';

  async function answer(useGrant: (waitId: string) => Promise<boolean>, text = line): Promise<string[]> {
    const sent: string[] = [];
    await answerGrant(text, useGrant, (reply) => sent.push(reply));
    return sent;
  }

  test("asks the host for the wait id and replies used true when it used the grant", async () => {
    const asked: string[] = [];
    const sent = await answer(async (waitId) => {
      asked.push(waitId);
      return true;
    });
    expect(asked).toEqual(["w1"]);
    expect(sent.map((text) => JSON.parse(text))).toEqual([{ type: "grant_ack", id: 2, used: true }]);
  });

  test("replies used false when the host did not use it", async () => {
    const sent = await answer(async () => false);
    expect(sent.map((text) => JSON.parse(text))).toEqual([{ type: "grant_ack", id: 2, used: false }]);
  });

  test("replies used false when the host throws", async () => {
    const sent = await answer(async () => {
      throw new Error("the store is gone");
    });
    expect(sent.map((text) => JSON.parse(text))).toEqual([{ type: "grant_ack", id: 2, used: false }]);
  });

  test("leaves any other line alone: no question, no reply", async () => {
    let asked = false;
    const sent = await answer(async () => {
      asked = true;
      return true;
    }, '{"type":"message_end"}');
    expect(asked).toBe(false);
    expect(sent).toEqual([]);
  });
});
