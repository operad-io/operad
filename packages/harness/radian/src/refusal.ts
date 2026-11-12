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

/** What to tell the agent after a refusal in a read-only directory. */
export const READ_ONLY_ADVICE = "Do not retry it; tell the person what you want to change, and they can open a worktree for it.";

/** The tools that only read, in a read-only directory (radian's names). */
const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "list", "memory_search", "ask_user", "skill", "job"]);

/** The server id of operad's own tools: its tools are `operad__<tool>`. */
const OPERAD_TOOL_PREFIX = "operad__";

/** Every path a `patch` call names: its own `path` and the `path` of each edit. */
function patchPaths(args: Record<string, unknown>): readonly string[] {
  const paths: string[] = [];
  const own = args.path ?? args.file_path;
  if (typeof own === "string" && own.length > 0) paths.push(own);
  for (const key of ["edits", "files", "patches"]) {
    const list = args[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const path = entry.path ?? entry.file_path;
      if (typeof path === "string" && path.length > 0) paths.push(path);
    }
  }
  return paths;
}

function describe(profile: AccessProfile, verdict: { readonly rule?: string | undefined; readonly ask?: true | undefined }): string {
  if (verdict.rule === "readOnly" || (verdict.ask === true && profile.readOnly === true)) {
    return `is refused: this chat is read-only here. ${READ_ONLY_ADVICE}`;
  }
  return verdict.rule === undefined
    ? "is refused by the access profile"
    : `is refused by the access profile (rule: ${verdict.rule.replace(/\s+/g, " ").slice(0, 120)})`;
}

/**
 * Why the access profile refuses a radian tool call, or undefined when it lets
 * it run. radian has no way to ask, so a call that would ask is refused too. In
 * a read-only directory only tools known to read run, and operad's own tools;
 * any other tool, a user's MCP server included, is refused. A `patch` is judged
 * on every path it names, and refused when it names none.
 */
export function radianRefusal(profile: AccessProfile, toolName: string, args: unknown, cwd: string): string | undefined {
  const lower = toolName.toLowerCase();
  const record = isRecord(args) ? args : {};
  if (profile.readOnly === true && !lower.startsWith(OPERAD_TOOL_PREFIX) && lower !== "shell" && !READ_ONLY_TOOLS.has(lower)) {
    return lower === "write" || lower === "patch"
      ? `is refused: this chat is read-only here. ${READ_ONLY_ADVICE}`
      : `is refused: this chat is read-only here and only reading tools and operad's tools run. ${READ_ONLY_ADVICE}`;
  }
  if (lower === "patch") {
    const paths = patchPaths(record);
    if (paths.length === 0) return "is refused: it names no file, so the access profile cannot judge it";
    for (const path of paths) {
      const verdict = match(profile, { tool: "edit", input: { path }, cwd });
      if (!verdict.allow) return describe(profile, verdict);
    }
    return undefined;
  }
  if (lower.startsWith(OPERAD_TOOL_PREFIX)) return undefined;
  const { mapped, input } = mapRadianCall(toolName, record);
  const verdict = match(profile, { tool: mapped, input, cwd });
  return verdict.allow ? undefined : describe(profile, verdict);
}
