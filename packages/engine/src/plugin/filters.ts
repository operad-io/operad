/** The row filters of an object type, with the kernel's implicit `all`. */

import type { ObjectFilterDefinition, ObjectTypeDefinition } from "./types.ts";

/** The name of the filter the kernel adds to every type that declares filters. */
export const ALL_FILTER = "all";

/** One filter as a client sees it; `all` has no states. */
export interface TypeFilter {
  readonly name: string;
  readonly states?: readonly string[] | undefined;
}

/** A type's filters in display order and the name of its default. */
export interface TypeFilters {
  readonly filters: readonly TypeFilter[];
  readonly default: string;
}

/**
 * The filters of a type: the declared order, with `all` right after the
 * default. Undefined when the type declares none.
 */
export function typeFilters(
  definition: ObjectTypeDefinition | undefined,
): TypeFilters | undefined {
  const declared: readonly ObjectFilterDefinition[] = definition?.filters ?? [];
  if (declared.length === 0) return undefined;
  const marked = declared.find((filter) => filter.default === true);
  const defaultName = (marked ?? declared[0])?.name ?? ALL_FILTER;
  const filters: TypeFilter[] = [];
  for (const filter of declared) {
    filters.push({ name: filter.name, states: filter.states });
    if (filter.name === defaultName) filters.push({ name: ALL_FILTER });
  }
  return { filters, default: defaultName };
}

/** True when a row in this state is shown by the filter. An error row always is. */
export function filterShows(
  filter: TypeFilter,
  state: string,
): boolean {
  if (filter.states === undefined) return true;
  return state === "error" || filter.states.includes(state);
}
