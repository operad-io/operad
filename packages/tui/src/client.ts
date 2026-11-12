/**
 * The `/v1` client every terminal screen calls. It carries one bearer token,
 * turns each endpoint into one method, and keeps the server's own error message
 * on a typed error. It never opens the store and knows no plugin name.
 */

import type {
  PendingItem,
  RunningItem,
  ViewActionRun,
  ViewListPage,
  ViewObject,
  ViewSectionContent,
} from "@operad-io/engine";
import { isRecord, messageOf } from "@operad-io/engine";

/** The fetch shape this package calls; tests pass a wrapper around the real one. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** The default fetch, so a client needs no global to be constructed. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** One level of the hierarchy a list asks for: the top level, or the objects under one. */
export interface TuiLevel {
  readonly root?: boolean | undefined;
  readonly parent?: string | undefined;
}

/** One object type a client can list. */
export interface TuiTypeInfo {
  readonly type: string;
  readonly title: string;
  /** The plugin the type belongs to. */
  readonly plugin?: string;
  /** The type's filters in display order; absent when it declares none. */
  readonly filters?: readonly { readonly name: string; readonly states?: readonly string[] }[] | undefined;
  /** The filter a list opens on; present with `filters`. */
  readonly defaultFilter?: string | undefined;
  /** The object types an action that creates this type works on; absent when none does. */
  readonly parents?: readonly string[] | undefined;
}

/** One entry of `GET /v1/keys`. */
export interface TuiKeyBinding {
  readonly key: string;
  readonly action: string;
  readonly source: "plugin" | "user";
}

/** One entry of `GET /v1/settings`. */
export interface TuiSetting {
  /** `<plugin>.<path>`; a project file adds its name. */
  readonly name: string;
  /** `global`, or the name of the repository the setting belongs to. */
  readonly scope: string;
  readonly value?: unknown;
  readonly default?: unknown;
  readonly description?: string | undefined;
  readonly type?: string | undefined;
  readonly enum?: readonly (string | number | boolean)[] | undefined;
  readonly editable: boolean;
  readonly confirm: boolean;
}

/** What `POST /v1/settings` carries. */
export interface TuiSetInput {
  readonly name: string;
  readonly value: unknown;
  readonly scope?: string | undefined;
  readonly confirmed?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The body of `GET /v1/types`. */
export interface TuiTypes {
  readonly types: readonly TuiTypeInfo[];
}

/** What `GET /v1/objects/<id>/sections/<section>` accepts. */
export interface TuiSectionOptions {
  readonly cursor?: string | undefined;
  readonly full?: boolean | undefined;
  /** Cancels the request; it then rejects. */
  readonly signal?: AbortSignal | undefined;
}

/** What `POST /v1/act` carries. Only `action` is always required. */
export interface TuiActInput {
  readonly action: string;
  readonly id?: string | undefined;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  readonly note?: string | undefined;
  readonly confirmed?: boolean | undefined;
  /** Cancels the request; it then rejects. */
  readonly signal?: AbortSignal | undefined;
}

/** Options for a client: where the server is and the token it checks. */
export interface TuiClientOptions {
  readonly url: string;
  readonly token: string;
  readonly fetch?: FetchLike | undefined;
}

/** Extra fields every TUI error may carry. */
export interface TuiErrorOptions {
  readonly status?: number | undefined;
  readonly kind?: string | undefined;
  readonly cause?: unknown;
}

/** The base of every error this client raises. */
export class TuiError extends Error {
  readonly status: number | undefined;
  readonly kind: string | undefined;

