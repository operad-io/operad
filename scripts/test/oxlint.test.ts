// The lint (`bun run lint`, run by hand) reports each of the four rules
// CLAUDE.md names. A fixture breaks each rule once; a config that silently
// stops checking a rule fails here. The lint is not part of the checks
// (ADR 0036 D5), and the test is skipped where oxlint cannot start (the test
// host's CPU has no AVX2, so its native binding crashes).

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const fixture = `
export const anything: any = 1;
// @ts-ignore
export const wrong: number = "text";
export function first(list: string[]): string {
  return list[0]!;
}
async function work(): Promise<void> {}
work();
`;

const oxlint = join(root, "node_modules", ".bin", "oxlint");
const starts = spawnSync(oxlint, ["--version"], { encoding: "utf8" }).status === 0;

test.skipIf(!starts)("the lint reports each of its four rules on a fixture that breaks each", () => {
  const dir = mkdtempSync(join(tmpdir(), "oxlint-"));
  dirs.push(dir);
  mkdirSync(join(dir, "packages"));
  writeFileSync(join(dir, "packages", "broken.ts"), fixture);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "esnext", module: "esnext" },
      include: ["packages"],
    }),
  );
  const result = spawnSync(
    oxlint,
    ["-c", join(root, ".oxlintrc.json"), "--format", "unix", "packages"],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, OXLINT_TSGOLINT_PATH: join(root, "node_modules", ".bin", "tsgolint") },
    },
  );
  const out = `${result.stdout}${result.stderr}`;
  expect(result.status, out).toBe(1);
  for (const rule of ["no-explicit-any", "ban-ts-comment", "no-non-null-assertion", "no-floating-promises"]) {
    expect(out, out).toContain(`typescript(${rule})`);
  }
});
