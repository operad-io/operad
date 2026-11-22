/**
 * The line protocol between `pi/login` and its child program (ADR 0023 D11).
 * The hub writes one JSON per line to the child's stdin; the child writes one
 * JSON per line to its stdout. The shapes carry only JSON; an abort signal and
 * anything the person's value would echo stay out.
 */

/** How a provider can log in, as pi's own provider list declares it. */
export interface LoginProvider {
  readonly id: string;
  readonly name: string;
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
  ;

/** A notice pi's login flow shows while it works, without its abort signal. */
export type LoginNotice =
  | {
      readonly type: "info";
      readonly message: string;
      readonly links?: readonly { readonly url: string; readonly label?: string }[];
    }
  | { readonly type: "progress"; readonly message: string };

/** What the hub writes to the child. */
export type LoginCommand =
  | { readonly type: "login"; readonly provider: string; readonly auth: "api_key" }
  | { readonly type: "answer"; readonly id: number; readonly value: string }
  | { readonly type: "cancel" };

/** What the child writes to the hub, in order. */
export type LoginLine =
  | { readonly type: "providers"; readonly providers: readonly LoginProvider[] }
  | { readonly type: "prompt"; readonly id: number; readonly prompt: LoginPrompt }
  | { readonly type: "notice"; readonly event: LoginNotice }
  | { readonly type: "done"; readonly provider: string; readonly auth: "api_key" }
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
