/**
 * A plugin knows the type of the object it acts on, so it names that object by
 * `type:id` when it asks the client about it. A bare id can become ambiguous
 * when another type starts storing objects under the same id (the bot-tidy
 * break with "default", and the wiki types before it). Ids people type in the
 * CLI, MCP and HTTP clients stay bare; those packages are not scanned.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** The packages that are clients rather than plugins: a person types their ids. */
const CLIENT_PACKAGES = new Set(["engine", "cli", "mcp", "tui"]);

const CLIENT_METHODS = new Set([
  "act",
  "get",
  "section",
  "list",
  "listTree",
  "facts",
  "read",
  "history",
  "objectHistory",
]);

/** Fields whose contract says the value is already a `type:id`. */
const TYPED_FIELDS = new Set(["item.object", "sent.object"]);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

function packageDirectories(): string[] {
  const base = join(ROOT, "packages");
  const found: string[] = [];
  for (const name of readdirSync(base)) {
    const path = join(base, name);
    if (!statSync(path).isDirectory()) continue;
    if (name === "harness") {
      for (const child of readdirSync(path)) {
        const nested = join(path, child);
        if (statSync(nested).isDirectory()) found.push(nested);
      }
    } else {
      found.push(path);
    }
  }
  return found;
}

/** Every plugin package's source tree, as the files the guard reads. */
function pluginSources(): Map<string, string> {
  const files = new Map<string, string>();
  for (const directory of packageDirectories()) {
    const relativePackage = relative(join(ROOT, "packages"), directory);
    if (CLIENT_PACKAGES.has(relativePackage)) continue;
    const src = join(directory, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const path of sourceFiles(src)) {
      files.set(relative(ROOT, path), readFileSync(path, "utf8"));
    }
  }
  return files;
}

/** Whether an expression says the type before the id. */
function typedId(expression: ts.Expression): boolean {
  if (ts.isStringLiteralLike(expression)) return expression.text.includes(":");
  if (ts.isTemplateExpression(expression)) {
    if (expression.head.text.includes(":")) return true;
    return expression.templateSpans.some((span) => span.literal.text.includes(":"));
  }
  return TYPED_FIELDS.has(expression.getText());
}

/** The id arguments a client call passes, including a list's `parent`. */
function idArguments(call: ts.CallExpression, method: string): readonly ts.Expression[] {
  if (method === "act") {
    const id = call.arguments[1];
    return id === undefined ? [] : [id];
  }
  if (method === "list" || method === "listTree") {
    const ids: ts.Expression[] = [];
    for (const argument of call.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      for (const property of argument.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "parent"
        ) {
          ids.push(property.initializer);
        }
      }
    }
    return ids;
  }
  const id = call.arguments[0];
  return id === undefined ? [] : [id];
}

function isClientReceiver(expression: ts.Expression): boolean {
  return /(^|\.)(client|views)$/.test(expression.getText());
}

/** Client calls in these files whose object id is not a `type:id`. */
export function bareClientIds(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    if (file.startsWith(join("packages", "engine") + "/")) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (CLIENT_METHODS.has(method) && isClientReceiver(node.expression.expression)) {
          for (const id of idArguments(node, method)) {
            if (!typedId(id)) {
              found.push(`${file}: ${method} names "${id.getText(source)}" without its type`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("a plugin's client calls name a typed object id", () => {
  test("the scan finds a bare id on act, get, section and a list parent", () => {
    const sample = new Map([
      [
        "packages/x/src/a.ts",
        [
          'await ctx.client.act("chat:send", chatId, {});',
          "await ctx.client.get(chatId);",
          'await ctx.client.section(chatId, "transcript");',
          "await ctx.views.listTree(undefined, { parent: id });",
        ].join("\n"),
      ],
    ]);
    expect(bareClientIds(sample)).toHaveLength(4);
  });

  test("the scan allows a written id, a typed template and a pending item's object", () => {
    const sample = new Map([
      [
        "packages/x/src/a.ts",
        [
          'await ctx.client.act("chat:send", "chat:1", {});',
          "await ctx.client.act(\"chat:send\", `chat:${chatId}`, {});",
          "await ctx.client.get(`${CHAT_TYPE}:${chatId}`);",
          "await ctx.client.get(item.object);",
          "await ctx.client.section(sent.object, \"history\");",
          "await ctx.views.listTree(undefined, { parent: `${item.type}:${item.id}` });",
        ].join("\n"),
      ],
    ]);
    expect(bareClientIds(sample)).toEqual([]);
  });

  test("every plugin's client calls pass a typed id", () => {
    const files = pluginSources();
    expect(files.size).toBeGreaterThan(10);
    expect(bareClientIds(files)).toEqual([]);
  });
});
