/** Errors a log backend reports to its callers. */

export class LogBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class StoreClosedError extends LogBackendError {
  constructor() {
    super("the log store is closed");
  }
}

export class ActiveRunError extends LogBackendError {
  readonly flow: string;
  readonly object: string;
  readonly runId: string;

  constructor(flow: string, object: string, runId: string) {
    super(`flow "${flow}" already has an active run for object "${object}" (${runId})`);
    this.flow = flow;
    this.object = object;
    this.runId = runId;
  }
}

export class RunNotFoundError extends LogBackendError {
  readonly runId: string;

  constructor(runId: string) {
    super(`run ${runId} does not exist`);
    this.runId = runId;
  }
}

export class RunEndedError extends LogBackendError {
  readonly runId: string;

  constructor(runId: string) {
    super(`run ${runId} has already ended`);
    this.runId = runId;
  }
}

export class SeqConflictError extends LogBackendError {
  readonly runId: string;
  readonly expectedSeq: number;
  readonly actualSeq: number;

  constructor(runId: string, expectedSeq: number, actualSeq: number) {
    super(`run ${runId} is at sequence ${actualSeq}, not ${expectedSeq}`);
    this.runId = runId;
    this.expectedSeq = expectedSeq;
    this.actualSeq = actualSeq;
  }
}

export class SchemaVersionError extends LogBackendError {}

export class SecretSerializationError extends LogBackendError {
  constructor() {
    super("a Secret cannot be serialised: store a reference to it, not the secret itself");
  }
}

export class InvalidPayloadError extends LogBackendError {}

export class CorruptLogError extends LogBackendError {
  readonly runId: string;

  constructor(runId: string, detail: string) {
    super(`run ${runId} has a corrupt log: ${detail}`);
    this.runId = runId;
  }
}
