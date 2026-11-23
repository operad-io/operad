/**
 * Where the index reads from: every bot's memory directory, the shared wiki,
 * and a chat's messages as a document with numbered lines. A chat's fact types
 * are written here rather than imported from the chat plugin, so the memory
 * plugin does not depend on the plugin whose records it indexes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { configPath, isRecord, type ObjectStore } from "@operad-io/engine";

/** The directory a bot's memory lives in, under its working directory. */
export function botMemoryDirectory(cwd: string): string {
  return join(cwd, "memory");
}

/** The `bot` section of a home's `config.json`, with the default bot present. */
function botSettings(home: string): Readonly<Record<string, Record<string, unknown>>> {
  const file = configPath(home);
  if (!existsSync(file)) return { default: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { default: {} };
  }
  const plugins = isRecord(parsed) ? parsed.plugins : undefined;
  const entry = isRecord(plugins) ? plugins["bot"] : undefined;
  const settings = isRecord(entry) && isRecord(entry.settings) ? entry.settings : {};
  const bots = isRecord(settings["bots"]) ? settings["bots"] : {};
  const found: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(bots)) {
    if (isRecord(value)) found[name] = value;
  }
  if (found["default"] === undefined) found["default"] = {};
  return found;
}

function expandUnder(path: string, base: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every existing bot memory directory. The bot plugin's default layout is
 * `~/.operad/bot/<name>/memory`; a bot whose settings name another working
 * directory is read from that directory's `memory/`. A directory that is not
 * there is not indexed, and a bot is never given another bot's path.
 */
export function botMemoryDirectories(home: string): readonly string[] {
  const found = new Set<string>();
  const root = join(home, "bot");
  if (directoryExists(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const memory = join(root, entry.name, "memory");
      if (directoryExists(memory)) found.add(resolve(memory));
    }
  }
  // An older default bot kept its memory directly under the bot home.
  const oldDefault = join(root, "memory");
  if (directoryExists(oldDefault)) found.add(resolve(oldDefault));
  for (const settings of Object.values(botSettings(home))) {
    const written = settings["cwd"];
    if (typeof written !== "string" || written.length === 0) continue;
    let cwd: string;
    try {
      cwd = expandUnder(written, root);
    } catch {
      continue;
    }
    const memory = botMemoryDirectory(cwd);
    if (directoryExists(memory)) found.add(resolve(memory));
  }
  return [...found].sort();
}

/** Every Markdown file under a directory, hidden directories left out. */
export function markdownFiles(directory: string): readonly string[] {
  if (!directoryExists(directory)) return [];
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && /\.(?:md|markdown)$/iu.test(entry.name)) found.push(path);
    }
  };
  visit(directory);
  return found.sort();
}

/** A chat message as the index reads it. */
export interface IndexedChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

const MESSAGE_FACT = "chat.message";
const MESSAGE_CHANGE_FACT = "chat.message_change";

function messageOfFact(fact: { readonly data: Record<string, unknown> }): IndexedChatMessage | undefined {
  const data = fact.data;
  if (typeof data["id"] !== "string" || typeof data["text"] !== "string") return undefined;
  if (data["role"] !== "user" && data["role"] !== "assistant") return undefined;
  // A message of a stretch that is not remembered stays out of the index (ADR 0038).
  if (data["private"] === true) return undefined;
  return { id: data["id"], role: data["role"], text: data["text"] };
}

/**
 * A chat's messages with the latest text and the withdrawn ones left out. The
 * fact types are the chat plugin's record (ADR 0027); only the two fields the
 * index needs are read.
 */
export function chatMessages(store: ObjectStore, chat: string): readonly IndexedChatMessage[] {
  const order: string[] = [];
  const messages = new Map<string, IndexedChatMessage>();
  const changes = new Map<string, { readonly text?: string; readonly withdrawn?: true }>();
  let cursor: string | undefined;
  do {
    const page = store.facts(
      { type: "chat", id: chat },
      { ...(cursor === undefined ? {} : { cursor }), limit: 500 },
    );
    for (const fact of page.facts) {
      if (fact.type === MESSAGE_FACT) {
        const message = messageOfFact(fact);
        if (message === undefined) continue;
        if (!messages.has(message.id)) order.push(message.id);
        messages.set(message.id, message);
        continue;
      }
      if (fact.type !== MESSAGE_CHANGE_FACT) continue;
      const data = fact.data;
      if (typeof data["id"] !== "string") continue;
      const before = changes.get(data["id"]) ?? {};
      if (data["kind"] === "withdraw") changes.set(data["id"], { ...before, withdrawn: true });
      else if (data["kind"] === "text" && typeof data["text"] === "string") {
        changes.set(data["id"], { ...before, text: data["text"] });
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);

  const found: IndexedChatMessage[] = [];
  for (const id of order) {
    const message = messages.get(id);
    if (message === undefined) continue;
    const change = changes.get(id);
    if (change?.withdrawn === true) continue;
    found.push(change?.text === undefined ? message : { ...message, text: change.text });
  }
  return found;
}

/**
 * A chat as lines a reader can cite: one heading, then one block per message.
 * The line numbers stay stable as messages are appended, so a hit's range keeps
 * meaning the same message.
 */
export function chatDocument(chat: string, title: string, messages: readonly IndexedChatMessage[]): string {
  const lines = [`# ${title.length > 0 ? title : chat}`, `chat ${chat}`, ""];
  for (const message of messages) {
    lines.push(`${message.role === "user" ? "person" : "assistant"}:`);
    for (const line of message.text.split(/\r?\n/u)) lines.push(line);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * The message a line of a chat's document belongs to, or undefined for the
 * heading. It walks the layout `chatDocument` writes: a heading of three
 * lines, then per message a speaker line, its text and one blank line.
 */
export function messageAtLine(messages: readonly IndexedChatMessage[], line: number): string | undefined {
  let at = 4;
  for (const message of messages) {
    const end = at + 1 + message.text.split(/\r?\n/u).length;
    if (line >= at && line <= end) return message.id;
    at = end + 1;
  }
  return undefined;
}

/** A chat's title, as its stored object states it. */
export function chatTitle(id: string, data: Readonly<Record<string, unknown>>): string {
  const title = data["title"];
  return typeof title === "string" && title.length > 0 ? title : id;
}

/** A chat's working directory, path-resolved to the owner a bot search compares. */
export function chatOwner(data: Readonly<Record<string, unknown>>): string | undefined {
  const cwd = data["cwd"];
  return typeof cwd === "string" && cwd.length > 0 ? resolve(cwd) : undefined;
}

/** The path a file document is shown under: relative to its root. */
export function documentPath(file: string, root: string): string {
  return relative(root, file).split("\\").join("/");
}

/** A file's directory inside its root, empty at the root. */
export function documentDirectory(file: string, root: string): string {
  const rel = documentPath(file, root);
  const directory = dirname(rel);
  return directory === "." ? "" : directory.split("\\").join("/");
}

/** A file's name, as an about lookup and a title use it. */
export function fileName(file: string): string {
  return basename(file);
}
