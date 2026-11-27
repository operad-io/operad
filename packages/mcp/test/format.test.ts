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
  listMarkdown,
  pendingMarkdown,
  readMarkdown,
  runningMarkdown,
  searchMarkdown,
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
            command: "Drop the item.",
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
    expect(shown).toContain("  - command: Drop the item.");
    expect(shown).toContain("    ```json");
    expect(shown).toContain('"why"');
    expect(shown).toContain("## Owner actions");
    expect(shown).toContain("- `demo:auto`: the owner runs it");
  });

  test("keeps a proposal's action order: approve, reject, then review", () => {
    const actions = [
      action({ plugin: "bot", action: "approve", name: "bot:approve" }),
      action({ plugin: "bot", action: "reject", name: "bot:reject" }),
      action({ plugin: "bot", action: "review", name: "bot:review" }),
    ];
    const shown = showMarkdown(object({ actions }));
    expect(shown.indexOf("- `bot:approve`")).toBeLessThan(
      shown.indexOf("- `bot:reject`"),
    );
    expect(shown.indexOf("- `bot:reject`")).toBeLessThan(
      shown.indexOf("- `bot:review`"),
    );
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
  });

  test("names the next cursor after the text, adding only the newlines it needs", () => {
    expect(sectionMarkdown(content({ next: "c2" }))).toBe(
      "body\n\nNext cursor: `c2`\n",
    );
    expect(sectionMarkdown({ markdown: "body", next: "c2" })).toBe(
      "body\n\nNext cursor: `c2`\n",
    );
    expect(sectionMarkdown({ markdown: "body\n", next: "c2" })).toBe(
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
        choiceInfo: {
          yes: { label: "Yes", hint: "Go on.", role: "primary", note: "optional" },
          no: { label: "No", hint: "Stop here.", role: "destructive" },
        },
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
    expect(text).toContain("  - yes: label Yes; Go on.; primary; note optional");
    expect(text).toContain("  - no: label No; Stop here.; destructive");
    expect(text).toContain("- actions: demo:approve, demo:drop");
    expect(text).toContain("- object: `item:one`");
    expect(text).toContain("- link: https://example.com/item/one");
    expect(text).toContain("## run-2 (other)");
    expect(text).toContain("- step: -");
    expect(text).toContain("\n\n## run-2 (other)");
  });

  test("keeps a proposal's action order: approve, reject, then review", () => {
    const text = pendingMarkdown([
      item({
        actions: [
          { plugin: "bot", action: "approve" },
          { plugin: "bot", action: "reject" },
          { plugin: "bot", action: "review" },
        ],
      }),
    ]);
    expect(text).toContain("- actions: bot:approve, bot:reject, bot:review");
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
    expect(text).toContain("| ops/T-0061-x | Check it | dev | verify | <1s | <1s |");
    expect(text).toContain("| run-2 |  | dev | - | - | 1m 5s |");
    expect(text).toContain("| ops/T-3 | Third | dev | verify | 5s (queued 9m) | 10m |");
    expect(text).toContain("| ops/T-0061-x | Check it | dev | verify | 5s | 10m |");
    expect(text.match(/queued 9m/g)).toHaveLength(1);
    expect(text).toContain("Load: 0 (1 minute), 1 cores");
  });
});

describe("the read Markdown", () => {
  const read = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "wiki:notes/tea.md",
    scope: "wiki",
    title: "Tea",
    path: "notes/tea.md",
    lineStart: 1,
    lineEnd: 3,
    totalLines: 3,
    text: "# Tea\n\nGreen tea brews cooler.",
    fields: {},
    ...extra,
  });

  test("ends with the notes that link to the document, with a line and excerpt", () => {
    const text = readMarkdown(
      read({
        backlinks: [
          {
            path: "index.md",
            line: 3,
            excerpt: "- [[notes/tea|Tea]]",
            untrusted: false,
          },
          {
            path: "notes/about.md",
            line: 2,
            excerpt: "We discussed [[notes/tea]]",
            untrusted: true,
          },
        ],
      }),
    );
    expect(text).toContain("## Backlinks");
    expect(text).toContain("- `index.md` line 3 — - [[notes/tea|Tea]]");
    expect(text).toContain("- `notes/about.md` line 2 (untrusted) — We discussed [[notes/tea]]");
    expect(text.indexOf("## Backlinks")).toBeGreaterThan(text.indexOf("Green tea brews cooler."));
  });

  test("leaves the section out when nothing links to the document", () => {
    expect(readMarkdown(read({ backlinks: [] }))).not.toContain("## Backlinks");
    expect(readMarkdown(read())).not.toContain("## Backlinks");
  });
});

describe("the search Markdown", () => {
  test("marks a result whose note is untrusted", () => {
    const text = searchMarkdown({
      query: "tea",
      scopes: ["wiki"],
      hits: [
        {
          id: "wiki:untrusted.md",
          scope: "wiki",
          title: "Untrusted",
          path: "untrusted.md",
          lineStart: 1,
          lineEnd: 2,
          snippet: "See [[notes/tea]].",
          score: 1,
          fields: { untrusted: ["true"] },
        },
      ],
      about: [],
    });
    expect(text).toContain("(untrusted)");
  });
});

describe("the pending Markdown", () => {
  test("puts a question's command alone in a code block", () => {
    const item: PendingItem = {
      runId: "run-1",
      flow: "demo",
      step: "ask",
      prompt: "Log in?",
      choices: [],
      command: "tool auth login some-provider",
      actions: [],
    };
    expect(pendingMarkdown([item])).toContain("- waiting: Log in?\n```\ntool auth login some-provider\n```\n");
  });
});
