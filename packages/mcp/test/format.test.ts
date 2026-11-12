import { describe, expect, test } from "bun:test";
import type {
  PendingItem,
  RunningItem,
  ViewAction,
  ViewListPage,
  ViewObject,
  ViewRow,
  ViewSectionContent,
} from "@operad-io/engine";
import {
  historyMarkdown,
  listMarkdown,
  pendingMarkdown,
  runningMarkdown,
  sectionMarkdown,
  showMarkdown,
  valueText,
} from "../src/format.ts";

const row = (extra: Partial<ViewRow> = {}): ViewRow => ({
  id: "one",
  title: "First",
  state: "new",
  waiting: false,
  running: false,
  ...extra,
});

const action = (extra: Partial<ViewAction> = {}): ViewAction => ({
  plugin: "demo",
  action: "approve",
  on: "item",
  name: "demo:approve",
  noteRequired: false,
  confirm: false,
  ...extra,
});

const object = (extra: Partial<ViewObject> = {}): ViewObject => ({
  id: "item:one",
  type: "item",
  link: "https://example.com/item/one",
  row: row(),
  sections: [],
  actions: [],
  ...extra,
});

describe("the list Markdown", () => {
  test("says no objects, and names the next cursor when one follows", () => {
    expect(listMarkdown({ rows: [] })).toBe("No objects.\n");
    expect(listMarkdown({ rows: [], next: "cursor-2" })).toBe(
      "No objects.\n\nNext cursor: `cursor-2`\n",
    );
  });

  test("writes one row per object with its scope, flags and escaped cells", () => {
    const page: ViewListPage = {
      rows: [
        row({ id: "one", title: "First", waiting: true, note: "a | b", wait: "refused · x" }),
        row({
          id: "two",
          scope: "repo",
          title: "Second\nline",
          state: "open",
          mark: "integrating",
          badge: "#2",
          running: true,
        }),
      ],
    };
    const text = listMarkdown(page);
    expect(text).toContain("| one | new |  |  | First | a \\| b | refused · x | waiting |");
    expect(text).toContain("| repo/two | open | integrating | #2 | Second line |  |  | running |");
  });
});

describe("the show Markdown", () => {
  test("names every absent field as absent and says when there is nothing to show", () => {
    const text = showMarkdown(object());
    expect(text).toContain("# First");
    expect(text).toContain("- id: `one`");
    expect(text).toContain("- type: `item`");
    expect(text).toContain("- state: new");
    expect(text).toContain("- flags: -");
    expect(text).toContain("- link: https://example.com/item/one");
    expect(text).not.toContain("- mark:");
    expect(text).not.toContain("- badge:");
    expect(text).not.toContain("- parent:");
    expect(text).not.toContain("- after this one:");
    expect(text).not.toContain("- note:");
    expect(text).not.toContain("- error:");
    expect(text).not.toContain("- unavailable:");
    expect(text).toContain("## Sections\nNo sections.");
    expect(text).toContain("## Actions\nNo actions are available now.");
    expect(text).not.toContain("## Owner actions");
  });

  test("shows every field, section and action, and the owner's actions", () => {
    const shown = showMarkdown({
      ...object({
        row: row({
          id: "two",
          scope: "repo",
          title: "Second",
          state: "open",
          mark: "integrating",
          badge: "#2",
          parent: "group:g1",
          note: "waiting on a check",
          error: "the row failed",
          waiting: true,
          running: true,
        }),
        dependents: ["T-0002-two", "T-0003-three"],
        unavailable: "the plugin is gone",
        sections: [
          { id: "info", title: "Info" },
          { id: "history", title: "History", live: true },
        ],
        actions: [
          action(),
          action({
            name: "demo:drop",
            action: "drop",
            key: "d",
            note: "why",
            noteRequired: true,
            confirm: true,
            args: { type: "object", properties: { why: { type: "string" } } },
          }),
        ],
      }),
      ownerActions: ["demo:auto"],
    });
    expect(shown).toContain("- id: `repo/two`");
    expect(shown).toContain("- mark: integrating");
    expect(shown).toContain("- badge: #2");
    expect(shown).toContain("- parent: group:g1");
    expect(shown).toContain("- after this one: T-0002-two, T-0003-three");
    expect(shown).toContain("- flags: waiting, running");
    expect(shown).toContain("- note: waiting on a check");
    expect(shown).toContain("- error: the row failed");
    expect(shown).toContain("- unavailable: the plugin is gone");
    expect(shown).toContain("- `info`: Info");
    expect(shown).toContain("- `history`: History (live)");
    expect(shown).toContain("- `demo:approve`");
    expect(shown).toContain("  - note: none");
    expect(shown).toContain("  - confirm: no");
    expect(shown).toContain("  - args: none");
    expect(shown).toContain("- `demo:drop` (d)");
    expect(shown).toContain('  - note: `why` (required)');
    expect(shown).toContain("  - confirm: yes");
    expect(shown).toContain("    ```json");
    expect(shown).toContain('"why"');
    expect(shown).toContain("## Owner actions");
    expect(shown).toContain("- `demo:auto`: the owner runs it");
  });
});

