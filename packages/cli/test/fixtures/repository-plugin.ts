/** Registers one repository, named by the environment, as a plugin that keeps repositories does. */

import { definePlugin } from "@operad-io/engine";

export default definePlugin({
  name: "repository-fixture",
  kind: "domain",
  version: "1.0.0",
  projectSettings: {
    repositories: () => {
      const path = process.env.OPERAD_TEST_REPOSITORY;
      return path === undefined ? [] : [{ name: "repository", path }];
    },
    files: [],
  },
});
