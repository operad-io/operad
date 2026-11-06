import { describe, expect, test } from "bun:test";
import {
  appendChange,
  appendRework,
  briefBody,
  changesBody,
  editBrief,
  hasRework,
  planState,
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
    expect(one).toContain("## Changes\n- rework 1 (review)");
    const two = appendRework(one, "gate", "Second pass");
    expect(two).toContain("## Rework 2 (gate)\n\nSecond pass");
    expect(two).toContain("- rework 2 (gate)");
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
    expect(changesBody(edited)).toContain("- brief edited");
    expect(editBrief(edited, "New body")).toBe(edited);
  });

  test("appendChange creates a trailing section once", () => {
    expect(appendChange("", "created")).toBe("## Changes\n- created");
    expect(appendChange("Body", "created")).toBe(
      "Body\n\n## Changes\n- created",
    );
    expect(appendChange("Body\n\n## Changes\n- created", "edited")).toBe(
      "Body\n\n## Changes\n- created\n- edited",
    );
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
