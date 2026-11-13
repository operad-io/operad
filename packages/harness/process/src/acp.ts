/**
 * An ACP (Agent Client Protocol) client for the harnesses that talk to their
 * agent over it: JSON-RPC 2.0, one message per line, on the agent's stdio.
 *
 * The client is a state machine, not a process owner. `runAgent` starts the
 * agent in interactive mode and hands each stdout line to `handleLine`; the
 * client answers through the `reply` function `runAgent` gives it. The first
 * line to send (`initialize`) is `first`, which the caller passes as the
 * run's stdin.
 *
 * The run is: `initialize`, then `session/new` (or `session/load` when a
 * session is resumed), then one `session/set_config_option` per setting, then
 * `session/prompt`. The `session/update` stream is handed to `onUpdate` while
 * the prompt runs; what `session/load` replays of an earlier conversation is
 * dropped. `session/request_permission` goes to `onPermission`. `cancel` sends
 * `session/cancel`. `ended` settles once with how the prompt ended.
 *
 * The client keeps no timers: how long a silent agent may be silent is the
 * caller's `stallMs` and `wallMs` of `runAgent`.
 */

import { isRecord } from "@operad-io/engine";

/** The ACP protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** The token counts of one prompt, as the agent reports them. */
export interface AcpUsage {
  readonly totalTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedReadTokens?: number | null;
  readonly cachedWriteTokens?: number | null;
  readonly thoughtTokens?: number | null;
}

/** An error response of the agent. */
export interface AcpError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** The stage of the run an error came from. */
export type AcpStage = "initialize" | "session" | "config" | "prompt";

export type AcpEnd =
  | {
      readonly kind: "stopped";
      /** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` or `cancelled`. */
      readonly stopReason: string;
      readonly usage: AcpUsage | null;
      /** The `_meta` of the prompt response, as the agent wrote it. */
      readonly meta: Readonly<Record<string, unknown>> | null;
      readonly sessionId: string;
    }
  | {
      readonly kind: "error";
      readonly stage: AcpStage;
      /** The setting a `config` stage error is about. */
      readonly configId?: string;
      readonly error: AcpError;
      readonly sessionId: string | null;
    };

/** One permission option the agent offers. */
export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** A `session/request_permission` request. */
export interface AcpPermissionRequest {
  readonly sessionId: string;
  /** The tool call as the agent describes it: `toolCallId`, `title`, `kind`, `rawInput`, `locations`. */
  readonly toolCall: Readonly<Record<string, unknown>>;
  readonly options: readonly AcpPermissionOption[];
}

export interface AcpClientOptions {
  readonly cwd: string;
  /** The prompt as ACP content blocks. */
  readonly prompt: readonly Readonly<Record<string, unknown>>[];
  /** Continue this session; the agent must offer `loadSession`. */
  readonly resumeSession?: string | undefined;
  /** Session settings to apply before the prompt, in order. */
  readonly config?: readonly { readonly configId: string; readonly value: string }[] | undefined;
  /** MCP servers the agent starts, as ACP stdio servers: `{ name, command, args, env }`. */
  readonly mcpServers?: readonly Readonly<Record<string, unknown>>[] | undefined;
  readonly clientName: string;
  readonly clientVersion?: string | undefined;
  /** Each `session/update` of the running prompt, in order. */
  readonly onUpdate: (update: Readonly<Record<string, unknown>>) => void | Promise<void>;
  /** True lets the call run once; false refuses it. */
  readonly onPermission: (request: AcpPermissionRequest) => Promise<boolean>;
}

/** The option an answer picks, or undefined when the agent offered no option for it. */
export function permissionOptionFor(
  options: readonly AcpPermissionOption[],
  allow: boolean,
): AcpPermissionOption | undefined {
  // A call is never allowed for good: only the once-option lets it through.
  const kinds = allow ? ["allow_once"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const found = options.find((option) => option.kind === kind);
    if (found !== undefined) return found;
  }
  return undefined;
}

function permissionOptions(value: unknown): readonly AcpPermissionOption[] {
  if (!Array.isArray(value)) return [];
  const found: AcpPermissionOption[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { optionId, name, kind } = item;
    if (
      typeof optionId === "string" &&
      (kind === "allow_once" || kind === "allow_always" || kind === "reject_once" || kind === "reject_always")
    ) {
      found.push({ optionId, name: typeof name === "string" ? name : optionId, kind });
    }
  }
  return found;
}

function errorOf(value: unknown): AcpError {
  if (!isRecord(value)) return { code: -32603, message: "the agent sent an error without a body" };
  return {
    code: typeof value.code === "number" ? value.code : -32603,
    message: typeof value.message === "string" ? value.message : "the agent sent an error without a message",
    ...(value.data === undefined ? {} : { data: value.data }),
  };
}

type Phase = "initialize" | "session" | "config" | "prompt" | "done";

export class AcpClient {
  /** The first line the caller sends: the `initialize` request. */
  readonly first: string;
  /** Settles once, when the prompt ended or a stage failed. */
  readonly ended: Promise<AcpEnd>;

  private readonly options: AcpClientOptions;
  private reply: ((text: string) => void) | undefined;
  private nextId = 1;
  private phase: Phase = "initialize";
  private session: string | null = null;
  private configAt = 0;
  private settle: (end: AcpEnd) => void = () => undefined;
  /** What each request in flight waits for, by id. */
  private readonly pending = new Map<number, AcpStage>();
  private cancelling = false;
  private promptSent = false;

