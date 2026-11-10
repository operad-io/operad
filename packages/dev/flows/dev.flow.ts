import { compileDevFlow, DEFAULT_STAGES } from "../src/flow-compiler.ts";

/**
 * The dev flow a repository with no `flows` runs. It is compiled from the
 * built-in stages, so it keeps the step ids earlier runs and tests use.
 */
export default compileDevFlow("dev", DEFAULT_STAGES);
