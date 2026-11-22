/**
 * The line protocol between `pi/login` and its child program (ADR 0023 D11).
 * The hub writes one JSON per line to the child's stdin; the child writes one
 * JSON per line to its stdout. The shapes carry only JSON; an abort signal and
 * anything the person's value would echo stay out.
 */

/** How a provider can sign in, as pi's own provider list declares it. */
export interface LoginProvider {
  readonly id: string;
  readonly name: string;
  /** The OAuth (subscription) route, with pi's own labels. */
  readonly oauth?: { readonly name: string; readonly label?: string | undefined } | undefined;
  /** The API-key route, with pi's own name for it. */
  readonly apiKey?: { readonly name: string } | undefined;
}

/** A prompt pi's login flow puts to the person, without its abort signal. */
export type LoginPrompt =
  | { readonly type: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "secret"; readonly message: string; readonly placeholder?: string }
  | {
      readonly type: "select";
      readonly message: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }[];
    }
  | { readonly type: "manual_code"; readonly message: string; readonly placeholder?: string };

/** A notice pi's login flow shows while it works, without its abort signal. */
export type LoginNotice =
  | {
      readonly type: "info";
      readonly message: string;
      readonly links?: readonly { readonly url: string; readonly label?: string }[];
    }
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | {
      readonly type: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly openBrowserOnConfirm?: boolean;
      readonly copyCodeOnConfirm?: boolean;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly type: "progress"; readonly message: string };

/** What the hub writes to the child. */
export type LoginCommand =
  | { readonly type: "login"; readonly provider: string; readonly auth: "oauth" | "api_key" }
  | { readonly type: "answer"; readonly id: number; readonly value: string }
  | { readonly type: "cancel" };

/** What the child writes to the hub, in order. */
export type LoginLine =
  | { readonly type: "providers"; readonly providers: readonly LoginProvider[] }
  | { readonly type: "prompt"; readonly id: number; readonly prompt: LoginPrompt }
  | { readonly type: "notice"; readonly event: LoginNotice }
  | { readonly type: "done"; readonly provider: string; readonly auth: "oauth" | "api_key" }
  | { readonly type: "failed"; readonly message: string };

/** What the child is started with, as one argument. */
export interface LoginStart {
  readonly authPath: string;
  /** The custom models file, or null for none. */
  readonly modelsPath: string | null;
  /** The operad home, where operad's own pi may be installed. */
  readonly home: string;
  /** The pi command or package path the settings name. */
  readonly command: string;
  /** The cwd a relative pi command is resolved from. */
  readonly cwd: string;
}

/** The most an authorization address may be; the same bound the kernel checks. */
export const MAX_LOGIN_URL = 2048;

/**
 * The address a client may show for a login, or undefined when it is not one:
 * an absolute `https` address, or the loopback `http` address of the OAuth
 * callback. The plugin checks this before an address reaches a question
 * (ADR 0008 D8); the kernel's own check is only the scheme.
 */
export function loginUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LOGIN_URL) return undefined;
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
    return url.href;
  }
  return undefined;
}

/** The authorization URL of the ChatGPT login, or undefined when it is not one. */
export function codexAuthUrl(value: unknown): string | undefined {
  const url = loginUrl(value);
  if (url === undefined) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "auth.openai.com") return undefined;
  if (parsed.pathname !== "/oauth/authorize") return undefined;
  if (parsed.searchParams.get("redirect_uri") !== "http://localhost:1455/auth/callback") return undefined;
  return url;
}
