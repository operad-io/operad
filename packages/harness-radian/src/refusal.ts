import { match, type AccessProfile } from "@operad-io/access-match";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One radian tool call as the access-match call it stands for. */
export function mapRadianCall(
  toolName: string,
  args: Record<string, unknown>,
): { readonly mapped: string; readonly input: Record<string, unknown> } {
  const lower = toolName.toLowerCase();
  let mapped = lower;
  let input: Record<string, unknown> = args;
  if (lower === "shell") mapped = "bash";
  else if (lower === "patch") mapped = "edit";
  else if (lower === "glob") {
    mapped = "find";
    const where = typeof args.path === "string" && args.path.length > 0 ? args.path : args.pattern;
    input = typeof where === "string" ? { ...args, path: where } : args;
  } else if (lower === "list") mapped = "ls";
  else if (!["bash", "read", "write", "edit", "grep", "find", "ls"].includes(lower) && typeof args.path === "string") {
    mapped = "read";
  }
  return { mapped, input };
}

/**
 * Why the access profile refuses a radian tool call, or undefined when it lets
 * it run. radian has no hook that could ask, so a call that would ask is refused
 * too (a read-only working directory refuses a write and a command that is not
 * known to only read; `operad-conversation.md` decision 13).
 */
export function radianRefusal(profile: AccessProfile, toolName: string, args: unknown, cwd: string): string | undefined {
  if (!isRecord(args)) return undefined;
  const { mapped, input } = mapRadianCall(toolName, args);
  const verdict = match(profile, { tool: mapped, input, cwd });
  if (verdict.allow) return undefined;
  return verdict.rule === "readOnly" || (verdict.ask === true && profile.readOnly === true)
    ? "this chat is read-only here"
    : verdict.rule === undefined
      ? "refused by the access profile"
      : `refused by the access profile (rule: ${verdict.rule.replace(/\s+/g, " ").slice(0, 120)})`;
}

