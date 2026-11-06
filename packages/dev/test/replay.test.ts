import { afterAll, expect, test } from "bun:test";
import {
  addPlan,
  addRepository,
  addRework,
  addTask,
  cancelPlan,
  cancelTask,
  confirmPlan,
  confirmTask,
  editTaskBrief,
  liveObjects,
  rebuildObjects,
  setAuto,
  setPriority,
  setTaskPhase,
  updateTask,
} from "../src/service.ts";
import {
  PRIORITIES,
  bareId,
  type AutoMode,
  type TaskPhase,
} from "../src/model.ts";
import { cleanupTempRoots, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const PHASES: readonly TaskPhase[] = [
  "proposed",
  "ready",
  "running",
  "review",
  "waiting",
  "merged",
  "cancelled",
];
const AUTOS: readonly AutoMode[] = ["off", "run", "merge"];
const SLUGS = ["alpha", "beta", "gamma", "delta", "epsilon"];

test("2 000 random operations rebuild from history every time", async () => {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath });
  const randomOf = random(0x5eed);
  const pick = <T,>(items: readonly T[]): T | undefined =>
    items[Math.floor(randomOf() * items.length)];
  const plans: string[] = [];
  const tasks: string[] = [];

  for (let step = 0; step < 2000; step += 1) {
    const operation = Math.floor(randomOf() * 14);
    try {
      if (operation === 0) {
        const plan = await addPlan(store, {
          repository,
          slug: pick(SLUGS) ?? "alpha",
          title: `Plan ${step}`,
          request: `request ${step}`,
        });
        plans.push(plan.id);
      } else if (operation === 1 && plans.length > 0) {
        const plan = pick(plans);
        if (plan !== undefined) {
          const task = await addTask(store, {
            plan,
            slug: pick(SLUGS) ?? "alpha",
            title: `Task ${step}`,
            brief: `brief ${step}`,
          });
          tasks.push(task.id);
        }
      } else if (operation === 2 && tasks.length > 0) {
        const id = pick(tasks);
        if (id !== undefined) {
          await updateTask(store, id, { title: `Title ${step}` }).catch(() => undefined);
        }
      } else if (operation === 3 && tasks.length > 0) {
        const id = pick(tasks);
        if (id !== undefined) {
          await addRework(store, id, "review", `rework ${step}`).catch(
            () => undefined,
          );
        }
      } else if (operation === 4 && plans.length > 0) {
        const id = pick(plans);
        if (id !== undefined) {
          await confirmPlan(store, id).catch(() => undefined);
        }
      } else if (operation === 5 && tasks.length > 0) {
        const id = pick(tasks);
        if (id !== undefined) {
          await confirmTask(store, id).catch(() => undefined);
        }
      } else if (operation === 6 && plans.length > 0) {
        const id = pick(plans);
        const auto = pick(AUTOS);
        if (id !== undefined && auto !== undefined) {
          await setAuto(store, id, auto).catch(() => undefined);
        }
      } else if (operation === 7 && plans.length > 0) {
        const id = pick(plans);
        const priority = pick(PRIORITIES);
        if (id !== undefined && priority !== undefined) {
          await setPriority(store, id, priority).catch(() => undefined);
        }
      } else if (operation === 8 && tasks.length > 0) {
        const id = pick(tasks);
        const phase = pick(PHASES);
        if (id !== undefined && phase !== undefined) {
          await setTaskPhase(store, id, phase).catch(() => undefined);
        }
      } else if (operation === 9 && tasks.length > 0) {
        const id = pick(tasks);
        if (id !== undefined) {
          await cancelTask(store, id).catch(() => undefined);
        }
      } else if (operation === 10 && plans.length > 0) {
        const id = pick(plans);
        if (id !== undefined) {
          await cancelPlan(store, id).catch(() => undefined);
        }
      } else if (operation === 11 && tasks.length > 0) {
        const id = pick(tasks);
        if (id !== undefined) {
          await editTaskBrief(store, id, `body ${step}`).catch(() => undefined);
        }
      } else if (operation === 12 && tasks.length > 0) {
        const target = pick(tasks);
        const after = pick(tasks);
        if (target !== undefined && after !== undefined) {
          await updateTask(store, target, { after: [bareId(after)] }).catch(
            () => undefined,
          );
        }
      } else if (operation === 13 && plans.length > 0) {
        await store.list("plan");
      }
    } catch {
      // A refused operation leaves the objects as they were.
    }

    const rebuilt = rebuildObjects(store.facts());
    const live = await liveObjects(store);
    expect(rebuilt).toEqual(live);
  }

  expect(plans.length).toBeGreaterThan(0);
  expect(tasks.length).toBeGreaterThan(0);
});
