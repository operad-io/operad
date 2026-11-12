/**
 * A fake pi model provider for the tests.
 *
 * pi ships a faux provider in `@earendil-works/pi-ai`, but
 * `@earendil-works/pi-coding-agent` 1.5.0 does not re-export it. This module
 * therefore registers a custom provider whose `streamSimple` returns a fixed
 * assistant message (text and optionally one tool call).
 */

import type { ModelRuntime, ProviderConfig } from "@earendil-works/pi-coding-agent";

type StreamFunction = NonNullable<ProviderConfig["streamSimple"]>;
type PiStream = ReturnType<StreamFunction>;
type PiStreamEvent = PiStream extends AsyncIterable<infer Event> ? Event : never;
type PiModel = Parameters<StreamFunction>[0];
type PiContext = Parameters<StreamFunction>[1];
type PiOptions = NonNullable<Parameters<StreamFunction>[2]>;
type AssistantMessage = Extract<PiStreamEvent, { type: "done" }>["message"];
type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export interface FakeToolCall {
  name: string;
  arguments: ToolCall["arguments"];
}

export interface FakeResponse {
  /** Text in the assistant message. */
  text: string;
  /** Thinking in the assistant message, before the text and the tool call. */
  thinking?: string;
  /** One tool call in the assistant message. */
  toolCall?: FakeToolCall;
  /** Cost in USD the message reports; default 0. */
  cost?: number;
  /** The message carries no price at all, as for a model pi cannot price. */
  noPrice?: boolean;
  /** Wait for this before streaming the content; aborting interrupts the wait. */
  before?: Promise<void>;
  /** Streams its content and then never finishes; an abort ends it. */
  endless?: boolean;
}

const CHUNK_SIZE = 4;

function chunks(text: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < text.length; index += CHUNK_SIZE) {
    result.push(text.slice(index, index + CHUNK_SIZE));
  }
  return result.length > 0 ? result : [""];
}

class FakeEventStream implements AsyncIterable<PiStreamEvent> {
  readonly #queue: PiStreamEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<PiStreamEvent>) => void> = [];
  readonly #drained: Promise<void>;
  #markDrained: (() => void) | undefined;
  #closed = false;

  constructor() {
    this.#drained = new Promise<void>((resolve) => {
      this.#markDrained = resolve;
    });
  }

  /** Resolves when the consumer has taken every queued event and waits for more. */
  drained(): Promise<void> {
    return this.#drained;
  }

  push(event: PiStreamEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.#queue.push(event);
  }

  end(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<PiStreamEvent> {
    while (true) {
      const event = this.#queue.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      if (this.#closed) return;
      this.#markDrained?.();
      this.#markDrained = undefined;
      const next = await new Promise<IteratorResult<PiStreamEvent>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done) return;
      if (next.value !== undefined) yield next.value;
    }
  }
}

