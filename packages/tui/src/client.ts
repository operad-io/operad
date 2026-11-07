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

/** The fetch shape this package calls; tests pass a wrapper around the real one. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** The default fetch, so a client needs no global to be constructed. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** One object type a client can list. */
export interface TuiTypeInfo {
  readonly type: string;
  readonly title: string;
}

/** The body of `GET /v1/types`. */
export interface TuiTypes {
  readonly types: readonly TuiTypeInfo[];
}

/** What `GET /v1/objects/<id>/sections/<section>` accepts. */
export interface TuiSectionOptions {
  readonly cursor?: string | undefined;
  readonly full?: boolean | undefined;
}

/** What `POST /v1/act` carries. Only `action` is always required. */
export interface TuiActInput {
  readonly action: string;
  readonly id?: string | undefined;
  readonly args?: Readonly<Record<string, unknown>> | undefined;
  readonly note?: string | undefined;
  readonly confirmed?: boolean | undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function httpError(response: Response): Promise<TuiError> {
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
  async types(): Promise<TuiTypes> {
    return (await this.request("/v1/types")) as TuiTypes;
  }

  /** One page of a type's list; pass the previous page's `next` as the cursor. */
  async objects(type: string, cursor?: string): Promise<ViewListPage> {
    return (await this.request("/v1/objects", {
      query: { type, cursor },
    })) as ViewListPage;
  }

  /** Everything waiting for a person, with the actions each item offers. */
  async pending(): Promise<readonly PendingItem[]> {
    return (await this.request("/v1/pending")) as readonly PendingItem[];
  }

  /** The runs that are working now. */
  async running(): Promise<readonly RunningItem[]> {
    return (await this.request("/v1/running")) as readonly RunningItem[];
  }

  /** One object: its row, section directory and available actions. */
  async object(id: string): Promise<ViewObject> {
    return (await this.request(`/v1/objects/${encodeURIComponent(id)}`)) as ViewObject;
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
      },
    )) as ViewSectionContent;
  }

  /** Run one `<plugin>:<action>`; a confirm action needs `confirmed`. */
  async act(input: TuiActInput): Promise<ViewActionRun> {
    return (await this.request("/v1/act", {
      method: "POST",
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

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
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
      });
    } catch (error) {
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
