# Sign in with ChatGPT: operad's own client registration

Date 2026-11-22. Research and design only (T-0702). Touches ADR 0023 (D4, D11), 0008 D8, and `docs/backlog/operad-first-run.md` ("发布前的核对"). No code changed.

## Verdict

1. OpenAI offers a path for open-source clients that registers a client per ChatGPT account at sign-in time (`client_id=dynamic_agent_client`; no secret, no partner key). operad can use it instead of the Codex CLI's public client id that pi's `openai-codex` provider borrows.
2. **The issued token does not call the backend pi's `openai-codex` provider calls.** It calls the public `https://api.openai.com/v1/responses`, and OpenAI says not to use `backend-api`. So this is not a client-id swap inside pi's Codex provider: operad must add a different pi provider (Responses API on `api.openai.com`) whose OAuth block is operad's.
3. pi can refresh with operad's client id, as long as the provider is registered in the pi process that needs the token. operad does not need to own refresh.
4. There is **no device-code flow** in the SIWC docs. A headless `serve` uses the paste-the-redirect-URL path, or transfers credentials from a machine that has a browser.
5. **Access may be gated.** The "Request a client ID" page says the feature "is currently offered to a select group of commercial partners". See open question 1; it may block shipping.

## What the pages say (read 2026-11-22)

Base: `https://developers.openai.com/siwc/...` (each page has a `.md` twin).

**Overview** (`/siwc/token-sharing-open-source`). "ChatGPT plan usage is an optional capability within Sign in with ChatGPT"; it grants no access to conversations. A client is bound to the user and workspace; "multiple hosts can share one client". Each host needs its own `ext_agent_host_id`, persisted before first sign-in, opaque (no email or user id). Accepted forms: `urn:ietf:params:oauth:jwk-thumbprint:…` (recommended, RFC 9278), `urn:uuid:…` (UUIDv4), `did:key:…`. Paid or remotely hosted apps are pointed at an interest form.

**Registration and sign-in** (`/siwc/token-sharing-open-source/sign-in`).
- Authorization `https://auth.openai.com/api/accounts/authorize`, token `https://auth.openai.com/api/accounts/oauth/token` (form-encoded).
- "`dynamic_agent_client` is the first-time registration entrypoint, not the client ID to save or use for token exchange." The callback returns the issued `client_id` (`oaiapp_…`); "Save it per ChatGPT account and reuse it for later sign-ins."
- Authorization parameters: `client_id`, `agent_name_hint` (first registration only; display metadata), `ext_agent_host_id` (required), optional `id_token_hint` and `login_hint`, `response_type=code`, `redirect_uri` = loopback `http://127.0.0.1:1455/auth/callback` ("Only the port may vary. Do not use `localhost`"; listener before browser), `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, fresh `state` and `nonce`, PKCE `S256`.
- Callback: `code`, `scope`, `state`, `client_id` (new registration). `error=access_denied`: validate state, stop. A different `client_id` on reauthorization is rejected.
- Exchange: `authorization_code` grant with `client_id` (the issued one), `code`, `code_verifier`, same `redirect_uri`, `resource`. `invalid_grant`: discard and restart.
- Validate the ID token: signature (JWKS), issuer, audience = issued `client_id`, expiry, nonce. Identity is `sub`. "A valid ID token alone does not authorize ChatGPT plan usage": the granted scopes must contain `chatgpt.tokens.use.direct`.
- Storage: one record per issued `client_id` and verified identity: `email`, `issuer`, `subject`, `client_id`, `ext_agent_host_id`, `id_token`, `access_token`, `refresh_token`, `token_type`, `expires_in`, `scopes`, `saved_at`; atomic write, `0600`.

**Token reference** (`.../token-reference`). Access token 1 hour. "Refresh tokens are valid for 30 days"; each refresh issues a replacement with a new 30 days, no fixed limit on successive replacements. Access-token `aud` is `https://api.openai.com/v1`. The response also carries `earliest_refresh_at`. The OpenAI metadata claim is opaque.

