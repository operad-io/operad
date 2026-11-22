/**
 * The probe of ADR 0023 D11: does `ModelRuntime.login`'s OAuth flow, with its
 * loopback callback server, work in a Bun child process? It runs offline: the
 * token exchange is intercepted, and the browser is one request to the
 * callback. When the callback port is taken, it falls back to the pasted
 * redirect URL, which is the flow's own fallback.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64");
  return `e30.${payload}.sig`;
}

const realFetch = globalThis.fetch;
let tokenCalls = 0;
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://auth.openai.com/oauth/token")) {
    tokenCalls += 1;
    return new Response(
      JSON.stringify({
        access_token: jwt("acct_probe"),
        refresh_token: "refresh_probe",
        expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

/** True when nothing answers on the callback's fixed port. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

const root = mkdtempSync(join(tmpdir(), "operad-oauth-probe-"));
const authPath = join(root, "auth.json");
const free = await portFree(1455);
const runtime = await ModelRuntime.create({
  authPath,
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});

let callbackStatus: number | undefined;
let redirect = "";
let path: "callback" | "manual" = "manual";
let settled = false;

const interaction = {
  signal: new AbortController().signal,
  async prompt(prompt: { type: string; message: string; signal?: AbortSignal }) {
    if (prompt.type === "select") return "browser";
    if (prompt.type === "manual_code") {
      // Wait for the callback attempt: when it wins, this prompt is aborted.
      for (let waited = 0; waited < 20; waited += 1) {
        if (settled) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return settled ? redirect : redirect;
    }
    return "";
  },
  notify(event: { type: string; url?: string }) {
    if (event.type !== "auth_url" || event.url === undefined) return;
    const url = new URL(event.url);
    const state = url.searchParams.get("state") ?? "";
    const callback = `http://127.0.0.1:1455/auth/callback?code=probe-code&state=${encodeURIComponent(state)}`;
    redirect = `http://localhost:1455/auth/callback?code=probe-code&state=${encodeURIComponent(state)}`;
    if (!free) return;
    void (async () => {
      try {
        const response = await realFetch(callback);
        callbackStatus = response.status;
        if (response.status === 200) {
          path = "callback";
          settled = true;
        }
      } catch {
        // The port was taken by another program: the pasted URL is the path.
      }
    })();
  },
};

const credential = await runtime.login("openai-codex", "oauth", interaction);
writeFileSync(
  join(root, "result.json"),
  JSON.stringify({
    accountId: credential.type === "oauth" ? credential.accountId : null,
    tokenCalls,
    callbackStatus,
    path,
    free,
  }),
);
console.log(
  JSON.stringify({
    ok: true,
    accountId: credential.type === "oauth" ? credential.accountId : null,
    tokenCalls,
    callbackStatus: callbackStatus ?? null,
    path,
    free,
    authPath,
  }),
);
