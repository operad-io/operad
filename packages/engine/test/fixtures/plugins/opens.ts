import { definePlugin } from "@operad-io/engine";

/** Actions that create an object and say so (`opens`), for the clients' tests. */
export default definePlugin({
  name: "opener",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "thing" }],
  actions: [
    {
      name: "make",
      on: "thing",
      when: () => true,
      run: () => ({ text: "made it", opens: "thing:b" }),
    },
    {
      name: "ghost",
      on: "thing",
      when: () => true,
      run: () => ({ text: "made a ghost", opens: "thing:nope" }),
    },
  ],
});
