/**
 * The arguments an action asks a person for, read from the action's `args`
 * JSON Schema. Nothing here knows a plugin: an enum is a list to pick from, an
 * integer is a number between its bounds, a boolean is yes or no, a string a text.
 * The note argument (`role: "note"`) is not here; the note input keeps it.
 */

import type { ViewAction, ViewRow } from "@operad-io/engine";
import { sanitize } from "./sanitize.ts";

/** One value a person can pick. */
export interface ArgOption {
  readonly value: string | number | boolean;
  readonly label: string;
}

/** One argument to ask for. */
export interface ArgField {
  readonly name: string;
  readonly kind: "pick" | "number" | "text";
  readonly integer: boolean;
  readonly options: readonly ArgOption[];
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly description?: string | undefined;
  /** The option that is the current value, when the row or a default gives one. */
  readonly current?: number | undefined;
  /** An optional choice starts unset, so Enter keeps the action's default. */
  readonly optional?: boolean | undefined;
  /** The text a number or text input starts with. */
  readonly initial: string;
  /**
   * Conditionals from the schema's `allOf` (`if` an earlier field is a value,
   * `then` this field's own choices): when `by` has been answered `is`, the
   * field takes these choices instead of `options`.
   */
  readonly variants?: readonly ArgVariant[] | undefined;
}

/** The choices of a field once an earlier field has been answered. */
export interface ArgVariant {
  readonly by: string;
  readonly is: unknown;
  readonly options: readonly ArgOption[];
  readonly current?: number | undefined;
}

/** `field` as it is once `values` are answered: the variant that matches, else as it is. */
export function narrowField(field: ArgField, values: Readonly<Record<string, unknown>>): ArgField {
  const variant = field.variants?.find((one) => values[one.by] === one.is);
  if (variant === undefined) return field;
  return { ...field, options: variant.options, current: variant.current };
}

function variantsOf(schema: NonNullable<ViewAction["args"]>, name: string, seen: readonly (string | undefined)[]): ArgVariant[] {
  const found: ArgVariant[] = [];
  for (const branch of schema.allOf ?? []) {
    const condition = Object.entries(branch.if?.properties ?? {}).find(([, one]) => one.const !== undefined);
    const prop = branch.then?.properties?.[name];
    if (condition === undefined || prop?.enum === undefined || prop.enum.length === 0) continue;
    const options = prop.enum.map((value) => ({ value, label: sanitize(String(value)) }));
    const texts = [...seen.slice(0, 2), prop.default === undefined ? undefined : String(prop.default)];
    const at = texts.map((text) => (text === undefined ? -1 : options.findIndex((o) => o.label === text))).find((i) => i >= 0);
    found.push({ by: condition[0], is: condition[1].const, options, current: at });
  }
  return found;
}

export type ArgParse =
  | { readonly ok: true; readonly value: string | number | boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * The arguments of `action` other than the note, in the order it asks them:
 * the required ones, then any optional enum (a choice that starts unset).
 */
export function argFields(action: ViewAction, row: ViewRow | undefined): readonly ArgField[] {
  const schema = action.args;
  if (schema?.properties === undefined) return [];
  const names = [...(schema.required ?? [])];
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (names.includes(name) || prop.role === "note") continue;
    if (prop.enum !== undefined && prop.enum.length > 0) names.push(name);
  }
  const fields: ArgField[] = [];
  for (const name of names) {
    const prop = schema.properties[name];
    if (prop === undefined || prop.role === "note") continue;
    const description = prop.description === undefined ? undefined : sanitize(prop.description);
    const given = prop.default;
    const seen = [row?.state, row?.badge, given === undefined ? undefined : String(given)];
    if (prop.enum !== undefined && prop.enum.length > 0) {
      const options = prop.enum.map((value) => ({ value, label: sanitize(String(value)) }));
      const found = seen
        .map((text) => (text === undefined ? -1 : options.findIndex((o) => o.label === text)))
        .find((at) => at >= 0);
      const optional = !(schema.required ?? []).includes(name);
      const variants = variantsOf(schema, name, seen);
      fields.push({
        ...(variants.length === 0 ? {} : { variants }),
        name,
        kind: "pick",
        integer: false,
        options,
        description,
        current: found,
        ...(optional ? { optional: true } : {}),
        initial: "",
      });
    } else if (prop.type === "boolean") {
      const options = [
        { value: true, label: "yes" },
        { value: false, label: "no" },
      ];
      const current = given === true ? 0 : given === false ? 1 : undefined;
      fields.push({ name, kind: "pick", integer: false, options, description, current, initial: "" });
    } else if (prop.type === "integer" || prop.type === "number") {
      fields.push({
        name,
        kind: "number",
        integer: prop.type === "integer",
        options: [],
        min: prop.minimum,
        max: prop.maximum,
        description,
        initial: typeof given === "number" ? String(given) : "",
      });
    } else if (prop.type === "string") {
      fields.push({
        name,
        kind: "text",
        integer: false,
        options: [],
        min: prop.minLength,
        max: prop.maxLength,
        description,
        initial: typeof given === "string" ? sanitize(given) : "",
      });
    }
  }
  return fields;
}

/** What the field accepts, in one line: shown when a value does not fit. */
export function allowedText(field: ArgField): string {
  if (field.kind === "pick") return `${field.name}: ${field.options.map((o) => o.label).join(", ")}`;
  if (field.kind === "number") {
    const kind = field.integer ? "a whole number" : "a number";
    const range =
      field.min !== undefined && field.max !== undefined
        ? ` from ${field.min} to ${field.max}`
        : field.min !== undefined
          ? ` of at least ${field.min}`
          : field.max !== undefined
            ? ` of at most ${field.max}`
            : "";
    return `${field.name}: ${kind}${range}`;
  }
  const size =
    field.min !== undefined || field.max !== undefined
      ? ` (${field.min ?? 0} to ${field.max ?? "any"} characters)`
      : "";
  return `${field.name}: text${size}`;
}

/** Checks typed text against the field, the way the server will. */
export function parseArg(field: ArgField, text: string): ArgParse {
  const trimmed = text.trim();
  const refuse = (): ArgParse => ({ ok: false, reason: allowedText(field) });
  if (field.kind === "pick") {
    const wanted = trimmed.toLowerCase();
    const aliases: Record<string, string> = { y: "yes", n: "no", true: "yes", false: "no" };
    const option = field.options.find(
      (o) => o.label.toLowerCase() === wanted || (o.label === "yes" || o.label === "no" ? o.label === aliases[wanted] : false),
    );
    return option === undefined ? refuse() : { ok: true, value: option.value };
  }
  if (field.kind === "number") {
    if (!(field.integer ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/).test(trimmed)) return refuse();
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return refuse();
    if (field.min !== undefined && value < field.min) return refuse();
    if (field.max !== undefined && value > field.max) return refuse();
    return { ok: true, value };
  }
  const length = [...text].length;
  if (trimmed === "" || (field.min !== undefined && length < field.min)) return refuse();
  if (field.max !== undefined && length > field.max) return refuse();
  return { ok: true, value: text };
}
