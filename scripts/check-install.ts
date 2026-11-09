// Fail fast when node_modules is older than the workspace. Each package that
// depends on a workspace package gets its own link under its node_modules (the
// root only links what the root depends on), so the check walks every
// package.json and looks for the link each one needs.
//   bun scripts/check-install.ts [repository root]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function manifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

/** The links a checkout is missing, as `<package dir>/node_modules/<name>`. */
export function missingLinks(root: string): string[] {
  const dirs = [root];
  try {
    for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(root, "packages", entry.name));
    }
  } catch {
    // no packages directory: only the root is checked
  }
  const missing: string[] = [];
  for (const dir of dirs) {
    const m = manifest(dir);
    if (m === undefined) continue;
    const deps = { ...m.devDependencies, ...m.dependencies };
    for (const [name, range] of Object.entries(deps)) {
      if (!range.startsWith("workspace:")) continue;
      const link = join(dir, "node_modules", name);
      if (!existsSync(link)) missing.push(relative(root, link) || link);
    }
  }
  return missing;
}

/** One line saying what to do, or undefined when the install is current. */
export function staleInstallMessage(root: string): string | undefined {
  const missing = missingLinks(root);
  if (missing.length === 0) return undefined;
  const shown = missing.slice(0, 3).join(", ") + (missing.length > 3 ? `, and ${missing.length - 3} more` : "");
  return `stale install: ${shown} missing; run bun install`;
}

export function requireFreshInstall(root: string): void {
  const message = staleInstallMessage(root);
  if (message === undefined) return;
  console.error(message);
  process.exit(1);
}

if (import.meta.main) requireFreshInstall(process.argv[2] ?? join(dirname(import.meta.dir), "."));
