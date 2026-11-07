/**
 * One writer for the auth.json locking check. Two copies of this script run in
 * two Bun processes against the same auth file; each logs in several fake OAuth
 * providers, so the read-modify-write under `proper-lockfile` must not lose an
 * entry written by the other process.
 *
 * Usage: bun spike/login-child.ts <authPath> <modelsPath> <prefix> <count>
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const [authPath, modelsPath, prefix, countArg] = process.argv.slice(2);
if (authPath === undefined || modelsPath === undefined || prefix === undefined) {
  console.error("usage: login-child.ts <authPath> <modelsPath> <prefix> [count]");
  process.exit(2);
}
const count = countArg === undefined ? 5 : Number(countArg);

const runtime = await ModelRuntime.create({
  authPath,
  modelsPath,
  refreshOnCreate: false,
});

for (let index = 0; index < count; index++) {
  const providerId = `${prefix}-${index}`;
  runtime.registerProvider(providerId, {
    name: providerId,
    baseUrl: "https://spike.invalid",
    oauth: {
      name: providerId,
      login: async () => ({
        refresh: `refresh-${providerId}`,
        access: `access-${providerId}`,
        expires: Date.now() + 3_600_000,
      }),
      refreshToken: async (credentials) => credentials,
      getApiKey: (credentials) => credentials.access,
    },
  });
  await runtime.login(providerId, "oauth", {
    prompt: async () => "",
    notify: () => {},
  });
}

console.log(`wrote ${count} credentials for ${prefix}`);
