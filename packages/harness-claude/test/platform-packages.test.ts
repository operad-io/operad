import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "../..", "..");
const PACKAGE_ROOT = join(ROOT, "packages", "harness-claude");

const PLATFORM_PACKAGES = new Set([
  "claude-agent-sdk-linux-x64",
  "claude-agent-sdk-linux-arm64",
  "claude-agent-sdk-linux-x64-musl",
  "claude-agent-sdk-linux-arm64-musl",
  "claude-agent-sdk-darwin-x64",
  "claude-agent-sdk-darwin-arm64",
  "claude-agent-sdk-win32-x64",
  "claude-agent-sdk-win32-arm64",
]);

/** Files `empty-npm-package` ships; anything else means the placeholder was replaced. */
const EMPTY_PACKAGE_FILES = new Set(["package.json", "index.js"]);
const EMPTY_PACKAGE_BYTES = 4096;

interface PlatformCandidate {
  readonly label: string;
  readonly dir: string;
}

function addAnthropicDir(dir: string, label: string, out: Map<string, string>): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!PLATFORM_PACKAGES.has(name)) continue;
    const full = join(dir, name);
    if (!existsSync(full)) continue;
    out.set(`${label}/${name}`, full);
  }
}

function platformCandidates(): PlatformCandidate[] {
  const found = new Map<string, string>();

  addAnthropicDir(join(ROOT, "node_modules", "@anthropic-ai"), "root", found);
  addAnthropicDir(join(PACKAGE_ROOT, "node_modules", "@anthropic-ai"), "package", found);

  const sdkLink = join(PACKAGE_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  if (existsSync(sdkLink)) {
    addAnthropicDir(dirname(realpathSync(sdkLink)), "sdk", found);
  }

  // Bun keeps workspace dependencies under node_modules/.bun. An override
  // removes the platform package there as well; without one, these entries
  // are the real binaries.
  const bunStore = join(ROOT, "node_modules", ".bun");
  if (existsSync(bunStore)) {
    for (const entry of readdirSync(bunStore)) {
      if (!entry.startsWith("@anthropic-ai+claude-agent-sdk-")) continue;
      addAnthropicDir(join(bunStore, entry, "node_modules", "@anthropic-ai"), `store/${entry}`, found);
    }
  }

  return [...found].map(([label, dir]) => ({ label, dir }));
}

function filesUnder(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  return files;
}

function problemsWith(candidate: PlatformCandidate): string[] {
  const problems: string[] = [];
  const packageJson = join(candidate.dir, "package.json");
  if (!existsSync(packageJson)) {
    problems.push(`${candidate.label}: no package.json, so it is not the placeholder`);
  } else {
    const parsed: unknown = JSON.parse(readFileSync(packageJson, "utf8"));
    const name = typeof parsed === "object" && parsed !== null && "name" in parsed ? parsed.name : undefined;
    if (name !== "empty-npm-package") {
      problems.push(`${candidate.label}: package name is ${String(name)}, not empty-npm-package`);
    }
  }

  for (const file of filesUnder(candidate.dir)) {
    const path = relative(candidate.dir, file).split(sep).join("/");
    if (!EMPTY_PACKAGE_FILES.has(path)) {
      problems.push(`${candidate.label}: unexpected file ${path}`);
      continue;
    }
    const size = statSync(file).size;
    if (size > EMPTY_PACKAGE_BYTES) {
      problems.push(`${candidate.label}: ${path} is ${size} bytes, not an empty placeholder`);
    }
  }
  return problems;
}

test("every installed Claude Agent SDK platform package is an empty placeholder", () => {
  const problems = platformCandidates().flatMap(problemsWith);
  expect(problems).toEqual([]);
});
