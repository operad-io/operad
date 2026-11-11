// A serve started under the real supervisor: the first process supervises, and
// the child it starts is the serve itself (it carries SUPERVISED_ENV).
import { SUPERVISED_ENV, superviseServe } from "../../src/code-reload.ts";
import { main } from "../../src/main.ts";

if (process.env[SUPERVISED_ENV] === "1") {
  process.exitCode = await main(process.argv.slice(2));
} else {
  process.exitCode = await superviseServe(() => Promise.resolve("stopped"));
}
