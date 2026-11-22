/**
 * What a client may read and change in a registered repository's
 * `.operad/dev.json` and `.operad/review.json`. These are the kernel's small
 * schema subset; the full schemas editors read are `dev.schema.json` and the
 * review grading package's `review.schema.json`. A setting is `editable` when a
 * person tunes it from a client, and `confirm` when changing it changes what
 * merges.
 */

import { messageOf } from "@operad-io/engine";
import type { ProjectSettingsDeclaration } from "@operad-io/engine";
import { flowClash, listRepositoryFlows } from "./project-flows.ts";
import { defaultDevSettings, readDevSettings, settingsProblem, settingsValueProblem, useNewStageNames } from "./settings.ts";
import { listRepositories } from "./service.ts";
import type { JsonValue } from "@operad-io/engine";

export const DEV_PROJECT_SETTINGS: ProjectSettingsDeclaration = {
  repositories: async ({ store }) =>
    (await listRepositories(store)).map(({ name, path }) => ({ name, path })),
  files: [
    {
      name: "dev",
      path: "dev.json",
      // dev's own check of the file as it would be written: its schema and rules
      // (ADR 0020 D4), then the name clash with a TypeScript flow (D6). It runs
      // for a flow change only, so an invalid flow already in the file does not
      // block an unrelated setting.
      check: ({ repository, value, name }) => {
        if (name !== "dev.flows" && !name.startsWith("dev.flows.")) return undefined;
        const problem =
          settingsValueProblem(repository.path, value) ??
          flowClash(repository.path, value.flows);
        if (problem === undefined) useNewStageNames(value);
        return problem;
      },
      derived: async ({ repository }) => {
        const problem = settingsProblem(repository.path);
        let settings;
        try {
          settings = await readDevSettings(repository.path);
        } catch (error) {
          // The file was never valid, so there are no dev.json flows to list;
          // the read-only list stays and says why, beside the TypeScript flows.
          const reason =
            problem ?? (messageOf(error));
          const list = await listRepositoryFlows(
            repository.path,
            repository.name,
            defaultDevSettings(),
          );
          return {
            flowList: [
              { name: "dev.json", source: "dev.json", refused: reason },
              ...list,
            ] as unknown as JsonValue,
          };
        }
        const list = await listRepositoryFlows(repository.path, repository.name, settings);
        return {
          flowList: (
            problem === undefined
              ? list
              : [{ name: "dev.json", source: "dev.json", refused: problem }, ...list]
          ) as unknown as JsonValue,
        };
      },
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
            title: "Tasks at once",
            minimum: 1,
            editable: true,
            description:
              "The most of this repository's tasks that run at the same time, on top of the worker counts. Unset means the workers' own counts decide.",
          },
          workIn: {
            title: "Work in",
            oneOf: [
              { const: "branch", title: "A branch in this folder" },
              { const: "worktree", title: "A separate worktree" },
            ],
            default: "worktree",
            editable: true,
            description:
              "Where a task's changes are made. branch (A branch in this folder): dev makes the task's branch in the main clone and the task works there, one task at a time; it cannot be combined with a concurrency above 1 or workers that add up to more than 1. worktree (A separate worktree): each task has its own worktree.",
          },
          autoDefault: {
            type: "string",
            title: "Auto for new plans",
            enum: ["off", "run", "merge"],
            default: "off",
            editable: true,
            confirm: true,
            description:
              "The auto level a new plan starts at: off waits for you to start tasks, run starts them by itself, merge also merges a task whose review passed. Plans already made keep their level.",
          },
          flows: {
            type: "object",
            title: "Custom flows",
            editable: true,
            description:
              "The repository's own flows, by name. A flow is { \"stages\": [...] }, each stage one of code, test, review or human (the older names work and check still load); dev checks the flow when it is saved and refuses one that breaks its rules. A name may also be changed on its own (dev.flows.<name>); null removes it.",
            additionalProperties: {
              type: "object",
              properties: {
                stages: { type: "array", items: { type: "object" } },
              },
            },
          },
          flowList: {
            type: "array",
            title: "Flows",
            items: { type: "object" },
            description:
              "Every flow of the repository, read only: its name, where it comes from (dev.json, typescript or built-in), its stages for a dev.json flow or the built-in default, the steps dev reads for a TypeScript flow, or why dev refuses the file.",
          },
          gate: {
            type: "object",
            properties: {
              commands: {
                type: "array",
                title: "Check commands",
                items: { $ref: "#/$defs/checkCommand" },
                default: [],
                editable: true,
                description:
                  "The checks a task must pass before it is reviewed, run in order. Each is a shell line; a check with a rerun of its failed tests is edited in the file.",
              },
              commandTimeoutSecs: {
                type: "number",
                title: "Check timeout",
                minimum: 1,
                default: 1800,
                editable: true,
                description:
                  "The longest one check may run, in seconds, before it counts as failed.",
              },
              stallSecs: {
                type: "number",
                title: "Check stall limit",
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
                title: "Reviewer",
                minLength: 1,
                default: "radian/agent",
                editable: true,
                description:
                  "Which agent reviews a task's changes, as plugin/step, such as claude/agent.",
              },
              args: {
                type: "array",
                title: "Reviewer arguments",
                items: { type: "string" },
                default: [],
                editable: true,
                description:
                  "Extra arguments for the reviewing agent; this is where its model is chosen.",
              },
              timeoutSecs: {
                type: "number",
                title: "Review timeout",
                minimum: 1,
                default: 600,
                editable: true,
                description:
                  "The longest one review may take, in seconds, before it counts as timed out.",
              },
              fixLevel: {
                type: "string",
                title: "Reviewer rework threshold",
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
                    title: "Critical level",
                    editable: true,
                    confirm: true,
                    description:
                      "What the reviewer should call critical in this repository.",
                  },
                  major: {
                    type: "string",
                    title: "Major level",
                    editable: true,
                    confirm: true,
                    description:
                      "What the reviewer should call major in this repository.",
                  },
                  minor: {
                    type: "string",
                    title: "Minor level",
                    editable: true,
                    confirm: true,
                    description:
                      "What the reviewer should call minor in this repository.",
                  },
                },
              },
              rules: {
                type: "array",
                title: "Review rules",
                items: { type: "string" },
                editable: true,
                confirm: true,
                description:
                  "Extra rules the reviewer follows when it grades a finding, one sentence each.",
              },
              fixLevel: {
                type: "string",
                title: "Rework threshold",
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
