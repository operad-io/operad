import type { FlowDefinition, StepShape } from "./types.ts";

/** The keys a step's `next` map declares. */
type NextKeys<T> = T extends { readonly next: infer N } ? keyof N : never;

/**
 * The steps `defineFlow` accepts are checked here, after their literals are
 * inferred, so a wrong result name in `next` is a compile error. A missing
 * edge is not: runtime validation reports it with the step and field.
 */
export type CheckStep<T> = T extends { readonly id: string; readonly replay: "safe" | "unsafe" }
  ? T extends { readonly kind: "plugin"; readonly params: { readonly use: string; readonly params: unknown } }
    ? T
    : T extends {
          readonly kind: "wait_person";
          readonly params: { readonly prompt: string; readonly choices: infer C extends readonly string[] };
        }
      ? Exclude<NextKeys<T>, C[number] | "interrupted"> extends never
        ? T
        : { readonly error: `wait_person: not a result: ${string & Exclude<NextKeys<T>, C[number] | "interrupted">}` }
      : T extends {
            readonly kind: "wait";
            readonly params: { readonly afterSecs: number } | { readonly check: string };
          }
        ? Exclude<NextKeys<T>, "ready" | "interrupted"> extends never
          ? T
          : { readonly error: `wait: not a result: ${string & Exclude<NextKeys<T>, "ready" | "interrupted">}` }
        : T extends {
              readonly kind: "end";
              readonly params: { readonly status: "done" | "failed" | "cancelled" };
            }
          ? [NextKeys<T>] extends [never]
            ? T
            : { readonly error: "end: takes no results" }
          : { readonly error: "unknown step kind" }
  : { readonly error: "invalid step" };

export type CheckSteps<S extends readonly StepShape[]> = {
  readonly [K in keyof S]: CheckStep<S[K]>;
};

/**
 * Defines a flow. The returned value is data: an entry step id, the steps, and
 * the edges from each step's results to the next step id (or `end`).
 */
export function defineFlow<const S extends readonly StepShape[]>(
  flow: FlowDefinition<S> & { readonly steps: CheckSteps<S> },
): FlowDefinition<S> {
  return flow;
}
