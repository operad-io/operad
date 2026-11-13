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
        $defs: {
          checkCommand: {
            oneOf: [
              { type: "string", minLength: 1 },
              {
                type: "object",
                properties: {
                  run: { type: "string", minLength: 1 },
                  failed: {
                    type: "object",
                    properties: {
                      match: { type: "string", minLength: 1 },
                      rerun: { type: "string", minLength: 1 },
                      max: { type: "integer", minimum: 1 },
                      stress: { type: "string", minLength: 1 },
                      rule: { type: "string", minLength: 1 },
                    },
                    required: ["match", "rerun"],
                    additionalProperties: false,
                  },
                },
                required: ["run"],
                additionalProperties: false,
              },
            ],
          },
        },
        properties: {
          concurrency: {
            type: "integer",
            minimum: 1,
            editable: true,
            description:
              "The most of this repository's tasks that run at the same time, on top of the worker counts. Unset means the workers' own counts decide.",
          },
          autoDefault: {
            type: "string",
            enum: ["off", "run", "merge"],
            default: "off",
            editable: true,
            confirm: true,
            description:
              "The auto level a new plan starts at: off waits for you to start tasks, run starts them by itself, merge also merges a task whose review passed. Plans already made keep their level.",
          },
          gate: {
            type: "object",
            properties: {
              commands: {
                type: "array",
                items: { $ref: "#/$defs/checkCommand" },
                default: [],
                editable: true,
                description:
                  "The checks a task must pass before it is reviewed, run in order. Each is a shell line; a check with a rerun of its failed tests is edited in the file.",
              },
              commandTimeoutSecs: {
                type: "number",
                minimum: 1,
                default: 1800,
                editable: true,
                description:
                  "The longest one check may run, in seconds, before it counts as failed.",
              },
              stallSecs: {
                type: "number",
                minimum: 1,
                editable: true,
                description:
                  "How long a check may write nothing, in seconds, before it is stopped and fails as a stall. Unset turns the limit off.",
              },
            },
          },
          reviewer: {
            type: "object",
            properties: {
              use: {
                type: "string",
                minLength: 1,
                default: "radian/agent",
                editable: true,
                description:
                  "Which agent reviews a task's changes, as plugin/step, such as claude/agent.",
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
