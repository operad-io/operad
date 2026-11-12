/**
 * The small JSON Schema subset an action's `args` may use. The kernel validates
 * it when the plugin loads and validates the person's values against it.
 */

import type { ActionArgSchema, ActionArgsSchema } from "./types.ts";
import { canonical } from "./paging.ts";
import { isRecord } from "../util.ts";

const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "items",
  "minItems",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "deprecated",
  "readOnly",
  "minProperties",
  "pattern",
  "const",
  "oneOf",
  "$ref",
  "$defs",
  "$schema",
  "$id",
  "title",
  "additionalProperties",
  "default",
  "description",
  "role",
  "format",
  "editable",
  "confirm",
]);

const TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

/** A person's values do not fit the action's schema. */
export class ActionArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionArgsError";
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function schemaError(message: string): never {
  throw new Error(message);
}

/** The `$defs` of the schema's root, and the references being followed. */
interface Context {
  readonly defs: Record<string, unknown>;
  readonly following: string[];
}

function normalizeSchema(
  value: unknown,
  at: string,
  context: Context,
): ActionArgSchema {
  if (!isRecord(value)) {
    throw new Error(`${at}: must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!KEYWORDS.has(key)) {
      throw new Error(`${at}: unknown keyword "${key}"`);
    }
  }

  if (value.$ref !== undefined) {
    const ref = value.$ref;
    const name =
      typeof ref === "string" && ref.startsWith("#/$defs/")
        ? ref.slice("#/$defs/".length)
        : undefined;
    if (name === undefined || !Object.hasOwn(context.defs, name)) {
      throw new Error(`${at}.$ref: must name an entry of the schema's $defs, as #/$defs/<name>`);
    }
    if (context.following.includes(name)) {
      throw new Error(`${at}.$ref: "${name}" refers to itself`);
    }
    const { $ref: _ref, ...siblings } = value;
    const target = normalizeSchema(
      context.defs[name],
      `${at}.$ref`,
      { defs: context.defs, following: [...context.following, name] },
    );
    const own = normalizeSchema(siblings, at, context);
    return { ...target, ...own };
  }

  const type = value.type;
  if (type !== undefined && (typeof type !== "string" || !TYPES.has(type))) {
    throw new Error(`${at}.type: must be one of ${[...TYPES].join(", ")}`);
  }

  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    throw new Error(`${at}.description: must be a string`);
  }

  const role = value.role;
  if (role !== undefined && role !== "note") {
    throw new Error(`${at}.role: must be "note"`);
  }
  if (role === "note" && type !== "string") {
    throw new Error(`${at}.role: a note property must have type "string"`);
  }

  const format = value.format;
  if (format !== undefined) {
    if (format !== "file") throw new Error(`${at}.format: must be "file"`);
    if (type !== "string") throw new Error(`${at}.format: a file property must have type "string"`);
  }

  for (const key of ["editable", "confirm"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`${at}.${key}: must be a boolean`);
    }
  }

  const enumValues = value.enum;
  if (
    enumValues !== undefined &&
    (!Array.isArray(enumValues) ||
      !enumValues.every(
        (item) =>
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      ))
  ) {
    throw new Error(`${at}.enum: must be an array of strings, numbers or booleans`);
  }

  const numeric: Record<string, number | undefined> = {};
  for (const key of [
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minProperties",
  ] as const) {
    const item = value[key];
    if (item !== undefined && typeof item !== "number") {
      throw new Error(`${at}.${key}: must be a number`);
    }
    numeric[key] = typeof item === "number" ? item : undefined;
  }

  const pattern = value.pattern;
  if (pattern !== undefined) {
    if (typeof pattern !== "string") throw new Error(`${at}.pattern: must be a string`);
    try {
      new RegExp(pattern);
    } catch {
      throw new Error(`${at}.pattern: is not a regular expression`);
    }
  }

  let oneOf: ActionArgSchema[] | undefined;
  if (value.oneOf !== undefined) {
    if (!Array.isArray(value.oneOf) || value.oneOf.length === 0) {
      throw new Error(`${at}.oneOf: must be a non-empty array of schemas`);
    }
    oneOf = value.oneOf.map((branch: unknown, index: number) =>
      normalizeSchema(branch, `${at}.oneOf[${index}]`, context),
    );
  }

  const additionalRaw = value.additionalProperties;
  const additional: false | ActionArgSchema | undefined =
    additionalRaw === undefined || additionalRaw === false
      ? additionalRaw
      : isRecord(additionalRaw)
        ? normalizeSchema(additionalRaw, `${at}.additionalProperties`, context)
        : schemaError(`${at}.additionalProperties: must be false or a schema`);

  let properties: Record<string, ActionArgSchema> | undefined;
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      throw new Error(`${at}.properties: must be an object`);
    }
    properties = {};
    for (const [name, schema] of Object.entries(value.properties)) {
      properties[name] = normalizeSchema(schema, `${at}.properties.${name}`, context);
    }
  }

  let required: string[] | undefined;
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      !value.required.every((item) => typeof item === "string")
    ) {
      throw new Error(`${at}.required: must be an array of field names`);
    }
    required = value.required as string[];
    for (const name of required) {
      if (properties === undefined || properties[name] === undefined) {
        throw new Error(`${at}.required: "${name}" is not a property`);
      }
    }
  }

  let items: ActionArgSchema | undefined;
  if (value.items !== undefined) {
    items = normalizeSchema(value.items, `${at}.items`, context);
  }
  if (items !== undefined && type !== undefined && type !== "array") {
    throw new Error(`${at}.items: only an array has items`);
  }

  return {
    ...(type === undefined ? {} : { type: type as ActionArgSchema["type"] }),
    ...(enumValues === undefined
      ? {}
      : { enum: enumValues as (string | number | boolean)[] }),
    ...(numeric.minimum === undefined ? {} : { minimum: numeric.minimum }),
    ...(numeric.maximum === undefined ? {} : { maximum: numeric.maximum }),
    ...(numeric.minLength === undefined ? {} : { minLength: numeric.minLength }),
    ...(numeric.maxLength === undefined ? {} : { maxLength: numeric.maxLength }),
    ...(numeric.minItems === undefined ? {} : { minItems: numeric.minItems }),
    ...(numeric.exclusiveMinimum === undefined
      ? {}
      : { exclusiveMinimum: numeric.exclusiveMinimum }),
    ...(numeric.minProperties === undefined
      ? {}
      : { minProperties: numeric.minProperties }),
    ...(numeric.exclusiveMaximum === undefined
      ? {}
      : { exclusiveMaximum: numeric.exclusiveMaximum }),
    ...(pattern === undefined ? {} : { pattern: pattern as string }),
    ...(Object.hasOwn(value, "const") ? { const: value.const } : {}),
    ...(oneOf === undefined ? {} : { oneOf }),
    ...(properties === undefined ? {} : { properties }),
    ...(required === undefined ? {} : { required }),
    ...(items === undefined ? {} : { items }),
    ...(additional === undefined ? {} : { additionalProperties: additional }),
    ...(value.default === undefined ? {} : { default: value.default }),
    ...(description === undefined ? {} : { description }),
    ...(role === "note" ? { role } : {}),
    ...(format === "file" ? { format } : {}),
    ...(value.editable === undefined ? {} : { editable: value.editable as boolean }),
    ...(value.confirm === undefined ? {} : { confirm: value.confirm as boolean }),
  };
}

