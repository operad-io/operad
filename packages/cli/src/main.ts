import { ENGINE_VERSION } from "@operad-io/engine";

/** The `operad` command. Prints the version until the first CLI task lands. */
export async function main(args: string[]): Promise<number> {
  if (args[0] === "--version" || args[0] === "-V") {
    console.log(`operad ${ENGINE_VERSION}`);
    return 0;
  }
  console.log("operad is in development: https://operad.io");
  return 0;
}