  constructor(message: string, options: TuiErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TuiError";
    this.status = options.status;
    this.kind = options.kind;
  }
}

/** The server refused the bearer token (`401`). */
export class TuiUnauthorizedError extends TuiError {
  constructor(kind: string | undefined, message: string) {
    super(message, { status: 401, kind });
    this.name = "TuiUnauthorizedError";
  }
}

/** The object, section, action or endpoint does not exist (`404`). */
export class TuiNotFoundError extends TuiError {
  constructor(kind: string | undefined, message: string) {
    super(message, { status: 404, kind });
    this.name = "TuiNotFoundError";
  }
}

/** The action is unavailable, needs confirmation, or its plugin is off (`409`). */
export class TuiConflictError extends TuiError {
  constructor(kind: string | undefined, message: string) {
    super(message, { status: 409, kind });
    this.name = "TuiConflictError";
  }
}

/** The request body is larger than one mebibyte (`413`). */
export class TuiPayloadTooLargeError extends TuiError {
  constructor(kind: string | undefined, message: string) {
    super(message, { status: 413, kind });
    this.name = "TuiPayloadTooLargeError";
  }
}

/** The action's plugin refused it (`422`); the message is the plugin's own. */
export class TuiRefusedError extends TuiError {
  constructor(kind: string | undefined, message: string) {
    super(message, { status: 422, kind });
    this.name = "TuiRefusedError";
  }
}

/** A section did not load in time (`504`). */
export class TuiTimeoutError extends TuiError {
  constructor(kind: string | undefined, message: string) {
    super(message, { status: 504, kind });
    this.name = "TuiTimeoutError";
  }
}

/** No server answered at the URL; there is no server message to keep. */
export class TuiUnreachableError extends TuiError {
  constructor(message: string, cause?: unknown) {
    super(message, { kind: "unreachable", cause });
    this.name = "TuiUnreachableError";
  }
}

/** The URL a client was given is not an http(s) base URL. */
export class TuiUrlError extends TuiError {
  constructor(message: string) {
    super(message, { kind: "url" });
    this.name = "TuiUrlError";
  }
}

/**
 * The base URL without a trailing slash. It must be an http or https URL with
 * no credentials, query or fragment, as the pairing URL does.
 */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TuiUrlError(`"${value}" is not an http or https URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TuiUrlError(
      "the URL must be http or https, without credentials, a query or a fragment",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

interface ServerErrorBody {
  readonly kind: string | undefined;
  readonly message: string;
}

function serverErrorBody(text: string, status: number): ServerErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      kind: undefined,
      message: text.length > 0 ? text : `the server answered ${status}`,
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) {
    return { kind: undefined, message: `the server answered ${status}` };
  }
  const kind = parsed.error.kind;
  const message = parsed.error.message;
  return {
    kind: typeof kind === "string" ? kind : undefined,
    message:
      typeof message === "string"
        ? message
        : `the server answered ${status}`,
  };
}

/** The typed error for a non-ok response; it reads the body. */
export async function httpError(response: Response): Promise<TuiError> {
  const text = await response.text().catch(() => "");
  const body = serverErrorBody(text, response.status);
  switch (response.status) {
    case 401:
      return new TuiUnauthorizedError(body.kind, body.message);
    case 404:
      return new TuiNotFoundError(body.kind, body.message);
    case 409:
      return new TuiConflictError(body.kind, body.message);
    case 413:
      return new TuiPayloadTooLargeError(body.kind, body.message);
    case 422:
      return new TuiRefusedError(body.kind, body.message);
    case 504:
      return new TuiTimeoutError(body.kind, body.message);
    default:
      return new TuiError(body.message, {
        status: response.status,
        kind: body.kind,
      });
  }
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | undefined;
  readonly query?: Readonly<Record<string, string | undefined>> | undefined;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
}

/** One client for one running `serve`. */
export class TuiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: TuiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.url);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  /** The types the loaded plugins show, with their display names. */
  async types(signal?: AbortSignal): Promise<TuiTypes> {
    return (await this.request("/v1/types", { signal })) as TuiTypes;
  }

  /** The key bindings in force: plugin defaults with the person's overrides. */
  async keys(signal?: AbortSignal): Promise<readonly TuiKeyBinding[]> {
    const body = (await this.request("/v1/keys", { signal })) as {
      readonly keys: readonly TuiKeyBinding[];
    };
    return body.keys;
  }

  /** One page of a type's list; pass the previous page's `next` as the cursor. */
  async objects(
    type: string,
    cursor?: string,
    signal?: AbortSignal,
    filter?: string,
    level?: TuiLevel,
  ): Promise<ViewListPage> {
    return (await this.request("/v1/objects", {
      query: {
        type,
        cursor,
        filter,
        ...(level?.root === true ? { root: "1" } : {}),
        ...(level?.parent === undefined ? {} : { parent: level.parent }),
      },
      signal,
    })) as ViewListPage;
  }

  /** Everything waiting for a person, with the actions each item offers. */
  async pending(signal?: AbortSignal): Promise<readonly PendingItem[]> {
    return (await this.request("/v1/pending", { signal })) as readonly PendingItem[];
  }

  /** The runs that are working now. */
  async running(signal?: AbortSignal): Promise<readonly RunningItem[]> {
    return (await this.request("/v1/running", { signal })) as readonly RunningItem[];
  }

  /** One object: its row, section directory and available actions. */
  async object(id: string, signal?: AbortSignal): Promise<ViewObject> {
    return (await this.request(`/v1/objects/${encodeURIComponent(id)}`, {
      signal,
    })) as ViewObject;
  }

  /** One section's Markdown; `full` skips the server's size cap. */
  async section(
    id: string,
    section: string,
    options: TuiSectionOptions = {},
  ): Promise<ViewSectionContent> {
    return (await this.request(
      `/v1/objects/${encodeURIComponent(id)}/sections/${encodeURIComponent(section)}`,
      {
        query: {
          cursor: options.cursor,
          full: options.full === true ? "true" : undefined,
        },
        signal: options.signal,
      },
    )) as ViewSectionContent;
  }

  /** Run one `<plugin>:<action>`; a confirm action needs `confirmed`. */
  async act(input: TuiActInput): Promise<ViewActionRun> {
    return (await this.request("/v1/act", {
      method: "POST",
      signal: input.signal,
      body: {
        action: input.action,
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.confirmed === undefined
          ? {}
          : { confirmed: input.confirmed }),
      },
    })) as ViewActionRun;
  }

  /** The settings of one scope (`global`, or a repository's name). */
  async settings(scope?: string, signal?: AbortSignal): Promise<readonly TuiSetting[]> {
    const body = (await this.request("/v1/settings", {
      query: { scope },
      signal,
    })) as { readonly settings: readonly TuiSetting[] };
    return body.settings;
  }

  /** Change one setting; the server validates the value and refuses with its reason. */
  async setSetting(input: TuiSetInput): Promise<TuiSetting> {
    return (await this.request("/v1/settings", {
      method: "POST",
      signal: input.signal,
      body: {
        name: input.name,
        value: input.value,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.confirmed === true ? { confirmed: true } : {}),
      },
    })) as TuiSetting;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      "x-operad-client": "tui",
      accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // A cancelled request is the caller's own doing, not an unreachable server.
      if (options.signal?.aborted === true) throw error;
      throw new TuiUnreachableError(
        `no server answered at ${this.baseUrl}: ${messageOf(error)}`,
        error,
      );
    }

    if (!response.ok) throw await httpError(response);
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      throw new TuiError(
        `the server answered ${response.status} without JSON`,
        { status: response.status, cause: error },
      );
    }
  }
}
