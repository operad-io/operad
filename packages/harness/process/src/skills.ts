/**
 * The skill directories a harness step is given. Both reference harnesses read
 * the same `SKILL.md` format (ADR 0011 D2), so they read the name here the same
 * way: a skill without a readable file or a name is skipped by both.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** One skill directory that may be given to an agent. */
export interface GivenSkill {
  /** The absolute directory with the `SKILL.md`. */
  readonly path: string;
  /** The skill's name, from the file's frontmatter. */
  readonly name: string;
}

/** A given directory that is not a skill, and why. */
export interface SkippedSkill {
  readonly path: string;
  readonly reason: string;
}

export interface GivenSkills {
  readonly skills: readonly GivenSkill[];
  readonly skipped: readonly SkippedSkill[];
}

/** A name the Agent Skills format allows and a file name can hold. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The `name` of a `SKILL.md`, or undefined when its frontmatter has none. */
export function skillName(content: string): string | undefined {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") return undefined;
    const match = /^name\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = (match[1] ?? "").trim();
    const comment = value.search(/\s#/);
    if (comment !== -1) value = value.slice(0, comment).trimEnd();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value.length === 0 ? undefined : value;
  }
  return undefined;
}

/** Reads the directories the step gave: the skills that can be loaded, and the ones it skips. */
export function readGivenSkills(paths: readonly string[]): GivenSkills {
  const skills: GivenSkill[] = [];
  const skipped: SkippedSkill[] = [];
  const names = new Set<string>();
  for (const path of paths) {
    let directory = path;
    let file = join(path, "SKILL.md");
    try {
      if (statSync(path).isFile()) {
        if (basename(path) !== "SKILL.md") {
          skipped.push({ path, reason: "the given path is not a skill directory" });
          continue;
        }
        directory = dirname(path);
        file = path;
      }
    } catch {
      skipped.push({ path, reason: "SKILL.md cannot be read" });
      continue;
    }
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      skipped.push({ path, reason: "SKILL.md cannot be read" });
      continue;
    }
    const name = skillName(content);
    if (name === undefined) {
      skipped.push({ path, reason: "SKILL.md has no name" });
      continue;
    }
    if (!SKILL_NAME.test(name) || name.length > 64) {
      skipped.push({ path, reason: `the name "${name}" is not a skill name` });
      continue;
    }
    if (names.has(name)) {
      skipped.push({ path, reason: `the name "${name}" is already given` });
      continue;
    }
    names.add(name);
    skills.push({ path: directory, name });
  }
  return { skills, skipped };
}
