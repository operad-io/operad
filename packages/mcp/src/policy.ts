/** Which actions a lead may run through MCP, and which stay with the owner. */

import {
  DEFAULT_MCP,
  splitActionName,
  type ActionInfo,
  type McpConfig,
  type PendingItem,
  type ViewAction,
  type ViewObject,
} from "@operad-io/engine";

/** The configured allow lists, prepared for lookups. */
export interface McpPolicy {
  readonly actions: ReadonlySet<string>;
  readonly confirmActions: ReadonlySet<string>;
}

/** Reads a config's `mcp` section, or the defaults when it has none. */
export function mcpPolicy(config: McpConfig | undefined): McpPolicy {
  const value = config ?? DEFAULT_MCP;
  return {
    actions: new Set(value.actions),
    confirmActions: new Set(value.confirmActions),
  };
}

/** Whether the lead may run this action with the configured allow lists. */
export function actionMayRun(
  policy: McpPolicy,
  action: Pick<ActionInfo, "name" | "confirm">,
): boolean {
  return (
    policy.actions.has(action.name) &&
    (action.confirm !== true || policy.confirmActions.has(action.name))
  );
}

/** The one refusal message for an action the owner keeps. */
export function ownerRefusal(name: string): string {
  return `action "${name}" is not allowed through MCP; the owner runs it`;
}

/** Finds an action by `<plugin>:<action>` or a unique plain action name. */
export function actionInfoNamed(
  actions: readonly ActionInfo[],
  name: string,
): ActionInfo | undefined {
  const split = splitActionName(name);
  if (split !== undefined) {
    return actions.find(
      (info) => info.plugin === split.plugin && info.action === split.action,
    );
  }
  const matches = actions.filter((info) => info.action === name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** A shown object with the lead's actions separated from the owner's. */
export interface McpViewObject extends ViewObject {
  /** The names of the available actions the lead may not run. */
  readonly ownerActions: readonly string[];
}

/** Splits the available actions into the lead's and the owner's. */
export function splitActions(
  object: ViewObject,
  policy: McpPolicy,
): McpViewObject {
  const actions: ViewAction[] = [];
  const ownerActions: string[] = [];
  for (const action of object.actions) {
    if (actionMayRun(policy, action)) actions.push(action);
    else ownerActions.push(action.name);
  }
  return { ...object, actions, ownerActions };
}

/** Keeps only the pending actions the lead may run. */
export function splitPendingActions(
  pending: readonly PendingItem[],
  actions: readonly ActionInfo[],
  policy: McpPolicy,
): readonly PendingItem[] {
  const byName = new Map(actions.map((info) => [info.name, info]));
  return pending.map((item) => ({
    ...item,
    actions: item.actions.filter((action) => {
      const info = byName.get(`${action.plugin}:${action.action}`);
      return info !== undefined && actionMayRun(policy, info);
    }),
  }));
}
