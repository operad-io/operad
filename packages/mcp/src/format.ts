/** One Markdown rendering per read tool, carrying the same data as its result. */

import type {
  PendingItem,
  RunningItem,
  ViewListPage,
  ViewObject,
  ViewRow,
  ViewSectionContent,
  ViewTypeInfo,
} from "@operad-io/engine";
import { formatElapsed, isRecord } from "@operad-io/engine";
import type { MachineLoad } from "@operad-io/engine/platform";
import type { McpViewObject } from "./policy.ts";

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function flags(row: ViewRow): string {
  const names: string[] = [];
  if (row.waiting) names.push("waiting");
  if (row.running) names.push("running");
  return names.length === 0 ? "-" : names.join(", ");
}

function rowName(row: ViewRow): string {
  return row.scope === undefined ? row.id : `${row.scope}/${row.id}`;
}

/** A list page as a Markdown table with a trailing cursor line. */
export function listMarkdown(page: ViewListPage): string {
  const lines: string[] = [];
  if (page.rows.length === 0) {
    lines.push("No objects.");
  } else {
    lines.push("| id | state | mark | badge | title | note | wait | flags |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const row of page.rows) {
      lines.push(
        `| ${cell(rowName(row))} | ${cell(row.state)} | ${cell(row.mark ?? "")} | ${cell(row.badge ?? "")} | ${cell(row.title)} | ${cell(row.note ?? "")} | ${cell(row.wait ?? "")} | ${flags(row)} |`,
      );
    }
  }
  if (page.next !== undefined) {
    lines.push("", `Next cursor: \`${page.next}\``);
  }
  return `${lines.join("\n")}\n`;
}

/** Every object type with views, its plugin and where a client puts it. */
export function typesMarkdown(types: readonly ViewTypeInfo[]): string {
  if (types.length === 0) return "No object types.\n";
  const lines = [
    "| type | title | plugin | settings | filters | parents |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const info of types) {
    const filters = (info.filters ?? []).map((filter) => filter.name).join(", ");
    lines.push(
      `| ${cell(info.type)} | ${cell(info.title)} | ${cell(info.plugin)} | ${info.settings === true ? "yes" : "no"} | ${cell(filters)} | ${cell((info.parents ?? []).join(", "))} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function actionMarkdown(action: ViewObject["actions"][number]): string[] {
  const key = action.key === undefined ? "" : ` (${action.key})`;
  const lines = [`- \`${action.name}\`${key}`];
  lines.push(`  - on: ${action.on === undefined ? "none" : `\`${action.on}\``}`);
  lines.push(
    `  - note: ${action.note === undefined ? "none" : `\`${action.note}\`${action.noteRequired ? " (required)" : ""}`}`,
  );
  lines.push(`  - confirm: ${action.confirm ? "yes" : "no"}`);
  if (action.command !== undefined) lines.push(`  - command: ${action.command}`);
  if (action.creates !== undefined) lines.push(`  - creates: \`${action.creates}\``);
  if (action.args === undefined) {
    lines.push("  - args: none");
  } else {
    lines.push("  - args:");
    lines.push("    ```json");
    for (const line of JSON.stringify(action.args, null, 2).split("\n")) {
      lines.push(`    ${line}`);
    }
    lines.push("    ```");
  }
  return lines;
}

