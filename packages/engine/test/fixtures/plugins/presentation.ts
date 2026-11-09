import { definePlugin } from "../../../src/index.ts";
import type { ObjectRow } from "../../../src/index.ts";

let logReads = 0;

/** The live `log` section grows per read; a test starts it from zero. */
export function resetLogReads(): void {
  logReads = 0;
}
const waiting = new Promise<never>(() => undefined);

/**
 * The clock a test moves by hand. The slow row advances it instead of waiting
 * on wall time, so the kernel's row limit is exercised deterministically.
 */
export const testClock = {
  current: 0,
  now: (): number => testClock.current,
  advance(ms: number): void {
    testClock.current += ms;
  },
};

const INFO = [
  "# Demo item",
  "",
  "Some **bold** and a [link](https://example.com).",
  "",
  "- first",
  "- second",
  "",
  "```diff",
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "```",
  "",
  "| name | value |",
  "| --- | --- |",
  "| alpha | 1 |",
  "| beta | 22 |",
  "",
  "```mermaid",
  "flowchart TD",
  "  A --> B",
  "```",
].join("\n");

/** A plugin with only views, two actions and default keys. */
export default definePlugin({
  name: "demo",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "item", index: ["state", "plan"] }],
  views: {
    item: {
      row(object) {
        const mode = object.data.mode;
        if (mode === "async") {
          return Promise.resolve({
            id: object.id,
            title: "async",
            state: "new",
          }) as unknown as ObjectRow;
        }
        if (mode === "slow") {
          testClock.advance(80);
        }
        const note = object.data.note;
        return {
          id: object.id,
          title: String(object.data.title ?? ""),
          state: String(object.data.state ?? "new"),
          ...(typeof note === "string" ? { note } : {}),
          ...(object.data.mark === undefined
            ? {}
            : { mark: object.data.mark as ObjectRow["mark"] }),
          ...(object.data.after === undefined
            ? {}
            : { after: object.data.after as readonly string[] }),
          ...(object.data.badge === undefined
            ? {}
            : { badge: object.data.badge as string }),
        };
      },
      sections() {
        return [
          { id: "info", title: "Info" },
          { id: "log", title: "Log", live: true },
          { id: "pages", title: "Pages" },
          { id: "digits", title: "Digits" },
          { id: "hang", title: "Hang" },
          { id: "big", title: "Big" },
        ];
      },
      async load(_ctx, object, sectionId, { cursor }) {
        if (sectionId === "info") {
          return { markdown: INFO };
        }
        if (sectionId === "log") {
          logReads += 1;
          return {
            markdown: Array.from(
              { length: logReads },
              (_value, index) => `line ${index + 1}`,
            ).join("\n"),
          };
        }
        if (sectionId === "pages") {
          if (cursor === undefined) {
            return {
              markdown: "page one",
              next: "two",
              pages: [{ label: "one" }, { label: "two", cursor: "two" }],
            };
          }
          return { markdown: `page ${cursor}` };
        }
        if (sectionId === "digits") {
          // Labels that are numbers, in the opposite order of their positions.
          if (cursor === undefined) {
            return {
              markdown: "first",
              next: "b",
              pages: [{ label: "2" }, { label: "1", cursor: "b" }],
            };
          }
          return { markdown: "second" };
        }
        if (sectionId === "hang") {
          await waiting;
          return { markdown: "never" };
        }
        if (sectionId === "big") {
          return { markdown: "x".repeat(300 * 1024) };
        }
        return { markdown: String(object.data.title ?? "") };
      },
    },
  },
  actions: [
    {
      name: "approve",
      on: "item",
      args: {
        type: "object",
        properties: {
          note: {
            type: "string",
            role: "note",
            description: "Why this is approved",
          },
        },
        required: ["note"],
        additionalProperties: false,
      },
      when: (state) => state.approved !== true,
      async run(ctx, args) {
        const note =
          typeof args === "object" && args !== null && "note" in args
            ? String((args as { note?: unknown }).note ?? "")
            : "";
        const current = await ctx.store.get("item", ctx.object.id);
        await ctx.store.put(
          "item",
          ctx.object.id,
          {
            ...(current?.data ?? {}),
            approved: true,
            state: "approved",
            note: note.length > 0 ? note : (current?.data.note ?? ""),
            approvedNote: note,
            approvedBy: ctx.runId ?? "command",
          },
          "approve",
        );
        await ctx.facts.append({
          type: "item.approved",
          object: { type: "item", id: ctx.object.id },
          data: { note: note.length > 0 ? note : null },
        });
      },
    },
    {
      name: "auto",
      on: "item",
      args: {
        type: "object",
        properties: {
          level: {
            type: "string",
            enum: ["off", "run", "merge"],
            description: "How far the loop may go",
          },
        },
        required: ["level"],
        additionalProperties: false,
      },
      when: () => true,
      async run(ctx, args) {
        const level =
          typeof args === "object" && args !== null && "level" in args
            ? String((args as { level?: unknown }).level ?? "")
            : "";
        const current = await ctx.store.get("item", ctx.object.id);
        await ctx.store.put(
          "item",
          ctx.object.id,
          { ...(current?.data ?? {}), auto: level },
          "auto",
        );
      },
    },
    {
      name: "label",
      on: "item",
      args: {
        type: "object",
        properties: {
          text: { type: "string", description: "A label" },
          count: { type: "integer", description: "How many" },
        },
        additionalProperties: false,
      },
      when: () => true,
      async run(ctx, args) {
        const values = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
        const current = await ctx.store.get("item", ctx.object.id);
        await ctx.store.put(
          "item",
          ctx.object.id,
          {
            ...(current?.data ?? {}),
            label: values.text,
            count: values.count,
          },
          "label",
        );
      },
    },
    {
      name: "drop",
      on: "item",
      confirm: true,
      when: (state) => state.dropped !== true,
      async run(ctx) {
        const current = await ctx.store.get("item", ctx.object.id);
        await ctx.store.put(
          "item",
          ctx.object.id,
          { ...(current?.data ?? {}), dropped: true, state: "dropped" },
          "drop",
        );
      },
    },
    {
      name: "hidden",
      on: "item",
      when: () => false,
      run() {
        // Never available.
      },
    },
  ],
  keys: { m: "demo:approve" },
});
