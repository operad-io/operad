import { describe, expect, test } from "bun:test";
import {
  appendChange,
  appendRework,
  changeClock,
  briefBody,
  changesBody,
  editBrief,
  hasRework,
  planState,
  renderChanges,
  parseId,
  replaceBriefBody,
  reworkBody,
  splitBrief,
  validateSlug,
  type PlanData,
} from "../src/model.ts";
import { guardLockHandles } from "./support.ts";

guardLockHandles();

function plan(overrides: Partial<PlanData> = {}): PlanData {
  return {
    repository: "main",
    title: "A plan",
    request: "do it",
    status: "confirmed",
    auto: "off",
    priority: "P3",
    concurrency: 1,
    taskCount: 2,
    mergedCount: 0,
    cancelledCount: 0,
    ...overrides,
  };
}

describe("dev model", () => {
  test("a slug is 1-48 of a-z0-9- with no edge hyphen", () => {
    expect(validateSlug("a")).toBe("a");
    expect(validateSlug("a-1")).toBe("a-1");
    expect(() => validateSlug("")).toThrow(/^slug:/);
    expect(() => validateSlug("-a")).toThrow(/^slug:/);
    expect(() => validateSlug("a-")).toThrow(/^slug:/);
    expect(() => validateSlug("A")).toThrow(/^slug:/);
    expect(() => validateSlug("a_b")).toThrow(/^slug:/);
    expect(() => validateSlug("a".repeat(49))).toThrow(/^slug:/);
  });

  test("a fenced Rework heading is text, not a section", () => {
    const brief = [
      "Body",
      "",
      "```md",
      "## Rework 1 (review)",
      "still code",
      "```",
      "",
      "Tail",
    ].join("\n");
    expect(hasRework(brief)).toBe(false);
    expect(splitBrief(brief).body).toBe(brief);
    expect(briefBody(brief)).toBe(brief);
  });

  test("split keeps the body, rework sections and the changes section", () => {
    const brief = [
      "Body",
      "",
      "## Rework 1 (review)",
      "",
      "Fix it",
      "",
      "## Changes",
      "- created",
    ].join("\n");
    const parts = splitBrief(brief);
    expect(parts.body).toBe("Body");
    expect(parts.reworks).toBe("## Rework 1 (review)\n\nFix it");
    expect(parts.changes).toBe("## Changes\n- created");
    expect(hasRework(brief)).toBe(true);
  });

  test("replaceBriefBody keeps every rework and the changes section", () => {
    const brief = [
      "Old body",
      "",
      "## Rework 1 (review)",
      "",
      "Fix it",
      "",
      "## Changes",
      "- created",
    ].join("\n");
    expect(replaceBriefBody(brief, "New body")).toBe(
      [
        "New body",
        "",
        "## Rework 1 (review)",
        "",
        "Fix it",
        "",
        "## Changes",
        "- created",
      ].join("\n"),
    );
  });

  test("appendRework numbers real sections and records the change", () => {
    const one = appendRework("Body", "review", "First pass");
    expect(one).toContain("## Rework 1 (review)\n\nFirst pass");
    expect(one).toContain("## Changes\n- [");
    expect(one).toContain("] rework 1 — review: First pass");
    const two = appendRework(one, "gate", "Second pass");
    expect(two).toContain("## Rework 2 (gate)\n\nSecond pass");
    expect(two).toContain("] rework 2 — gate: Second pass");
  });

  test("a fenced Rework heading does not change the next number", () => {
    const brief = "```\n## Rework 9 (not real)\n```";
    expect(appendRework(brief, "review", "Real")).toContain(
      "## Rework 1 (review)",
    );
  });

  test("editBrief replaces only the body and records one edit", () => {
    const brief = appendRework("Body", "review", "Fix it");
    const edited = editBrief(brief, "New body");
    expect(briefBody(edited)).toBe("New body");
    expect(reworkBody(edited)).toContain("## Rework 1 (review)");
    expect(changesBody(edited)).toContain("] brief edited");
    expect(editBrief(edited, "New body")).toBe(edited);
  });

  test("appendChange creates a trailing section once", () => {
    const at = "[2026-11-08T21:05:00.000Z]";
    withClock(Date.parse("2026-11-08T21:05:00.000Z"), () => {
      expect(appendChange("", "created")).toBe(`## Changes\n- ${at} created`);
      expect(appendChange("Body", "created")).toBe(
        `Body\n\n## Changes\n- ${at} created`,
      );
      expect(appendChange(`Body\n\n## Changes\n- ${at} created`, "edited")).toBe(
        `Body\n\n## Changes\n- ${at} created\n- ${at} edited`,
      );
    });
  });

  test("an id parses in both forms, and a slug may start with digits", () => {
    expect(parseId("P-0004-alpha", "plan")).toEqual({ number: 4, slug: "alpha" });
    expect(parseId("PL0004-alpha", "plan")).toEqual({ number: 4, slug: "alpha" });
    expect(parseId("T-0001-2fa", "task")).toEqual({ number: 1, slug: "2fa" });
    expect(parseId("TK0001-2fa", "task")).toEqual({ number: 1, slug: "2fa" });
    expect(parseId("T-0001-2fa", "plan")).toBeUndefined();
    expect(parseId("T0001-2fa", "task")).toBeUndefined();
    expect(parseId("P0004-alpha", "plan")).toBeUndefined();
    expect(parseId("P-004-alpha", "plan")).toBeUndefined();
  });

  test("a plan is finished from its tasks", () => {
    expect(planState(plan())).toBe("confirmed");
    expect(planState(plan({ mergedCount: 2 }))).toBe("finished");
    expect(planState(plan({ mergedCount: 1, cancelledCount: 1 }))).toBe(
      "finished",
    );
    expect(planState(plan({ status: "cancelled" }))).toBe("cancelled");
    expect(planState(plan({ status: "draft" }))).toBe("draft");
  });
});