/** Validates the schema a plugin declares at load; the label names the action. */
export function normalizeActionArgs(
  value: unknown,
  at: string,
): ActionArgsSchema | undefined {
  if (value === undefined) return undefined;
  let defs: Record<string, unknown> = {};
  if (isRecord(value) && value.$defs !== undefined) {
    if (!isRecord(value.$defs)) throw new Error(`${at}.$defs: must be an object`);
    defs = value.$defs;
  }
  const normalized = normalizeSchema(value, at, { defs, following: [] });
  if (normalized.type !== "object") {
    throw new Error(`${at}: type: must be "object"`);
  }
  return normalized as ActionArgsSchema;
}

/** The note property of a schema, when it declares one. */
export function noteProperty(
  schema: ActionArgsSchema | undefined,
): { readonly name: string; readonly required: boolean } | undefined {
  if (schema?.properties === undefined) return undefined;
  for (const [name, property] of Object.entries(schema.properties)) {
    if (property.role === "note") {
      return {
        name,
        required: schema.required?.includes(name) === true,
      };
    }
  }
  return undefined;
}

/**
 * The properties of an action's arguments that take a file: a string with
 * `format: "file"`, or a list of them. The value is the upload's reference.
 */
export function fileProperties(
  schema: ActionArgsSchema | undefined,
): readonly { readonly name: string; readonly many: boolean }[] {
  const found: { name: string; many: boolean }[] = [];
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    if (property.format === "file") found.push({ name, many: false });
    else if (property.type === "array" && property.items?.format === "file") {
      found.push({ name, many: true });
    }
  }
  return found;
}

function fail(label: string, field: string, detail: string): never {
  throw new ActionArgsError(`${label}: args.${field}: ${detail}`);
}

function fieldName(path: string, name: string): string {
  return path.length === 0 ? name : `${path}.${name}`;
}

const TYPE_WORDS: Record<string, string> = {
  string: "text",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
};

