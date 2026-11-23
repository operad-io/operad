/**
 * Sets up git in a folder and kills itself after `git init` and before the
 * commit. The parent runs the setup again and proves it ends with one commit.
 */

import { applySetupGit, setupGitTestHooks } from "../../src/setup-git.ts";

const [folder, home, lockHome, request] = process.argv.slice(2);
if (folder === undefined || home === undefined || lockHome === undefined || request === undefined) {
  throw new Error("usage: setup-git-child <folder> <home> <lock home> <request json>");
}
setupGitTestHooks.beforeCommit = () => {
  process.kill(process.pid, "SIGKILL");
};
await applySetupGit(JSON.parse(request), { home, lock: { home: lockHome } });