/** One object as its row, section directory, actions and link. */
export function showMarkdown(object: ViewObject | McpViewObject): string {
  const row = object.row;
  const lines = [`# ${row.title}`, ""];
  lines.push(`- id: \`${rowName(row)}\``);
  lines.push(`- type: \`${object.type}\``);
  lines.push(`- state: ${row.state}`);
  if (row.mark !== undefined) lines.push(`- mark: ${row.mark}`);
  if (row.badge !== undefined) lines.push(`- badge: ${row.badge}`);
  if (row.parent !== undefined) lines.push(`- parent: ${row.parent}`);
  if (object.dependents !== undefined) {
    lines.push(`- after this one: ${object.dependents.join(", ")}`);
  }
  lines.push(`- flags: ${flags(row)}`);
  if (row.note !== undefined) lines.push(`- note: ${row.note}`);
  if (row.wait !== undefined) lines.push(`- wait: ${row.wait}`);
  if (row.error !== undefined) lines.push(`- error: ${row.error}`);
  lines.push(`- link: ${object.link}`);
  if (object.unavailable !== undefined) {
    lines.push(`- unavailable: ${object.unavailable}`);
  }

  lines.push("", "## Sections");
  if (object.sections.length === 0) {
    lines.push("No sections.");
  } else {
    for (const section of object.sections) {
      lines.push(
        `- \`${section.id}\`: ${section.title}${section.live === true ? " (live)" : ""}`,
      );
    }
  }

  if (object.skills !== undefined) {
    lines.push("", "## Skills");
    if (object.skills.length === 0) {
      lines.push("No skills.");
    } else {
      for (const skill of object.skills) {
        lines.push(`- \`/${skill.name}\`${skill.description === undefined ? "" : `: ${skill.description}`}`);
      }
    }
  }

  lines.push("", "## Actions");
  if (object.actions.length === 0) {
    lines.push("No actions are available now.");
  } else {
    for (const action of object.actions) lines.push(...actionMarkdown(action));
  }

  const ownerActions = "ownerActions" in object ? object.ownerActions : [];
  if (ownerActions.length > 0) {
    lines.push("", "## Owner actions");
    for (const name of ownerActions) {
      lines.push(`- \`${name}\`: the owner runs it`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A plugin verb's or action's value as the CLI prints it. */
export function valueText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return `${value}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A section's Markdown, with the cursor named when another page follows. */
export function sectionMarkdown(content: ViewSectionContent): string {
  if (content.next === undefined) return content.markdown;
  const separator = content.markdown.endsWith("\n") ? "\n" : "\n\n";
  return `${content.markdown}${separator}Next cursor: \`${content.next}\`\n`;
}

/** The history tool's Markdown is the history section's Markdown. */
export function historyMarkdown(content: ViewSectionContent): string {
  return sectionMarkdown(content);
}

function pendingItemMarkdown(item: PendingItem): string[] {
  const lines = [`## ${item.runId} (${item.flow})`];
  lines.push(`- step: ${item.step ?? "-"}`);
  lines.push(`- waiting: ${item.prompt}`);
  if (item.choices.length > 0) {
    lines.push(`- choices: ${item.choices.join(", ")}`);
    for (const choice of item.choices) {
      const info = item.choiceInfo?.[choice];
      if (info === undefined) continue;
      const parts: string[] = [];
      if (info.label !== undefined) parts.push(`label ${info.label}`);
      if (info.hint !== undefined) parts.push(info.hint);
      if (info.role !== undefined) parts.push(info.role);
      if (info.note !== undefined) parts.push(`note ${info.note}`);
      if (parts.length > 0) lines.push(`  - ${choice}: ${parts.join("; ")}`);
    }
  }
  if (item.actions.length > 0) {
    lines.push(
      `- actions: ${item.actions.map((action) => `${action.plugin}:${action.action}`).join(", ")}`,
    );
  }
  if (item.object !== undefined) lines.push(`- object: \`${item.object}\``);
  if (item.link !== undefined) lines.push(`- link: ${item.link}`);
  return lines;
}

/** Everything waiting for a person, one section per item. */
export function pendingMarkdown(pending: readonly PendingItem[]): string {
  if (pending.length === 0) return "Nothing is waiting.\n";
  const lines = ["# Pending", ""];
  for (const [index, item] of pending.entries()) {
    if (index > 0) lines.push("");
    lines.push(...pendingItemMarkdown(item));
  }
  return `${lines.join("\n")}\n`;
}

/** Every active run as a Markdown table. */
export function runningMarkdown(
  running: readonly RunningItem[],
  load: MachineLoad,
): string {
  const loadLine = `Load: ${load.load1} (1 minute), ${load.cores} cores\n`;
  if (running.length === 0) return `Nothing is running.\n\n${loadLine}`;
  const lines = [
    "| object | title | flow | step | step time | run |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of running) {
    lines.push(
      `| ${cell(item.object ?? item.runId)} | ${cell(item.title ?? "")} | ${cell(item.flow)} | ${cell(item.stepLabel ?? "-")} | ${item.stepElapsedMs === null ? "-" : formatElapsed(item.stepElapsedMs)}${item.queuedMs === undefined || item.queuedMs <= 0 ? "" : ` (queued ${formatElapsed(item.queuedMs)})`} | ${formatElapsed(item.elapsedMs)} |`,
    );
  }
  return `${lines.join("\n")}\n\n${loadLine}`;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

/** Whether a result or a backlink says its note came from untrusted content. */
function untrustedOf(value: Readonly<Record<string, unknown>>): boolean {
  if (value["untrusted"] === true) return true;
  const fields = value["fields"];
  if (!isRecord(fields)) return false;
  const values = fields["untrusted"];
  return (
    Array.isArray(values) &&
    values.some((item) => typeof item === "string" && item.trim().toLowerCase() === "true")
  );
}

/** One search result as the lines a reader scans, and the directory notes. */
export function searchMarkdown(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value["hits"])) return valueText(value);
  const query = textValue(value["query"]);
  const hits = value["hits"].filter(isRecord);
  const lines = [`# Search: ${query}`, ""];
  if (hits.length === 0) {
    lines.push("No results.");
  } else {
    for (const hit of hits) {
      const where = [hit["scope"], hit["path"], `lines ${numberValue(hit["lineStart"])}-${numberValue(hit["lineEnd"])}`]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join(" · ");
      const mark = untrustedOf(hit) ? " (untrusted)" : "";
      lines.push(`- \`${textValue(hit["id"])}\` — ${textValue(hit["title"])} (${where})${mark}`);
      const snippet = textValue(hit["snippet"]);
      if (snippet.length > 0) lines.push(`  ${snippet}`);
    }
  }
  const about = Array.isArray(value["about"]) ? value["about"].filter(isRecord) : [];
  if (about.length > 0) {
    lines.push("", "## Directory notes");
    for (const note of about) {
      lines.push(`### ${textValue(note["title"])}`, "", textValue(note["text"]));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** One document, or the line range that was asked for. */
export function readMarkdown(value: unknown): string {
  if (!isRecord(value)) return valueText(value);
  const lines = [`# ${textValue(value["title"])}`, ""];
  lines.push(`- id: \`${textValue(value["id"])}\``);
  const path = textValue(value["path"]);
  if (path.length > 0) lines.push(`- path: ${path}`);
  lines.push(
    `- lines: ${numberValue(value["lineStart"])}-${numberValue(value["lineEnd"])} of ${numberValue(value["totalLines"])}`,
  );
  const text = textValue(value["text"]);
  if (text.length > 0) lines.push("", text);
  const backlinks = Array.isArray(value["backlinks"]) ? value["backlinks"].filter(isRecord) : [];
  if (backlinks.length > 0) {
    lines.push("", "## Backlinks");
    for (const entry of backlinks) {
      const line = typeof entry["line"] === "number" && Number.isFinite(entry["line"]) ? ` line ${entry["line"]}` : "";
      const mark = untrustedOf(entry) ? " (untrusted)" : "";
      const excerpt = textValue(entry["excerpt"]);
      lines.push(
        `- \`${textValue(entry["path"])}\`${line}${mark}${excerpt.length > 0 ? ` — ${excerpt}` : ""}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