async function waitFor(promise: Promise<void>, signal: AbortSignal | undefined): Promise<"done" | "aborted"> {
  if (signal === undefined) {
    await promise;
    return "done";
  }
  if (signal.aborted) return "aborted";
  return new Promise<"done" | "aborted">((resolve, reject) => {
    const onAbort = (): void => {
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve("done");
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class FakeProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly contexts: PiContext[] = [];
  /** Called each time pi starts a stream. */
  onStream: (() => void) | undefined;

  readonly #responses: FakeResponse[] = [];
  readonly #started: Promise<void>;
  #markStarted: (() => void) | undefined;
  #startCount = 0;

  /** Called when an endless stream has handed every event to the consumer. */
  onEndless: (() => void) | undefined;

  constructor(providerId = "fake", modelId = "fake-model") {
    this.providerId = providerId;
    this.modelId = modelId;
    this.#started = new Promise<void>((resolve) => {
      this.#markStarted = resolve;
    });
  }

  /** Resolves when the fake stream is first entered. */
  get started(): Promise<void> {
    return this.#started;
  }

  get startCount(): number {
    return this.#startCount;
  }

  enqueue(response: FakeResponse): void {
    this.#responses.push(response);
  }

  register(runtime: ModelRuntime): void {
    const streamSimple: StreamFunction = (model, context, options) => {
      this.contexts.push(context);
      this.#startCount += 1;
      this.#markStarted?.();
      this.onStream?.();
      const stream = new FakeEventStream();
      void this.#run(stream, model, options);
      return stream as unknown as PiStream;
    };

    const config: ProviderConfig = {
      name: "Fake",
      apiKey: "fake-key",
      api: "fake-api",
      baseUrl: "https://fake.invalid",
      streamSimple,
      models: [
        {
          id: this.modelId,
          name: "Fake Model",
          api: "fake-api",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4_096,
        },
      ],
    };
    runtime.registerProvider(this.providerId, config);
  }

  #message(model: PiModel, response: FakeResponse): AssistantMessage {
    const content: AssistantMessage["content"] = [];
    if (response.thinking !== undefined && response.thinking.length > 0) {
      content.push({ type: "thinking", thinking: response.thinking });
    }
    if (response.toolCall !== undefined) {
      const call: ToolCall = {
        type: "toolCall",
        id: `fake-tool-${this.#startCount}`,
        name: response.toolCall.name,
        arguments: response.toolCall.arguments,
      };
      content.push(call);
    }
    if (response.text.length > 0 || content.length === 0) {
      content.push({ type: "text", text: response.text });
    }
    const output = response.text.length + (response.thinking?.length ?? 0) + (response.toolCall === undefined ? 0 : 8);
    const input = 12;
    const message: AssistantMessage = {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input,
        output,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: input + output + 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: response.cost ?? 0 },
      },
      stopReason: response.toolCall === undefined ? "stop" : "toolUse",
      timestamp: Date.now(),
    };
    if (response.noPrice === true) Reflect.deleteProperty(message.usage, "cost");
    return message;
  }

  async #run(stream: FakeEventStream, model: PiModel, options: PiOptions | undefined): Promise<void> {
    const response = this.#responses.shift();
    if (response === undefined) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "No more fake responses queued",
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error: message });
      stream.end();
      return;
    }

    const message = this.#message(model, response);
    const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
    stream.push({ type: "start", partial: { ...partial, content: [] } });

    if (response.before !== undefined) {
      const outcome = await waitFor(response.before, options?.signal);
      if (outcome === "aborted") {
        const aborted: AssistantMessage = {
          ...message,
          content: [],
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        };
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end();
        return;
      }
    }

    if (options?.signal?.aborted === true) {
      const aborted: AssistantMessage = {
        ...message,
        content: [],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end();
      return;
    }

    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index];
      if (block === undefined) continue;
      if (block.type === "thinking") {
        partial.content = [{ type: "thinking", thinking: "" }];
        stream.push({ type: "thinking_start", contentIndex: index, partial: { ...partial } });
        for (const chunk of chunks(block.thinking)) {
          const current = partial.content[0];
          partial.content = [
            {
              type: "thinking",
              thinking: `${current !== undefined && current.type === "thinking" ? current.thinking : ""}${chunk}`,
            },
          ];
          stream.push({ type: "thinking_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
        }
        stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: { ...partial } });
        continue;
      }
      if (block.type === "text") {
        partial.content = [{ type: "text", text: "" }];
        stream.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
        for (const chunk of chunks(block.text)) {
          const current = partial.content[0];
          partial.content = [
            { type: "text", text: `${current !== undefined && current.type === "text" ? current.text : ""}${chunk}` },
          ];
          stream.push({ type: "text_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
        }
        stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...partial } });
        continue;
      }
      if (block.type === "toolCall") {
        partial.content = [{ type: "toolCall", id: block.id, name: block.name, arguments: {} }];
        stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
        for (const chunk of chunks(JSON.stringify(block.arguments))) {
          stream.push({ type: "toolcall_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
        }
        partial.content = [block];
        stream.push({
          type: "toolcall_end",
          contentIndex: index,
          toolCall: block,
          partial: { ...partial },
        });
      }
    }

    const reason = message.stopReason === "toolUse" ? "toolUse" : "stop";
    if (response.endless === true) {
      const drained = await waitFor(stream.drained(), options?.signal);
      if (drained === "aborted") {
        const aborted: AssistantMessage = {
          ...message,
          content: [],
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        };
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end();
        return;
      }
      this.onEndless?.();
      const outcome = await waitFor(new Promise<void>(() => {}), options?.signal);
      if (outcome === "aborted") {
        const aborted: AssistantMessage = {
          ...message,
          content: [],
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        };
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end();
      }
      return;
    }
    stream.push({ type: "done", reason, message });
    stream.end();
  }
}