describe("a plugin value as text", () => {
  test("is empty for nothing, a line for a string, and JSON for the rest", () => {
    expect(valueText(undefined)).toBe("");
    expect(valueText("added repo")).toBe("added repo\n");
    expect(valueText({ ok: true })).toBe('{\n  "ok": true\n}\n');
    expect(valueText(["a", "b"])).toBe('[\n  "a",\n  "b"\n]\n');
  });
});

describe("a section's Markdown", () => {
  const content = (extra: Partial<ViewSectionContent> = {}): ViewSectionContent => ({
    markdown: "body\n",
    ...extra,
  });

  test("is the section's own text when no page follows", () => {
    expect(sectionMarkdown(content())).toBe("body\n");
    expect(historyMarkdown(content())).toBe("body\n");
  });

  test("names the next cursor after the text, adding only the newlines it needs", () => {
    expect(sectionMarkdown(content({ next: "c2" }))).toBe(
      "body\n\nNext cursor: `c2`\n",
    );
    expect(sectionMarkdown({ markdown: "body", next: "c2" })).toBe(
      "body\n\nNext cursor: `c2`\n",
    );
    expect(historyMarkdown({ markdown: "body\n", next: "c2" })).toBe(
      "body\n\nNext cursor: `c2`\n",
    );
  });
});

describe("the pending Markdown", () => {
  const item = (extra: Partial<PendingItem> = {}): PendingItem => ({
    runId: "run-1",
    flow: "demo-flow",
    step: "ask",
    prompt: "Approve?",
    choices: [],
    actions: [],
    ...extra,
  });

  test("says nothing is waiting when the list is empty", () => {
    expect(pendingMarkdown([])).toBe("Nothing is waiting.\n");
  });

  test("writes one section per item, with its choices, actions, object and link", () => {
    const text = pendingMarkdown([
      item({
        choices: ["yes", "no"],
        actions: [
          { plugin: "demo", action: "approve" },
          { plugin: "demo", action: "drop" },
        ],
        object: "item:one",
        link: "https://example.com/item/one",
      }),
      item({ runId: "run-2", flow: "other", step: null, prompt: "Anything?" }),
    ]);
    expect(text).toContain("# Pending");
    expect(text).toContain("## run-1 (demo-flow)");
    expect(text).toContain("- step: ask");
    expect(text).toContain("- waiting: Approve?");
    expect(text).toContain("- choices: yes, no");
    expect(text).toContain("- actions: demo:approve, demo:drop");
    expect(text).toContain("- object: `item:one`");
    expect(text).toContain("- link: https://example.com/item/one");
    expect(text).toContain("## run-2 (other)");
    expect(text).toContain("- step: -");
    expect(text).toContain("\n\n## run-2 (other)");
  });
});

describe("the running Markdown", () => {
  const item = (extra: Partial<RunningItem> = {}): RunningItem => ({
    runId: "run-1",
    flow: "dev",
    step: "verify",
    startedAt: 0,
    elapsedMs: 600_000,
    object: "ops/T-0061-x",
    title: "Check it",
    stepStartedAt: 0,
    stepElapsedMs: 5_000,
    queued: null,
    stepLabel: "verify",
    ...extra,
  });

  test("says nothing is running, and still reports the load", () => {
    expect(runningMarkdown([], { load1: 1.25, cores: 8 })).toBe(
      "Nothing is running.\n\nLoad: 1.25 (1 minute), 8 cores\n",
    );
  });

  test("writes one row per run and formats each duration", () => {
    const text = runningMarkdown(
      [
        item({ runId: "run-1", stepElapsedMs: 500, elapsedMs: 500 }),
        item({
          runId: "run-2",
          object: null,
          title: null,
          stepLabel: null,
          stepElapsedMs: null,
          elapsedMs: 65_000,
        }),
        item({
          runId: "run-3",
          object: "ops/T-3",
          title: "Third",
          stepElapsedMs: 5_000,
          queuedMs: 540_000,
          elapsedMs: 600_000,
        }),
        item({
          runId: "run-4",
          stepElapsedMs: 5_000,
          queuedMs: 0,
          elapsedMs: 600_000,
        }),
        item({
          runId: "run-5",
          stepElapsedMs: 5_000,
          queuedMs: -1,
          elapsedMs: 600_000,
        }),
      ],
      { load1: 0, cores: 1 },
    );
    expect(text).toContain("| ops/T-0061-x | Check it | dev | verify | 500ms | 500ms |");
    expect(text).toContain("| run-2 |  | dev | - | - | 1m 5s |");
    expect(text).toContain("| ops/T-3 | Third | dev | verify | 5.0s (queued 9m 0s) | 10m 0s |");
    expect(text).toContain("| ops/T-0061-x | Check it | dev | verify | 5.0s | 10m 0s |");
    expect(text.match(/queued 9m 0s/g)).toHaveLength(1);
    expect(text).toContain("Load: 0 (1 minute), 1 cores");
  });
});
