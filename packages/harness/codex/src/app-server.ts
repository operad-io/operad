/**
 * A small client for Codex's own `codex app-server`: JSON-RPC 2.0, one message
 * per line, on the app-server's stdio (ADR 0022 D3, D8). The protocol was read
 * from the installed Codex: `codex app-server generate-ts` and
 * `codex app-server generate-json-schema` (codex-cli 0.166.0).
 *
 * The client is a state machine, not a process owner. `runAgent` starts
 * `codex app-server` and hands each stdout line to `handleLine`; the client
 * answers through the `reply` function `runAgent` gives it. `first` is the
 * `initialize` request, which the caller passes as the run's stdin.
 *
 * The run is: `initialize`, `initialized`, then `thread/start` (or
 * `thread/resume` when a session is resumed), then `turn/start`. The item
 * stream goes to `onNotification` while the turn runs. Approval requests go to
 * `onPermission`. `cancel` sends `turn/interrupt`; `steer` sends `turn/steer`.
 * `ended` settles once with how the turn ended, or with the stage that failed.
 *
 * The client keeps no timers: how long a silent agent may be silent is the
 * caller's `stallMs` and `wallMs` of `runAgent`.
 */

import { isRecord } from "@operad-io/engine";

/** The token counts of one turn, as Codex reports them. */
export interface AppServerUsage {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
  readonly thoughtTokens?: number;
  /** The model's context window when the app-server reports it. */
  readonly modelContextWindow?: number;
}

/** An error response of the app-server, or the error of a failed turn. */
export interface AppServerError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** The stage of the run an error came from. */
export type AppServerStage = "initialize" | "session" | "prompt";

/** How a turn ended, or the stage that failed before it could. */
export type AppServerEnd =
  | {
      readonly kind: "stopped";
      /** `completed`, `interrupted` or `failed`. */
      readonly stopReason: string;
      readonly usage: AppServerUsage | null;
      readonly sessionId: string;
      readonly error: AppServerError | null;
    }
  | {
      readonly kind: "error";
      readonly stage: AppServerStage;
      readonly error: AppServerError;
      readonly sessionId: string | null;
    };

/** One approval request of the app-server. */
export interface AppServerPermissionRequest {
  /** `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, or a legacy name. */
  readonly method: string;
  /** The item, call or approval id the request is about. */
  readonly toolCallId: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** The item as the app-server described it, when an item event came first. */
  readonly item: Readonly<Record<string, unknown>> | undefined;
}

/** An MCP server the thread starts, as Codex's own config takes it. */
export interface AppServerMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** One question of a `item/tool/requestUserInput` request. */
export interface AppServerQuestion {
  readonly id: string;
  readonly question: string;
  readonly header?: string | undefined;
  readonly options?: readonly { readonly label: string; readonly description?: string | undefined }[] | undefined;
  /** True when Codex itself offers an answer in the person's own words. */
  readonly isOther?: boolean | undefined;
}

/** A `item/tool/requestUserInput` request of the app-server. */
export interface AppServerQuestionRequest {
  readonly method: string;
  readonly itemId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly questions: readonly AppServerQuestion[];
}

/** One question's answer as the app-server reads it. */
export type AppServerQuestionAnswers = Readonly<Record<string, readonly string[]>>;

export interface AppServerClientOptions {
  readonly cwd: string;
  /** The prompt as app-server `UserInput` entries. */
  readonly prompt: readonly Readonly<Record<string, unknown>>[];
  /** Continue this thread. */
  readonly resumeSession?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  /** Codex's approval policy: `on-request` asks instead of deciding. */
  readonly approvalPolicy: string;
  /** Codex's sandbox mode: `workspace-write` stays on. */
  readonly sandbox: string;
  /** MCP servers the thread starts, through Codex's own `mcp_servers` config. */
  readonly mcpServers?: readonly AppServerMcpServer[] | undefined;
  readonly clientName: string;
  readonly clientVersion?: string | undefined;
  /** Each notification of the running turn, in order: method and params. */
  readonly onNotification: (method: string, params: Readonly<Record<string, unknown>>) => void | Promise<void>;
  /** True lets the call run once; false refuses it. */
  readonly onPermission: (request: AppServerPermissionRequest) => Promise<boolean>;
  /**
   * The agent's own questions, as one form the person fills in (ADR 0026 D6).
   * Resolves with one answer per question id; absent refuses the request.
   */
  readonly onQuestion?: ((request: AppServerQuestionRequest) => Promise<AppServerQuestionAnswers>) | undefined;
}

