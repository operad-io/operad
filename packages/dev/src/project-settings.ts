/**
 * What a client may read and change in a registered repository's
 * `.operad/dev.json` and `.operad/review.json`. These are the kernel's small
 * schema subset; the full schemas editors read are `dev.schema.json` and the
 * review grading package's `review.schema.json`. A setting is `editable` when a
 * person tunes it from a client, and `confirm` when changing it changes what
 * merges.
 */

import type { ProjectSettingsDeclaration } from "@operad-io/engine";
import { listRepositories } from "./service.ts";

export const DEV_PROJECT_SETTINGS: ProjectSettingsDeclaration = {
  repositories: async ({ store }) =>
    (await listRepositories(store)).map(({ name, path }) => ({ name, path })),
  files: [
    {
      name: "dev",
      path: "dev.json",
      schema: {
        type: "object",
        properties: {
          concurrency: {
            type: "integer",
            minimum: 1,
            default: 1,
            editable: true,
            description:
              "How many of this repository's tasks may run at the same time.",
          },
          gate: {
            type: "object",
            properties: {
              commands: {
                type: "array",
                default: [],
                editable: true,
                description:
                  "The checks a task must pass before it is reviewed, run in order. Each is a shell line.",
              },
              commandTimeoutSecs: {
                type: "number",
                minimum: 1,
                default: 1800,
                editable: true,
                description:
                  "The longest one check may run, in seconds, before it counts as failed.",
              },
            },
          },
          reviewer: {
            type: "object",
            properties: {
              use: {
                type: "string",
                minLength: 1,
                default: "harness-radian/agent",
                editable: true,
                description:
                  "Which agent reviews a task's changes, as plugin/step, such as harness-claude/agent.",
              },
              args: {
                type: "array",
                items: { type: "string" },
                default: [],
                editable: true,
                description:
                  "Extra arguments for the reviewing agent; this is where its model is chosen.",
              },
              timeoutSecs: {
                type: "number",
                minimum: 1,
                default: 600,
                editable: true,
                description:
                  "The longest one review may take, in seconds, before it counts as timed out.",
              },
              fixLevel: {
                type: "string",
                enum: ["critical", "major", "minor"],
                default: "major",
                editable: true,
                confirm: true,
                description:
                  "The lowest severity of a review finding that sends a task back for rework instead of to you. Lower it and fewer tasks reach a merge unexamined; raise it and more do.",
              },
            },
          },
        },
      },
    },
    {
      name: "review",
      path: "review.json",
      schema: {
        type: "object",
        properties: {
          default: {
            type: "object",
            properties: {
              levels: {
                type: "object",
                properties: {
                  critical: {
                    type: "string",
                    editable: true,
                    confirm: true,
                    description:
                      "What the reviewer should call critical in this repository.",
                  },
                  major: {
                    type: "string",
                    editable: true,
                    confirm: true,
                    description:
                      "What the reviewer should call major in this repository.",
                  },
                  minor: {
                    type: "string",
                    editable: true,
                    confirm: true,
                    description:
                      "What the reviewer should call minor in this repository.",
                  },
                },
              },
              rules: {
                type: "array",
                items: { type: "string" },
                editable: true,
                confirm: true,
                description:
                  "Extra rules the reviewer follows when it grades a finding, one sentence each.",
              },
              fixLevel: {
                type: "string",
                enum: ["critical", "major", "minor"],
                editable: true,
                confirm: true,
                description:
                  "The lowest severity that sends a task back for rework. Wins over the same setting in dev.json.",
              },
            },
          },
        },
      },
    },
  ],
};
