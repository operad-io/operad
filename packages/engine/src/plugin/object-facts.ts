/**
 * Object facts hold changes, not full snapshots. A `put` writes only the
 * top-level fields whose value changed and the names of the fields it removed;
 * the object table keeps the whole current value. A fact written before this
 * rule is still read: its type equals the object's type and its data is the
 * whole object.
 */

import { isRecord } from "../util.ts";
import type { ObjectData, ObjectRef, PluginFact } from "./types.ts";

/** The fact type a `put` writes; it cannot be mistaken for an old snapshot. */
export const OBJECT_CHANGE_FACT = "object.changed";

/** What a change fact holds. */
export type ObjectChange = ObjectData & {
  readonly changed: ObjectData;
  readonly removed: readonly string[];
};

/** One object fact and the object's whole value after it. */
export interface ObjectFactVersion {
  readonly fact: PluginFact;
  readonly data: ObjectData;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => sameValue(value, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length) return false;
    return leftKeys.every(
      (key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]),
    );
  }
  return false;
}

/**
 * The change from `previous` to `data`, or undefined when nothing top-level
 * changed. Values compare deeply; an array or object equal in content is not a
 * change.
 */
export function diffObject(
  previous: ObjectData,
  data: ObjectData,
): ObjectChange | undefined {
  const changed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    if (!Object.hasOwn(previous, name) || !sameValue(previous[name], value)) {
      changed[name] = value;
    }
  }
  const removed = Object.keys(previous)
    .filter((name) => !Object.hasOwn(data, name))
    .sort();
  if (Object.keys(changed).length === 0 && removed.length === 0) return undefined;
  return { changed, removed };
}

/** The whole object after applying one change. */
export function applyObjectChange(
  previous: ObjectData,
  change: ObjectChange,
): ObjectData {
  const value: Record<string, unknown> = { ...previous };
  for (const name of change.removed) delete value[name];
  for (const [name, field] of Object.entries(change.changed)) value[name] = field;
  return value;
}

/** The change a change fact's data holds; undefined when it is not that shape. */
export function objectChangeOf(data: ObjectData): ObjectChange | undefined {
  const changed = data.changed;
  const removed = data.removed;
  if (!isRecord(changed) || !Array.isArray(removed)) return undefined;
  if (!removed.every((name) => typeof name === "string")) return undefined;
  return { changed, removed };
}

/** A fact that belongs to an object. */
export type ObjectFact = PluginFact & { readonly object: ObjectRef };

/** Whether a fact records a version of its object, in either shape. */
export function isObjectFact(fact: PluginFact): fact is ObjectFact {
  if (fact.object === undefined) return false;
  return fact.type === OBJECT_CHANGE_FACT || fact.type === fact.object.type;
}

/**
 * The object's whole value after `fact`, or undefined when the fact is not an
 * object version (an appended fact) or its change cannot be read.
 */
export function objectValueAfter(
  fact: PluginFact,
  previous: ObjectData,
): ObjectData | undefined {
  if (fact.object === undefined) return undefined;
  if (fact.type === OBJECT_CHANGE_FACT) {
    const change = objectChangeOf(fact.data);
    return change === undefined ? undefined : applyObjectChange(previous, change);
  }
  // A fact written before `put` recorded changes only: data is the whole object.
  if (fact.type === fact.object.type) return { ...fact.data };
  return undefined;
}

/**
 * Yields the object's whole value after each version fact of one object, in
 * order. `start` is the value before the first fact (usually empty); appended
 * facts are skipped and leave it alone. The generator returns the final value,
 * so a reader paging the facts can carry it to the next page.
 */
export function* foldObjectFacts(
  facts: Iterable<PluginFact>,
  start: ObjectData = {},
): Generator<ObjectFactVersion, ObjectData> {
  let current: ObjectData = { ...start };
  for (const fact of facts) {
    const next = objectValueAfter(fact, current);
    if (next === undefined) continue;
    current = next;
    yield { fact, data: current };
  }
  return current;
}