type Phase = "initialize" | "session" | "turn" | "done";

type Stage = AppServerStage | "steer" | "cancel";

function errorOf(value: unknown): AppServerError {  if (!isRecord(value)) return { code: -32603, message: "the app-server sent an error without a body" };
  return {
    code: typeof value.code === "number" ? value.code : -32603,
    message: typeof value.message === "string" ? value.message : "the app-server sent an error without a message",
    ...(value.data === undefined ? {} : { data: value.data }),
  };
}

function turnErrorOf(value: unknown): AppServerError | undefined {
  if (!isRecord(value)) return undefined;
  const message = typeof value.message === "string" ? value.message : "the turn failed";
  return { code: 0, message, data: value };
}

function numberField(value: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const found = value[key];
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

/**
 * The questions of an `item/tool/requestUserInput` payload. A question without
 * an id or text cannot be answered, so it is left out.
 */
export function questionsOf(value: unknown): AppServerQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: AppServerQuestion[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = raw["id"];
    const question = raw["question"];
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof question !== "string" || question.trim().length === 0) continue;
    const options: { label: string; description?: string }[] = [];
    if (Array.isArray(raw["options"])) {
      for (const option of raw["options"]) {
        if (!isRecord(option)) continue;
        const label = option["label"];
        if (typeof label !== "string" || label.trim().length === 0) continue;
        const description = option["description"];
        options.push({
          label,
          ...(typeof description === "string" && description.trim().length > 0 ? { description } : {}),
        });
      }
    }
    const header = raw["header"];
    questions.push({
      id,
      question,
      ...(typeof header === "string" && header.length > 0 ? { header } : {}),
      ...(options.length === 0 ? {} : { options }),
      ...(raw["isOther"] === true ? { isOther: true } : {}),
    });
  }
  return questions;
}

/** The counts of the last turn from a `thread/tokenUsage/updated` payload. */
export function usageOf(value: unknown): AppServerUsage | null {
  if (!isRecord(value)) return null;
  const last = isRecord(value["last"]) ? value["last"] : undefined;
  const total = isRecord(value["total"]) ? value["total"] : undefined;
  const counts = last ?? total;
  if (counts === undefined) return null;
  const totalTokens = numberField(counts, "totalTokens");
  const inputTokens = numberField(counts, "inputTokens");
  const outputTokens = numberField(counts, "outputTokens");
  const cachedReadTokens = numberField(counts, "cachedInputTokens");
  const cachedWriteTokens = numberField(counts, "cacheWriteInputTokens");
  const thoughtTokens = numberField(counts, "reasoningOutputTokens");
  const modelContextWindow = numberField(value, "modelContextWindow");
  return {
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedReadTokens === undefined ? {} : { cachedReadTokens }),
    ...(cachedWriteTokens === undefined ? {} : { cachedWriteTokens }),
    ...(thoughtTokens === undefined ? {} : { thoughtTokens }),
    ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
  };
}

function mcpConfig(servers: readonly AppServerMcpServer[] | undefined): Record<string, unknown> | undefined {
  if (servers === undefined || servers.length === 0) return undefined;
  const found: Record<string, unknown> = {};
  for (const server of servers) {
    found[server.name] = {
      command: server.command,
      args: [...server.args],
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    };
  }
  return found;
}

export class AppServerClient {
  /** The first line the caller sends: the `initialize` request. */
  readonly first: string;
  /** Settles once, when the turn ended or a stage failed. */
  readonly ended: Promise<AppServerEnd>;
  /** Resolves once the turn has been asked for, so a queued host message can steer it. */
  readonly started: Promise<void>;

  private readonly options: AppServerClientOptions;
  private resolveStarted: () => void = () => undefined;
  private reply: ((text: string) => void) | undefined;
  private nextId = 1;
  private phase: Phase = "initialize";
  private session: string | null = null;
  private turn: string | null = null;
  private settle: (end: AppServerEnd) => void = () => undefined;
  /** What each request in flight waits for, by id. A `steer` and a `cancel` are fire-and-forget. */
  private readonly pending = new Map<number, Stage>();
  private readonly items = new Map<string, Readonly<Record<string, unknown>>>();
  private cancelling = false;
  private promptSent = false;
  private usage: AppServerUsage | null = null;
  private noticedError: AppServerError | null = null;

