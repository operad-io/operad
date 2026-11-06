/** Errors the runner and its views report to the command line. */

/** The state does not allow the action; the CLI exits 3. */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

/** Another process holds a lock; the CLI exits 4. */
export class LockHeldError extends Error {
  readonly path: string;

  constructor(path: string, detail = "another process holds it") {
    super(`lock ${path}: ${detail}`);
    this.name = "LockHeldError";
    this.path = path;
  }
}
