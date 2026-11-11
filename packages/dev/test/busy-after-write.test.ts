import { afterAll, expect, test } from "bun:test";
import type { ObjectStore } from "@operad-io/engine";
import { addPlan, addRepository, addTask, confirmPlan, getPlan, getTask } from "../src/service.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

/**
 * A store that goes busy right after an object of one type is written, as a real one does when
 * another process holds the database past the wait: every later read and write
 * fails with SQLITE_BUSY.
 */
function busyAfterWrite(inner: ObjectStore, writtenType: string): ObjectStore {
  let busy = false;
  const fail = (): never => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  };
  return new Proxy(inner, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "put") {
        return (type: string, ...rest: unknown[]) => {
          if (busy) return fail();
          const result: unknown = Reflect.apply(value, target, [type, ...rest]);
          if (type === writtenType) busy = true;
          return result;
        };
      }
      if (property === "get" || property === "list") {
        return (...args: unknown[]) => (busy ? fail() : Reflect.apply(value, target, args));
      }
      return value.bind(target);
    },
  });
}

test("a task that was written is not reported as failed when the plan counts hit a busy store", async () => {
  const root = await tempRoot();
  const repository = await addRepository(storeAt(root), { path: await makeGitRepository(root) });
  const real = storeAt(root);
  const plan = await addPlan(real, { repository, slug: "work", title: "Work" });
  const flaky = busyAfterWrite(real, "task");

  const task = await addTask(flaky, { plan: plan.id, slug: "one", title: "One" });

  // The work is done once, and the command says so.
  expect((await getTask(real, task.id)).id).toBe(task.id);
  expect(real.list("task").objects.length).toBe(1);
});

test("a plan that was confirmed is not reported as failed when the repository counts hit a busy store", async () => {
  const root = await tempRoot();
  const repository = await addRepository(storeAt(root), { path: await makeGitRepository(root) });
  const real = storeAt(root);
  const plan = await addPlan(real, { repository, slug: "work", title: "Work" });
  await addTask(real, { plan: plan.id, slug: "one", title: "One" });

  const confirmed = await confirmPlan(busyAfterWrite(real, "plan"), plan.id);

  expect(confirmed.id).toBe(plan.id);
  expect((await getPlan(real, plan.id)).data).toMatchObject({ status: "confirmed" });
});
