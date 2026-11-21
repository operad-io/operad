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

/** The types whose `object` field says the value is already a `type:id`. */
const TYPED_OBJECT_TYPES = /\b(?:PendingItem|SentItem)\b/;

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

/** The expression without the wrappers that do not change what it is. */
function unwrapped(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The name an expression is known by when it is an alias of the client. */
function aliasKey(expression: ts.Expression, source: ts.SourceFile): string | undefined {
  const inner = unwrapped(expression);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return inner.getText(source);
  return undefined;
}

/** Whether an expression names the client itself, rather than an alias of it. */
function isDirectClientReceiver(expression: ts.Expression): boolean {
  const inner = unwrapped(expression);
  if (ts.isIdentifier(inner)) return inner.text === "client" || inner.text === "views";
  if (ts.isPropertyAccessExpression(inner)) {
    return inner.name.text === "client" || inner.name.text === "views";
  }
  return false;
}

/** Whether a type says the value is the client API, so its holder is a receiver. */
function namesClientType(type: ts.TypeNode | undefined, source: ts.SourceFile): boolean {
  if (type === undefined) return false;
  const text = type.getText(source);
  return /\bClientApi\b/.test(text) || /\bViews\b/.test(text) || /\[\s*["']client["']\s*\]/.test(text);
}

/** Every name in a file that holds the client, including aliases of an alias. */
function clientAliases(source: ts.SourceFile): ReadonlySet<string> {
  const aliases = new Set<string>();
  const known = (expression: ts.Expression): boolean => {
    const key = aliasKey(expression, source);
    return isDirectClientReceiver(expression) || (key !== undefined && aliases.has(key));
  };
  let changed = true;
  while (changed) {
    changed = false;
    const add = (key: string | undefined): void => {
      if (key === undefined || aliases.has(key)) return;
      aliases.add(key);
      changed = true;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (namesClientType(node.type, source) || (node.initializer !== undefined && known(node.initializer))) {
          add(node.name.text);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        known(node.right)
      ) {
        add(aliasKey(node.left, source));
      } else if (ts.isPropertyDeclaration(node)) {
        if (namesClientType(node.type, source) || (node.initializer !== undefined && known(node.initializer))) {
          add(`this.${node.name.getText(source)}`);
        }
      } else if (ts.isParameter(node) && namesClientType(node.type, source) && ts.isIdentifier(node.name)) {
        add(node.name.text);
        if (ts.isConstructorDeclaration(node.parent) && node.modifiers !== undefined) {
          add(`this.${node.name.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return aliases;
}

/** The variable or parameter a bare identifier names, nearest scope first. */
function bindingOf(identifier: ts.Identifier): ts.Declaration | undefined {
  const name = identifier.text;
  for (let node: ts.Node | undefined = identifier.parent; node !== undefined; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return parameter;
      }
    }
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      for (const statement of node.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
        }
      }
    }
    if (ts.isClassLike(node)) {
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name) {
          return member;
        }
      }
    }
  }
  return undefined;
}

/** The class property an expression such as `this.sent` names. */
function thisPropertyOf(expression: ts.PropertyAccessExpression): ts.PropertyDeclaration | undefined {
  if (expression.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  for (let node: ts.Node | undefined = expression.parent; node !== undefined; node = node.parent) {
    if (!ts.isClassLike(node)) continue;
    for (const member of node.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === expression.name.text
      ) {
        return member;
      }
    }
    return undefined;
  }
  return undefined;
}

/** The declared type a binding carries, when it carries one. */
function typeOfBinding(binding: ts.Declaration): ts.TypeNode | undefined {
  if (ts.isParameter(binding) || ts.isVariableDeclaration(binding) || ts.isPropertyDeclaration(binding)) {
    return binding.type ?? undefined;
  }
  return undefined;
}

/** Whether a field's declared type says its `object` is already a `type:id`. */
function typedObjectField(expression: ts.Expression, source: ts.SourceFile): boolean {
  const inner = unwrapped(expression);
  if (!ts.isPropertyAccessExpression(inner) || inner.name.text !== "object") return false;
  const base = unwrapped(inner.expression);
  const binding = ts.isIdentifier(base)
    ? bindingOf(base)
    : ts.isPropertyAccessExpression(base)
      ? thisPropertyOf(base)
      : undefined;
  const type = binding === undefined ? undefined : typeOfBinding(binding);
  return type !== undefined && TYPED_OBJECT_TYPES.test(type.getText(source));
}

/** Whether an expression says the type before the id. */
function typedId(expression: ts.Expression, source: ts.SourceFile): boolean {
  if (ts.isStringLiteralLike(expression)) return expression.text.includes(":");
  if (ts.isTemplateExpression(expression)) {
    if (expression.head.text.includes(":")) return true;
    return expression.templateSpans.some((span) => span.literal.text.includes(":"));
  }
  return typedObjectField(expression, source);
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

function isClientReceiver(
  expression: ts.Expression,
  aliases: ReadonlySet<string>,
  source: ts.SourceFile,
): boolean {
  if (isDirectClientReceiver(expression)) return true;
  const key = aliasKey(expression, source);
  return key !== undefined && aliases.has(key);
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
    const aliases = clientAliases(source);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (CLIENT_METHODS.has(method) && isClientReceiver(node.expression.expression, aliases, source)) {
          for (const id of idArguments(node, method)) {
            if (!typedId(id, source)) {
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

/** The client names a sample declares, for a test of the alias scan. */
function sampleWithAliases(text: string): ReadonlySet<string> {
  const source = ts.createSourceFile(
    "packages/x/src/a.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return clientAliases(source);
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

  test("the scan follows an alias and a ClientApi property to a client call", () => {
    const sample = new Map([
      [
        "packages/x/src/a.ts",
        [
          "class Sender {",
          "  private readonly api: ClientApi;",
          "  constructor(client: ClientApi) {",
          "    this.api = client;",
          "  }",
          "  async send(chatId: string) {",
          "    const local = ctx.client;",
          "    await local.get(chatId);",
          '    await this.api.section(chatId, "history");',
          "  }",
          "}",
          "const other = ctx.client;",
          'await other.act("chat:send", chatId, {});',
        ].join("\n"),
      ],
    ]);
    expect(sampleWithAliases(sample.get("packages/x/src/a.ts") ?? "")).toEqual(
      new Set(["client", "this.api", "local", "other"]),
    );
    expect(bareClientIds(sample)).toHaveLength(3);
  });

  test("the scan allows a written id, a typed template and a declared typed object", () => {
    const sample = new Map([
      [
        "packages/x/src/a.ts",
        [
          "function show(item: PendingItem, sent: SentItem, bare: { object: string }) {",
          '  await ctx.client.act("chat:send", "chat:1", {});',
          "  await ctx.client.act(\"chat:send\", `chat:${chatId}`, {});",
          "  await ctx.client.get(`${CHAT_TYPE}:${chatId}`);",
          "  await ctx.client.get(item.object);",
          "  await ctx.client.section(sent.object, \"history\");",
          "  await ctx.views.listTree(undefined, { parent: `${item.type}:${item.id}` });",
          "  await ctx.client.get(bare.object);",
          "  const plain = { object: chatId };",
          "  await ctx.client.get(plain.object);",
          "  const ids = new Map<string, string>();",
          "  ids.get(chatId);",
          "}",
        ].join("\n"),
      ],
    ]);
    const found = bareClientIds(sample);
    expect(found).toHaveLength(2);
    expect(found.join("\n")).toContain('names "bare.object" without its type');
    expect(found.join("\n")).toContain('names "plain.object" without its type');
  });

  test("every plugin's client calls pass a typed id", () => {
    const files = pluginSources();
    expect(files.size).toBeGreaterThan(10);
    expect(bareClientIds(files)).toEqual([]);
  });
});