  constructor(options: AppServerClientOptions) {
    this.options = options;
    this.ended = new Promise<AppServerEnd>((resolve) => {
      this.settle = resolve;
    });
    this.started = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
    this.first = this.request(
      "initialize",
      {
        clientInfo: {
          name: options.clientName,
          title: options.clientName,
          version: options.clientVersion ?? "0.0.0",
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      "initialize",
    );
  }

  /** The thread the run uses; null before the app-server opened one. */
  get sessionId(): string | null {
    return this.session;
  }

  /** True from the moment the turn is asked for: updates belong to this run. */
  get active(): boolean {
    return this.phase === "turn" && this.promptSent;
  }

  /** True while the turn is in flight, so a cancel or steer reaches it. */
  get prompting(): boolean {
    return this.active && this.session !== null && this.turn !== null;
  }

  /** Whether the run ended (the turn completed, or a stage failed). */
  get finished(): boolean {
    return this.phase === "done";
  }

  private request(method: string, params: Record<string, unknown>, stage: Stage): string {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, stage);
    return JSON.stringify({ jsonrpc: "2.0", id, method, params });
  }

  private send(line: string): void {
    this.reply?.(line);
  }

  private end(end: AppServerEnd): void {
    if (this.phase === "done") return;
    this.phase = "done";
    this.settle(end);
  }

  private fail(stage: AppServerStage, error: AppServerError): void {
    this.end({ kind: "error", stage, error, sessionId: this.session });
  }

  private threadParams(): Record<string, unknown> {
    const config = mcpConfig(this.options.mcpServers);
    return {
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: this.options.sandbox,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(config === undefined ? {} : { config: { mcp_servers: config } }),
    };
  }

  /** Sends `turn/steer` for the running turn. False when no turn is in flight. */
  steer(text: string): boolean {
    if (!this.prompting || this.session === null || this.turn === null || this.cancelling) return false;
    this.send(
      this.request(
        "turn/steer",
        {
          threadId: this.session,
          expectedTurnId: this.turn,
          input: [{ type: "text", text, text_elements: [] }],
        },
        "steer",
      ),
    );
    return true;
  }

  /**
   * Sends `turn/interrupt` for the running turn. The app-server answers the
   * turn with the status `interrupted`, which `ended` reports. False when no
   * turn is in flight, so there is nothing to interrupt.
   */
  cancel(): boolean {
    if (!this.prompting || this.session === null || this.turn === null || this.cancelling) return false;
    this.cancelling = true;
    this.send(this.request("turn/interrupt", { threadId: this.session, turnId: this.turn }, "cancel"));
    return true;
  }

  /** Takes one line of the app-server's stdout. */
  handleLine(line: string, reply: (text: string) => void): void {
    this.reply = reply;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    const { id, method } = message;
    if (typeof method === "string") {
      if (typeof id === "number" || typeof id === "string") this.handleServerRequest(id, method, message.params);
      else this.handleNotification(method, message.params);
      return;
    }
    if (typeof id === "number") this.handleResponse(id, message);
  }

  private handleNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    if (method === "thread/tokenUsage/updated") {
      // A resumed thread first reports its earlier usage; only this turn counts.
      if (this.phase === "turn" && this.promptSent) this.usage = usageOf(params["tokenUsage"]);
      return;
    }
    if (method === "error") {
      const error = isRecord(params["error"]) ? params["error"] : undefined;
      this.noticedError = turnErrorOf(error) ?? this.noticedError;
      void this.options.onNotification(method, params);
      return;
    }
    if (method === "turn/completed") {
      const turn = isRecord(params["turn"]) ? params["turn"] : {};
      const status = typeof turn["status"] === "string" ? turn["status"] : "failed";
      const fromTurn = turnErrorOf(turn["error"]);
      this.end({
        kind: "stopped",
        stopReason: status,
        usage: this.usage,
        sessionId: this.session ?? "",
        error: fromTurn ?? this.noticedError,
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params["item"];
      if (isRecord(item) && typeof item["id"] === "string") this.items.set(item["id"], item);
    } else if (method === "item/fileChange/patchUpdated") {
      const id = params["itemId"];
      const item = typeof id === "string" ? this.items.get(id) : undefined;
      if (typeof id === "string" && item !== undefined && Array.isArray(params["changes"])) {
        this.items.set(id, { ...item, changes: params["changes"] });
      }
    }
    void this.options.onNotification(method, params);
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const body = isRecord(params) ? params : {};
    const answer = (result: Record<string, unknown>): void => {
      this.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    };
    const refuse = (message: string): void => {
      this.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }));
    };
    if (method === "item/tool/requestUserInput") {
      const itemId = typeof body["itemId"] === "string" ? body["itemId"] : "";
      const request: AppServerQuestionRequest = {
        method,
        itemId,
        threadId: typeof body["threadId"] === "string" ? body["threadId"] : null,
        turnId: typeof body["turnId"] === "string" ? body["turnId"] : null,
        questions: questionsOf(body["questions"]),
      };
      const onQuestion = this.options.onQuestion;
      if (onQuestion === undefined || request.questions.length === 0) {
        refuse(`method not supported: ${method}`);
        return;
      }
      // The reader does not wait: a person may take long to answer, and the
      // app-server's other lines (the answer to an interrupt) must still be read.
      void (async () => {
        let answers: AppServerQuestionAnswers = {};
        if (!this.cancelling) {
          try {
            answers = await onQuestion(request);
          } catch {
            answers = {};
          }
        }
        const byId: Record<string, { readonly answers: readonly string[] }> = {};
        for (const [key, labels] of Object.entries(answers)) byId[key] = { answers: labels };
        answer({ answers: byId });
      })();
      return;
    }
    const itemId = typeof body["itemId"] === "string" ? body["itemId"] : typeof body["callId"] === "string" ? body["callId"] : "";
    const legacyCommand = method === "execCommandApproval";
    const legacyPatch = method === "applyPatchApproval";
    if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval" && !legacyCommand && !legacyPatch) {
      refuse(`method not supported: ${method}`);
      return;
    }
    const item = itemId.length === 0 ? undefined : this.items.get(itemId);
    // The reader does not wait: a person may take long to answer, and the
    // app-server's other lines (the answer to an interrupt) must still be read.
    void (async () => {
      let allow = false;
      if (!this.cancelling) {
        try {
          allow = await this.options.onPermission({ method, toolCallId: itemId, params: body, item });
        } catch {
          allow = false;
        }
      }
      if (legacyCommand || legacyPatch) {
        answer({
          decision: allow
            ? "approved"
            : { denied: { rejection: "the access profile refused this call" } },
        });
      } else {
        answer({ decision: allow ? "accept" : "decline" });
      }
    })();
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const stage = this.pending.get(id);
    if (stage === undefined) return;
    this.pending.delete(id);
    if (isRecord(message.error)) {
      if (stage === "steer" || stage === "cancel") return;
      this.fail(stage, errorOf(message.error));
      return;
    }
    if (stage === "steer" || stage === "cancel") return;
    const result = isRecord(message.result) ? message.result : {};
    switch (stage) {
      case "initialize": {
        this.phase = "session";
        this.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
        const resume = this.options.resumeSession;
        if (resume !== undefined) {
          this.session = resume;
          this.send(this.request("thread/resume", { threadId: resume, ...this.threadParams() }, "session"));
        } else {
          this.send(this.request("thread/start", this.threadParams(), "session"));
        }
        return;
      }
      case "session": {
        const thread = isRecord(result["thread"]) ? result["thread"] : {};
        const idValue = thread["id"];
        if (typeof idValue !== "string" || idValue.length === 0) {
          this.fail("session", { code: -32603, message: "the app-server opened a thread without an id" });
          return;
        }
        this.session = idValue;
        this.phase = "turn";
        // Updates can arrive before the turn/start response; they belong to
        // this run from the moment its turn is asked for.
        this.promptSent = true;
        this.resolveStarted();
        this.send(
          this.request(
            "turn/start",
            {
              threadId: idValue,
              input: [...this.options.prompt],
              ...(this.options.model === undefined ? {} : { model: this.options.model }),
              ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
            },
            "prompt",
          ),
        );
        return;
      }
      case "prompt": {
        const turn = isRecord(result["turn"]) ? result["turn"] : {};
        const turnId = turn["id"];
        if (typeof turnId !== "string" || turnId.length === 0) {
          this.fail("prompt", { code: -32603, message: "the app-server started a turn without an id" });
          return;
        }
        this.turn = turnId;
        return;
      }
    }
  }
}