**Accounts and sessions** (`.../profiles-and-sessions`).
- Refresh: "POST form-encoded `grant_type=refresh_token`, the issued `client_id` saved with this token set (not `dynamic_agent_client`), the saved `refresh_token`, and `resource=https://api.openai.com/v1` to `https://auth.openai.com/api/accounts/oauth/token`; omit `scope`". "serialize refreshes for the same session so two processes do not race a rotating token."
- Same account, same host: reuse `client_id` and `ext_agent_host_id`; sign-out or account switch must not create a new client.
- Sign-out: revoke the refresh token at the revocation endpoint from the OpenID configuration; empty 200 is success; retry network/5xx; if unconfirmed, clear local tokens and tell the user. "Revoking this session does not delete the registered client."
- Tokens stay out of logs, URLs, browser storage; redact authorization URLs containing `id_token_hint`.
- The OpenID configuration (`https://auth.openai.com/.well-known/openid-configuration`, fetched) names `revocation_endpoint` `https://auth.openai.com/api/accounts/oauth/revoke`, `jwks_uri` `https://auth.openai.com/.well-known/jwks.json`, `token_endpoint_auth_methods_supported` including `none`, `code_challenge_methods_supported` `S256`.

**Models and inference** (`.../models-and-inference`). Both calls go to `https://api.openai.com/v1`: `GET /models` (keep `visibility == "list"`) and `POST /responses` with `Authorization: Bearer <access token>`; every request sets `store: false` and `stream: true`. "do not point it at ChatGPT's `backend-api` endpoints." Success only after `response.completed`; usage limits can arrive as `response.failed` mid-stream.

**Preview limitations** (`.../preview-limitations`). No `previous_response_id` over HTTP (send history in `input`); system-role items rejected (use `instructions` or developer messages); `temperature`, `top_p`, `metadata`, `user`, `truncation` unsupported; hosted tools (image generation, file search, code interpreter, computer use, hosted MCP, `tool_search`) unsupported; no audio/video input, Files API, transcription.

**Errors and recovery** (`.../errors-and-recovery`). Missing `chatgpt.tokens.use.direct`: keep the sign-in, mark plan usage disabled, offer an API key. 401/403/503 admission failures; `subscription_sharing_*` codes (user not eligible 403, usage limit 429, usage unavailable 503, unsupported capability 400, route not supported 403, invalid user 401). OpenAI does not notify the tool when the user disconnects the app; stop at the first request or refresh that confirms it. Terminal refresh errors (`invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused`): clear tokens and sign in again with the saved client id. "Do not erase credentials solely because of a temporary network or infrastructure failure."

**Self-hosted VMs** (`.../self-hosted-vms`). "A `127.0.0.1` callback reaches the computer running the browser, not the remote VM." Workaround: "Complete OAuth locally with the same tool/client", copy the protected credential file over a secure channel, keep the VM's own host id ("a copied laptop ID does not overwrite it"), "Let the VM own later refreshes". Host-specific attribution and revocation for transferred sessions "are not yet available". **No device code anywhere in the pages.**

**Codex app-server** (`.../codex-app-server`). Same token, passed as `ACCESS_TOKEN` to `codex app-server`, which sends it to `/v1/responses`. `clientInfo.name` should match `agent_name_hint`. Not relevant to pi.

**UI/UX** (`/siwc/ui-ux-guidelines`). Button label "Continue with ChatGPT" with the logo (approved formats only); concept name "ChatGPT plan usage"; "Using ChatGPT plan" in the composer; "Manage usage" linking to `chatgpt.com/settings/usage`; a "You're using your ChatGPT plan" welcome only the first time; show which app plans support it. No separate terms text appears on these pages; the site links `openai.com/policies`, not read here.

## What pi does today