/** What a schema accepts, in words a person reads. */
function describeSchema(schema: ActionArgSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum !== undefined) {
    return `one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
  }
  if (schema.oneOf !== undefined) {
    return schema.oneOf.map(describeSchema).join(" or ");
  }
  if (schema.type === "string") {
    const kind = schema.minLength !== undefined && schema.minLength > 0 ? "non-empty text" : "text";
    return schema.pattern === undefined ? kind : `${kind} written as ${schema.pattern}`;
  }
  if (schema.type === "object") {
    const fixed = Object.entries(schema.properties ?? {}).find(
      ([, property]) => property.const !== undefined,
    );
    const names = Object.keys(schema.properties ?? {});
    const base = fixed === undefined ? "an object" : `an object with ${fixed[0]} ${JSON.stringify(fixed[1].const)}`;
    return fixed === undefined && names.length > 0
      ? `${base} with the fields ${names.join(", ")}`
      : base;
  }
  if (schema.type === "array") {
    return schema.items === undefined ? "a list" : `a list of ${describeSchema(schema.items)}`;
  }
  return schema.type === undefined ? "any value" : (TYPE_WORDS[schema.type] ?? schema.type);
}

function fits(schema: ActionArgSchema, value: unknown): boolean {
  try {
    checkValue(schema, value, "", "");
    return true;
  } catch (error) {
    if (error instanceof ActionArgsError) return false;
    throw error;
  }
}

function typeFits(schema: ActionArgSchema, actual: string): boolean {
  if (schema.type === undefined) return true;
  return schema.type === actual || (schema.type === "number" && actual === "integer");
}

function checkOneOf(
  branches: readonly ActionArgSchema[],
  value: unknown,
  label: string,
  field: string,
): void {
  const matching = branches.filter((branch) => fits(branch, value));
  if (matching.length === 1) return;
  if (matching.length > 1) {
    fail(label, field, "fits more than one of the accepted forms");
  }
  // Exactly one branch is of the value's kind: its own reason is the useful one.
  const actual = typeOf(value);
  const sameKind = branches.filter((branch) => typeFits(branch, actual));
  const [only] = sameKind;
  if (sameKind.length === 1 && only !== undefined) {
    checkValue(only, value, label, field);
  }
  fail(label, field, `must be ${branches.map(describeSchema).join(" or ")}`);
}

function checkValue(
  schema: ActionArgSchema,
  value: unknown,
  label: string,
  field: string,
): void {
  if (schema.oneOf !== undefined) {
    checkOneOf(schema.oneOf, value, label, field);
  }
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const matches =
      schema.type === actual ||
      (schema.type === "number" && actual === "integer");
    if (!matches) {
      fail(label, field, `must be a ${schema.type}, got ${actual}`);
    }
  }

  if (schema.const !== undefined && canonical(schema.const) !== canonical(value)) {
    fail(label, field, `must be ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((item) => canonical(item) === canonical(value))) {
      const allowed = schema.enum
        .map((item) => JSON.stringify(item))
        .join(", ");
      fail(label, field, `${JSON.stringify(value)} is not one of ${allowed}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(label, field, `must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(label, field, `must be at most ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      fail(label, field, `must be more than ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      fail(label, field, `must be less than ${schema.exclusiveMaximum}`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(label, field, `must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(label, field, `must be at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      fail(label, field, `must be written as ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(label, field, `must have at least ${schema.minItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        checkValue(schema.items as ActionArgSchema, item, label, fieldName(field, String(index)));
      });
    }
  }

  if (
    isRecord(value) &&
    schema.minProperties !== undefined &&
    Object.keys(value).length < schema.minProperties
  ) {
    fail(label, field, `must have at least ${schema.minProperties} fields`);
  }

  if (
    isRecord(value) &&
    (schema.properties !== undefined || typeof schema.additionalProperties === "object")
  ) {
    checkObject(schema, value, label, field);
  }
}

function checkObject(
  schema: ActionArgSchema,
  value: Record<string, unknown>,
  label: string,
  field: string,
): void {
  for (const name of schema.required ?? []) {
    if (value[name] === undefined) {
      fail(label, fieldName(field, name), "is required");
    }
  }
  for (const [name, item] of Object.entries(value)) {
    const property = schema.properties?.[name];
    if (property === undefined) {
      if (schema.additionalProperties === false) {
        fail(label, fieldName(field, name), "is not a field of this action");
      }
      if (typeof schema.additionalProperties === "object") {
        checkValue(schema.additionalProperties, item, label, fieldName(field, name));
      }
      continue;
    }
    checkValue(property, item, label, fieldName(field, name));
  }
}

/**
 * Validates one value against a normalized schema. The label and field prefix
 * the message, so a settings section names its plugin and its field.
 */
export function validateSchemaValue(
  schema: ActionArgSchema,
  value: unknown,
  label: string,
  field: string,
): void {
  checkValue(schema, value, label, field);
}

/**
 * Validates a person's values against an action's schema. The returned object
 * is the same value; omitted optional fields stay omitted.
 */
export function validateActionArgs(
  schema: ActionArgsSchema | undefined,
  args: unknown,
  label: string,
): Record<string, unknown> {
  if (args === undefined) {
    args = {};
  }
  if (!isRecord(args)) {
    throw new ActionArgsError(`${label}: args: must be an object`);
  }
  if (schema !== undefined) {
    checkObject(schema, args, label, "");
  }
  return args;
}
