/**
 * The addresses a login may show (ADR 0008 D8, ADR 0023 D11): only the ChatGPT
 * login is a route operad offers, and only its own authorization address and
 * the loopback callback reach a question.
 */

import { describe, expect, test } from "bun:test";
import { codexAuthUrl, loginUrl } from "../src/login-protocol.ts";

const AUTH =
  "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc";

describe("a login address", () => {
  test("the ChatGPT authorization address and a loopback callback are allowed", () => {
    expect(codexAuthUrl(AUTH)).toBe(AUTH);
    expect(loginUrl("http://127.0.0.1:1455/auth/callback")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(loginUrl("http://localhost:1455/auth/callback")).toBe("http://localhost:1455/auth/callback");
  });

  test("another host or path is not the ChatGPT login, whatever its scheme", () => {
    expect(codexAuthUrl(AUTH.replace("auth.openai.com", "evil.example"))).toBeUndefined();
    expect(codexAuthUrl(AUTH.replace("/oauth/authorize", "/oauth/other"))).toBeUndefined();
    expect(codexAuthUrl(AUTH.replace("https:", "http:"))).toBeUndefined();
    expect(codexAuthUrl(AUTH.replace("localhost%3A1455", "evil.example"))).toBeUndefined();
    expect(codexAuthUrl("not an address")).toBeUndefined();
    expect(loginUrl("javascript:alert(1)")).toBeUndefined();
    expect(loginUrl("http://example.com/auth/callback")).toBeUndefined();
  });
});