`@earendil-works/pi-ai` 1.6.0, `dist/auth/oauth/openai-codex.js`:
- `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"` (the Codex CLI's), authorize `https://auth.openai.com/oauth/authorize`, token `https://auth.openai.com/oauth/token`, redirect `http://localhost:1455/auth/callback`, scope `openid profile email offline_access`, plus `codex_cli_simplified_flow=true` and `originator=<agentName>`. Different endpoints, scope, redirect host and no `resource` from the SIWC ones.
- Device code is supported there (`/api/accounts/deviceauth/usercode`, `.../deviceauth/token`, user page `/codex/device`) but only for that Codex client id. Nothing says a `dynamic_agent_client` registration can use it.
- Credential is `{type:"oauth", access, refresh, expires, accountId}`; `accountId` comes from the `chatgpt_account_id` claim of the access token. `toAuth` returns `{apiKey: access}`.
- The provider's models (`providers/openai-codex.js`) use api `openai-codex-responses` and base `https://chatgpt.com/backend-api`. A SIWC token has no such claim and is not for that host.

How a caller plugs in its own OAuth:
- pi-ai `OAuthAuth` (`auth/types.d.ts`): `login`, `refresh(credential, signal)`, `toAuth(credential)`. `Models` runs `refresh` "under the store lock" so "concurrent callers and processes refresh only once" (`refreshStoredOAuthCredential`, `proper-lockfile`). `OAuthCredentials` allows extra keys (`[key: string]: unknown`), which is where `client_id`, `ext_agent_host_id`, `subject` and the retained `id_token` can live.
- `LoginOptions` already has `getDeviceId?(): string` ("the stable ID of this app installation, e.g. sent to OpenAI as its agent host ID") and `agentName`. `ModelRuntime.login(providerId, type, interaction, options)` takes them.
- pi-coding-agent: an extension calls `pi.registerProvider(name, {baseUrl, api: "openai-responses", models, oauth: {name, login, refreshToken, getApiKey}})`; `ModelRuntime`/`ModelRegistry` also take native providers (`registerNativeProvider`). operad's worker already has a seam, `WorkerHooks.registerProviders(runtime)` (`packages/harness/pi/src/worker.ts:96`, called at line 241).
- **Consequence:** whichever pi process reads the credential must have the provider registered, or it has no `refresh` for it. The worker child and the login child are operad's and can register it. A `pi` the user runs by itself cannot, unless operad also ships the provider as a pi extension package (optional, see open question 6).

## The design

### Provider

A new pi provider `openai-siwc` (name to confirm), registered by operad in the worker and login children:
- api `openai-responses`, `baseUrl https://api.openai.com/v1`, token as the API key (`toAuth`/`getApiKey` returns `access`).
- Models from `GET /v1/models` filtered to `visibility == "list"`, fetched at login and when the account changes (`refreshModels`), with a small static fallback. Model `compat` must switch off what the preview rejects: tool search, system-role items mid conversation, `previous_response_id`, hosted tools, the unsupported sampling fields; and force `store:false`, `stream:true` (pi's `openai-responses.js` already sets `store: false`; spike to confirm the rest).
- A request-level guard in operad's provider: refuse any base URL that is not `api.openai.com/v1`, so a SIWC token is never sent to `backend-api` or anywhere else.

### Flow, step by step

1. **Prepare** (hub, before the child starts). Read `siwc.json` (below). If it has no `hostId`, create `urn:uuid:<uuidv4>` and write it, before any sign-in. `agent_name_hint = "operad"`, the same string every time.
2. **Metadata.** `GET https://auth.openai.com/.well-known/openid-configuration` for the token, revocation and JWKS addresses (cache; fall back to the documented authorize/token URLs).
3. **Authorize.** In the login child: start the loopback listener on `127.0.0.1:1455` (another port is allowed; the URL carries it); build the URL with `client_id=dynamic_agent_client` (first sign-in) or the saved issued id (later sign-ins, plus `id_token_hint` from the saved record to skip account choice), `ext_agent_host_id`, `agent_name_hint=operad` (first only), `response_type=code`, `redirect_uri`, the scope list above, `resource=https://api.openai.com/v1`, `state`, `nonce`, S256 challenge. Send it to the person as the existing `auth_url` notice (a pending item, ADR 0023 D11); log nothing that contains `id_token_hint`.
4. **Callback or paste.** The listener takes `code`, `scope`, `state`, `client_id`; state mismatch aborts; `error=access_denied` ends the login without exchanging. If the port is taken or the browser is on another machine, the existing `manual_code` prompt takes the pasted redirect URL (same parsing and state check as pi's).
5. **Exchange.** POST form to the token endpoint: `grant_type=authorization_code`, `client_id=<issued from callback>`, `code`, `code_verifier`, same `redirect_uri`, `resource`. No secret.
6. **Validate.** Verify the ID token against the JWKS (RS256): issuer `https://auth.openai.com`, audience = issued `client_id`, `exp`, `nonce`. `sub` is the account identity. Require `chatgpt.tokens.use.direct` in the granted scopes; if missing, keep the account entry, store no usable credential and tell the person plan usage was not granted (offer the API-key route).
7. **Store** (next section).
8. **Verify and pick a model.** `GET /v1/models`, then the existing model-choice question; "a successfully completed inference turn verifies access".
9. **Refresh** (any pi process, under pi's store lock, when the access token has under five minutes left): POST `grant_type=refresh_token`, the saved issued `client_id`, `refresh_token`, `resource`, no `scope`; replace access, expiry, scopes and the rotated refresh token in one credential write. Terminal errors from the list above clear the credential and raise the sign-in pending item with the saved client id; network errors and 5xx keep it.
10. **Sign-out** (new, small): revoke the refresh token at the `revocation_endpoint` (`token`, `client_id`; retry 5xx with backoff), then delete the credential; if revocation cannot be confirmed, delete anyway and say so. Keep `siwc.json` (account to client mapping, host id).

### What operad stores, and where

- **The secrets stay in pi's `auth.json`** (`~/.pi/agent/auth.json`, ADR 0023 D4), under the provider id, as an OAuth credential `{type:"oauth", access, refresh, expires, client_id, subject, email, ext_agent_host_id, id_token, scopes, saved_at}`. One place for the rotating refresh token means no second copy to race (the docs' warning), and pi's lock already serializes refresh across the hub's children. The file stays `0600` (pi writes it that way; the login test already checks it, `auth-file.test.ts`).
- **A new non-secret file `~/.operad/harness/pi/siwc.json`** with a JSON Schema in `packages/harness/pi`: `{hostId, agentName, accounts: [{subject, email, clientId}]}`. It survives sign-out so the next sign-in reuses `client_id` and `ext_agent_host_id` (docs: "Signing out or switching accounts shouldn't create a new client"). Losing `auth.json` does not lose the client mapping. Atomic write.
- One account at a time in `auth.json` (one credential per provider id) for now; the mapping file already allows several. Multi-account is out of scope.

### `ext_agent_host_id`

**One stable id per operad home**, `urn:uuid:` v4, generated on the first SIWC login and kept in `siwc.json`.
- Why per home and not per install: the home holds the credentials and the serve that uses them; the desktop app's bundled CLI and a user-installed CLI share `~/.operad`, so they are one host. A per-install id would give one home two hosts, or break when the app is reinstalled.
- Why not per machine/user: a headless `serve` and a laptop home on one machine are different hosts in the docs' sense.
- UUID rather than a JWK thumbprint: accepted by the docs and needs no key. A thumbprint is "recommended"; open question 3.
- Copying a home to another machine copies the id. The VM page says the VM keeps its own id: when `serve` starts on a different machine id than the one recorded with the id (store a hash of the hostname/machine id next to `hostId`), mint a new `hostId` and reauthorize with the saved `client_id` ("Use its own host ID for its next authorization").

### `agent_name_hint`

The constant `"operad"`, sent on first registration only, and the same as any future `clientInfo` name.

### Headless `serve`

Same flow with `manual_code`: the pending item shows the authorize URL; the person opens it on any machine, finishes, and pastes the failed `127.0.0.1` redirect URL back (the page will not load on that machine; the URL bar still has the code). This is how pi's fallback already works, so the TUI, desktop and iOS items need no change. A true device-code flow is not offered for this client; if a pending item cannot be answered from anywhere, the "Self-hosted VMs" route (sign in on a laptop, copy the credential and keep the VM's own host id) is the documented fallback; a command for it is open question 5.

## Changes in `packages/harness/pi/src`

- `login-protocol.ts`
  - `LoginStart` gains `siwc: {hostId, agentName, issuer} | null` (issuer defaults to `https://auth.openai.com`; the test seam).
  - `codexAuthUrl` becomes the SIWC check: host `auth.openai.com`, path `/api/accounts/authorize`, `redirect_uri` `http://127.0.0.1:<port>/auth/callback`, `resource` present, `client_id` `dynamic_agent_client` or a saved id. Keep the https-only rule and the test that a foreign address fails before it is shown (ADR 0008 D8). The test issuer is allowed only through the seam, never from settings.
  - `LoginProvider` needs no new field; the route label comes from the provider (`Continue with ChatGPT`).
- `login-worker.ts`: register `openai-siwc` on the `ModelRuntime` before `providersOf`, pass `LoginOptions {getDeviceId: () => hostId, agentName: "operad"}` to `runtime.login`, and after `done` write the mapping through a message to the hub (the hub owns `siwc.json`; the child must not write operad's files other than via the line protocol).
- `login.ts`: `routesOf` offers `openai-siwc` (`primary`) instead of `openai-codex` for the subscription route; read/write `siwc.json` in the hub, create the host id before starting the child; the model choice uses the `/v1/models` list; add the sign-out action and the "plan usage not granted" outcome.
- New `siwc.ts` (provider and flow): endpoints, PKCE, state/nonce, JWKS check, exchange, refresh, revoke, `/v1/models`; no dependency (Bun `fetch`, `crypto.subtle`).
- `worker.ts` / `index.ts`: register the provider through the existing `registerProviders` seam in every worker; `piDefaultModel` and the model list must understand the new provider id.
- ADR 0023 D4 and D11 change (D11 offered only ChatGPT's subscription through pi's `openai-codex`; D4 says credentials are the user's own pi login, which stays true for the file but not for a user's stand-alone pi). Docs-only commit first, per AGENTS.md. `operad-first-run.md` item 5 says the login uses `openai-codex`; update when the item lands.

## Homes already logged in through the Codex client

Nothing is touched. The `openai-codex` credential in `auth.json` keeps working through its own refresh token, in pi and in operad's workers (pi's `openai-codex` provider stays as it is), until that refresh token stops working or the user logs out. A user who never opens the new login never sees it.

Recommended policy: no forced re-login and no banner. When the login pending item is next raised (first run, or an `openai-codex` refresh failure), it offers only the new route; `openai-codex` is no longer offered in `routesOf`. `pi.model` values like `openai-codex/gpt-5.6-terra` keep resolving while the old credential exists; after a new login the model choice step writes the new provider's model. The two credentials can coexist; the bot uses whichever `pi.model` names. This keeps operad off the Codex client id for every new login, and leaves existing logins to the owner's terms-risk call (open question 4).

## Testing without a ChatGPT account

A fake auth-and-API server in the test tree (`Bun.serve` on an ephemeral port), started inside the test, reached through the `issuer` seam:
- `/.well-known/openid-configuration` and `/.well-known/jwks.json` (an RS256 key made with `crypto.subtle` in the test).
- `/api/accounts/authorize`: records the query (asserts `ext_agent_host_id`, `agent_name_hint`, scope, `resource`, S256, `redirect_uri` on `127.0.0.1`), then 302s to the `redirect_uri` with `code`, `state`, `client_id=oaiapp_fake`; variants: `access_denied`, wrong `state`, wrong `client_id` on reauthorization, no `chatgpt.tokens.use.direct`.
- `/api/accounts/oauth/token`: checks PKCE verifier, `resource`, form encoding; returns a signed ID token (right and wrong `aud`/`nonce`/`iss`), a 3600 s access token, a rotating refresh token; on refresh checks the issued id (rejects `dynamic_agent_client`), no `scope`, and replies with `invalid_grant`/`refresh_token_reused` on a replayed token; `/oauth/revoke` returns empty 200 (and a 5xx variant).
- `/v1/models` and `/v1/responses` (SSE ending in `response.completed`, and a `response.failed` variant); it fails the request unless `store:false`, `stream:true`, no `previous_response_id`, no system-role items; any `backend-api` path returns an error so a wrong base URL shows up.
- The login runs as a real child (the way `fake-login-worker.ts` and `test/heavy/oauth.test.ts` do), the loopback callback is hit with a real HTTP request, and the paste path is exercised with the redirect URL. Time uses the injected clock; the refresh test sets `expires` near now and runs two processes against one `auth.json` to see one refresh and one rotated token.
- Mutation checks (`packages/harness/pi/MUTATIONS.md`): drop `resource` on refresh; refresh with `dynamic_agent_client`; skip the scope check; accept a foreign authorize host; write the mapping after sign-out deletion.
- What the fake cannot prove: that OpenAI accepts `dynamic_agent_client` from a third party, the real scope grant, real model ids, and real usage limits. One manual check with a real account before release.

## Open questions for the owner

1. **Is registration open to operad?** The "Request a client ID" page: "Sign in with ChatGPT is currently offered to a select group of commercial partners. To join the waitlist, complete the … interest form." The open-source sign-in page describes `dynamic_agent_client` with "No client secret or partner API key". Unclear whether an unlisted app is refused at the authorize step. Needs one probe with the real endpoint or an answer from OpenAI, before any implementation beyond the spike.
2. **Is operad "paid or remotely hosted"?** The overview sends such apps to the interest form. operad runs on the user's own machine, but `serve` is reachable from the iOS and desktop clients. Does the owner want to file the form?
3. **Host id form.** `urn:uuid` (proposed) or the recommended JWK thumbprint (needs a stored key; a bonus is proof of possession, not required by the docs).
4. **The old Codex-client login.** Leave existing `openai-codex` logins alone (proposed), or stop offering and warn? The terms risk of the old path is the owner's call; the new route should not be released until question 1 is settled, and the old route stays in 0023 D11 until then.
5. **Headless without a paste.** Is pasting the redirect URL enough, or does the owner want `operad` to import a credential from another machine (the VM page's procedure)?
6. **A user's own pi.** After the change, a stand-alone `pi` cannot use the new credential. Accept this (operad's login now means operad's agents), or also ship the provider as a pi extension package so `pi` can refresh it?
7. **User-visible words.** The UI/UX page requires "Continue with ChatGPT", "ChatGPT plan usage", "Using ChatGPT plan", "Manage usage" (and a first-time welcome). These are new words (see the final answer for the list) and the owner has to approve them; the old label "OpenAI (ChatGPT Plus/Pro)" is pi's, not operad's.
8. **Capability loss.** The preview forbids hosted tools, `tool_search`, `previous_response_id`, many sampling fields; the Codex backend allowed more. Is a narrower subscription route acceptable, with the API key as the other route?
9. **Model ids.** Models come from `/v1/models` (e.g. the page's `gpt-6.1-sol`), not pi's Codex catalog; `pi.model` migration for existing homes follows question 4.
