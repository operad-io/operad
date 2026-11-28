// A plugin whose start ends only once the file `open-gate` is in the home.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@operad-io/engine";
import { waitUntil } from "@operad-io/engine/testing";

export default definePlugin({
  name: "gated",
  kind: "domain",
  version: "0.0.0",
  async start(ctx) {
    await waitUntil(() => existsSync(join(ctx.home, "open-gate")), 20_000);
    return {
      stop: () => undefined,
      http: {
        request: () => ({ status: 200, body: {} }),
        stream: () => ({
          open(send) {
            send({ name: "hello", data: {} });
            return () => undefined;
          },
        }),
      },
    };
  },
});
