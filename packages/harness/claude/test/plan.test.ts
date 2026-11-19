import { expect, test } from "bun:test";
import {
  PLAN_APPROVE,
  PLAN_QUESTION_ID,
  PLAN_REQUEST_CHANGES,
  PLAN_TITLE,
  planQuestions,
  planReview,
} from "../src/worker.ts";

test("a plan's first heading is its title and its whole Markdown is its text", () => {
  const text = "# Change the loader\n\n1. Edit src/a.ts\n2. Run the tests.";
  expect(planReview({ plan: text })).toEqual({ title: "Change the loader", text });
  expect(planReview({ plan: "## Smaller plan\n\nDo it." })?.title).toBe("Smaller plan");
});

test("a plan without a heading is titled by its first line, and an empty one falls back to Plan", () => {
  expect(planReview({ plan: "Change the loader first\n\nThen test." })?.title).toBe("Change the loader first");
  expect(planReview({ plan: "\n\n  " })).toBeUndefined();
  expect(planReview({})).toBeUndefined();
  expect(planReview({ plan: 3 })).toBeUndefined();
  const long = "x".repeat(200);
  const title = planReview({ plan: long })?.title ?? "";
  expect(title.length).toBe(120);
  expect(title.endsWith("…")).toBe(true);
  expect(PLAN_TITLE).toBe("Plan");
});

test("a plan review is one question with the plan as its body and two answers", () => {
  const text = "# Plan\n\nDo the work.";
  expect(planQuestions({ title: "Plan", text })).toEqual([
    {
      id: PLAN_QUESTION_ID,
      text: "Plan",
      body: text,
      choices: [
        { label: PLAN_APPROVE, description: "Leave plan mode and carry out the plan." },
        {
          label: PLAN_REQUEST_CHANGES,
          description: "Refuse this plan and end the reply so you can say what to change.",
        },
      ],
    },
  ]);
});
