/**
 * The hold fixture is shared with the dev tests, which import it as a module in
 * a TypeScript project and so keep it under `packages/dev`. This file keeps the
 * path the remote-check tests started with.
 */
export { HOLD_LIFETIME_SECS, holdUntilReleased } from "../../../packages/dev/test/fixtures/hold.ts";