  constructor(options: AcpClientOptions) {
    this.options = options;
    this.ended = new Promise<AcpEnd>((resolve) => {
      this.settle = resolve;
    });
    this.first = this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: {
        name: options.clientName,
        ...(options.clientVersion === undefined ? {} : { version: options.clientVersion }),
      },
    }, "initialize");
  }

  /** The session the run uses; null before the agent opened one. */
  get sessionId(): string | null {
    return this.session;
  }

  /** True while the prompt is in flight, so a cancel reaches the agent. */
  get prompting(): boolean {
    return this.phase === "prompt" && this.promptSent;
  }

  /** Whether the run ended (the prompt answered, or a stage failed). */
  get finished(): boolean {
    return this.phase === "done";
  }

  private request(method: string, params: Record<string, unknown>, stage: AcpStage): string {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, stage);
    return JSON.stringify({ jsonrpc: "2.0", id, method, params });
  }

  private send(line: string): void {
    this.reply?.(line);
  }

  private end(end: AcpEnd): void {
    if (this.phase === "done") return;
    this.phase = "done";
    this.settle(end);
  }

  private fail(stage: AcpStage, error: AcpError): void {
    const configId = stage === "config" ? this.options.config?.[this.configAt - 1]?.configId : undefined;
    this.end({
      kind: "error",
      stage,
      ...(configId === undefined ? {} : { configId }),
      error,
      sessionId: this.session,
    });
  }

  /**
   * Sends `session/cancel` for the running prompt. The agent answers the
   * prompt with the stop reason `cancelled`, which `ended` reports. False when
   * no prompt is in flight, so there is nothing to cancel.
   */
  cancel(): boolean {
    if (!this.prompting || this.session === null || this.cancelling) return false;
    this.cancelling = true;
    this.send(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.session } }));
    return true;
  }

  /** Takes one line of the agent's stdout. */
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
      if (typeof id === "number" || typeof id === "string") this.handleRequest(id, method, message.params);
      else this.handleNotification(method, message.params);
      return;
    }
    if (typeof id === "number") this.handleResponse(id, message);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update" || !isRecord(params)) return;
    // Until the prompt is sent, an update is what `session/load` replays.
    if (this.phase !== "prompt" || !this.promptSent) return;
    const update = params.update;
    if (isRecord(update)) void this.options.onUpdate(update);
  }

  private handleRequest(id: number | string, method: string, params: unknown): void {
    const answer = (body: Record<string, unknown>): void => {
      this.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
    };
    if (method !== "session/request_permission" || !isRecord(params) || !isRecord(params.toolCall)) {
      answer({ error: { code: -32601, message: `method not supported: ${method}` } });
      return;
    }
    const request: AcpPermissionRequest = {
      sessionId: typeof params.sessionId === "string" ? params.sessionId : (this.session ?? ""),
      toolCall: params.toolCall,
      options: permissionOptions(params.options),
    };
    // The reader does not wait: a person may take long to answer, and the
    // agent's other lines (the answer to a cancel) must still be read.
    void (async () => {
      let allow = false;
      if (!this.cancelling) {
        try {
          allow = await this.options.onPermission(request);
        } catch {
          allow = false;
        }
      }
      const option = permissionOptionFor(request.options, allow);
      answer({
        result: {
          outcome: option === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: option.optionId },
        },
      });
    })();
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const stage = this.pending.get(id);
    if (stage === undefined) return;
    this.pending.delete(id);
    if (isRecord(message.error)) {
      this.fail(stage, errorOf(message.error));
      return;
    }
    const result = isRecord(message.result) ? message.result : {};
    switch (stage) {
      case "initialize": {
        const capabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : {};
        const resume = this.options.resumeSession;
        if (resume !== undefined) {
          if (capabilities.loadSession !== true) {
            this.fail("session", {
              code: -32601,
              message: "the agent cannot resume a session (it does not offer session/load)",
            });
            return;
          }
          this.phase = "session";
          this.send(
            this.request("session/load", { sessionId: resume, cwd: this.options.cwd, mcpServers: this.options.mcpServers ?? [] }, "session"),
          );
          this.session = resume;
        } else {
          this.phase = "session";
          this.send(this.request("session/new", { cwd: this.options.cwd, mcpServers: this.options.mcpServers ?? [] }, "session"));
        }
        return;
      }
      case "session": {
        if (this.options.resumeSession === undefined) {
          const sessionId = result.sessionId;
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            this.fail("session", { code: -32603, message: "the agent opened a session without an id" });
            return;
          }
          this.session = sessionId;
        }
        this.phase = "config";
        this.nextStage();
        return;
      }
      case "config":
        this.nextStage();
        return;
      case "prompt": {
        const stopReason = typeof result.stopReason === "string" ? result.stopReason : "end_turn";
        this.end({
          kind: "stopped",
          stopReason,
          usage: isRecord(result.usage) ? (result.usage as AcpUsage) : null,
          meta: isRecord(result._meta) ? result._meta : null,
          sessionId: this.session ?? "",
        });
        return;
      }
    }
  }

  /** Sends the next setting, or the prompt when the settings are all applied. */
  private nextStage(): void {
    const session = this.session;
    if (session === null) return;
    const setting = this.options.config?.[this.configAt];
    if (setting !== undefined) {
      this.configAt += 1;
      this.send(
        this.request(
          "session/set_config_option",
          { sessionId: session, configId: setting.configId, value: setting.value },
          "config",
        ),
      );
      return;
    }
    this.phase = "prompt";
    this.promptSent = true;
    this.send(this.request("session/prompt", { sessionId: session, prompt: this.options.prompt }, "prompt"));
  }
}