function withClock<T>(at: number, body: () => T): T {
  const saved = changeClock.now;
  changeClock.now = () => at;
  try {
    return body();
  } finally {
    changeClock.now = saved;
  }
}

describe("the Changes story", () => {
  const stamp = (iso: string, text: string): string =>
    withClock(Date.parse(iso), () => appendChange("Body", text));
  const local = (iso: string): string => {
    const d = new Date(iso);
    const two = (n: number): string => String(n).padStart(2, "0");
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
  };

  test("an entry shows its local time, and a date line starts each day", () => {
    let brief = "Body";
    const first = "2026-11-08T10:05:00.000Z";
    const second = "2026-11-08T10:31:00.000Z";
    const third = "2026-11-10T10:40:00.000Z";
    for (const [iso, text] of [
      [first, "created"],
      [second, "merged origin/main 83163e5 into the branch (clean)"],
      [third, "merged as 0bce8fa"],
    ] as const) {
      brief = withClock(Date.parse(iso), () => appendChange(brief, text));
    }
    const lines = renderChanges(changesBody(brief)).split("\n");
    const day = (iso: string): string => {
      const d = new Date(iso);
      const two = (n: number): string => String(n).padStart(2, "0");
      return `**${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}**`;
    };
    expect(lines).toEqual([
      day(first),
      "",
      `- ${local(first)}  created`,
      `- ${local(second)}  merged origin/main 83163e5 into the branch (clean)`,
      "",
      day(third),
      "",
      `- ${local(third)}  merged as 0bce8fa`,
    ]);
  });

  test("a rework names who asked and the first finding, cut to one line", () => {
    const long = `${"x".repeat(300)}`;
    const brief = withClock(Date.parse("2026-11-08T10:05:00.000Z"), () =>
      appendRework("Body", "review", "ignored", `src/a.ts:1 major: ${long}`),
    );
    const entry = renderChanges(changesBody(brief)).split("\n").pop() ?? "";
    expect(entry).toStartWith(`- ${local("2026-11-08T10:05:00.000Z")}  rework 1 — review: src/a.ts:1 major: xxx`);
    expect(entry.endsWith("…")).toBe(true);
    expect(entry.split("rework 1 — review: ")[1]?.length).toBeLessThanOrEqual(160);
  });

  test("a lead or owner rework carries the first line of its note", () => {
    const lead = stamp("2026-11-08T10:05:00.000Z", "x");
    expect(lead).toContain("x");
    const brief = withClock(Date.parse("2026-11-08T10:05:00.000Z"), () =>
      appendRework("Body", "lead", "cover the empty case\nand the full one"),
    );
    expect(changesBody(brief)).toContain("] rework 1 — lead: cover the empty case");
    expect(changesBody(brief)).not.toContain("and the full one");
  });

  test("a note on a change follows an em dash", () => {
    const brief = withClock(Date.parse("2026-11-08T10:05:00.000Z"), () =>
      appendChange("Body", "reject", "needs a test"),
    );
    expect(changesBody(brief)).toContain("] reject — needs a test");
  });

  test("an old entry without a time renders as it was written", () => {
    const old = "Body\n\n## Changes\n- created\n- rework 1 (review)";
    const brief = withClock(Date.parse("2026-11-08T10:05:00.000Z"), () =>
      appendChange(old, "ready"),
    );
    const lines = renderChanges(changesBody(brief)).split("\n");
    expect(lines.slice(0, 2)).toEqual(["- created", "- rework 1 (review)"]);
    expect(lines.at(-1)).toBe(`- ${local("2026-11-08T10:05:00.000Z")}  ready`);
  });
});
