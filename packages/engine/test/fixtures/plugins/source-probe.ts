import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "../../../src/index.ts";

/** A source that records the client API the kernel gave it. */
export default definePlugin({
  name: "source-probe",
  kind: "source",
  version: "0.0.1",
  start(ctx) {
    writeFileSync(
      join(ctx.home, "source-probe.txt"),
      `${typeof ctx.client.pending}:${typeof ctx.client.answer}`,
    );
    return { stop: () => undefined };
  },
});
