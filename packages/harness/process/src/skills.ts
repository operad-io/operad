/**
 * The skill directories a harness step is given. Both reference harnesses read
 * the same `SKILL.md` format (ADR 0011 D2), so they read the name here the same
 * way: a skill without a readable file or a name is skipped by both.
 *
 * A harness that cannot load skills itself gets a short list of them in its
 * prompt instead: name, description and the path of each `SKILL.md`, never its
 * body (ADR 0022 D9).
 */

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HarnessCapabilities } from "@operad-io/engine";

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

/** One field of a `SKILL.md` frontmatter, or undefined when it has none. */
function frontmatterValue(content: string, key: string): string | undefined {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const pattern = new RegExp(`^${key}\\s*:\\s*(.*)$`);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") return undefined;
    const match = pattern.exec(line);
    if (match === null) continue;
    let value = (match[1] ?? "").trim();
    const comment = value.search(/\s#/);
    if (comment !== -1) value = value.slice(0, comment).trimEnd();
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const entry = lines[next] ?? "";
        if (entry.trim() === "---") break;
        if (entry.trim().length === 0) {
          parts.push("");
          continue;
        }
        if (!/^\s/.test(entry)) break;
        parts.push(entry.trim());
      }
      const joined = value.startsWith(">") ? parts.join(" ") : parts.join("\n");
      const folded = joined.replace(/\s+/g, " ").trim();
      return folded.length === 0 ? undefined : folded;
    }
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

/** The `name` of a `SKILL.md`, or undefined when its frontmatter has none. */
export function skillName(content: string): string | undefined {
  return frontmatterValue(content, "name");
}

/** The `description` of a `SKILL.md`, or undefined when its frontmatter has none. */
export function skillDescription(content: string): string | undefined {
  return frontmatterValue(content, "description");
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

/** The most skills the prompt lists; any beyond it are counted, not listed. */
export const MAX_PROMPT_SKILLS = 20;

/** The most characters of a description the prompt carries, then `...`. */
export const MAX_PROMPT_DESCRIPTION_CHARS = 160;

/** A description on one line, cut at the cap. */
function promptDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  if (oneLine.length <= MAX_PROMPT_DESCRIPTION_CHARS) return oneLine;
  return `${oneLine.slice(0, MAX_PROMPT_DESCRIPTION_CHARS).trimEnd()}...`;
}

/**
 * The short skill list a harness that does not load skills itself gets in its
 * prompt: each readable skill's name, its description and the path of its
 * `SKILL.md`, and one sentence to read that file first. Empty when no skill can
 * be read; a skill whose `SKILL.md` cannot be read is left out.
 */
export function skillListText(paths: readonly string[]): string {
  const given = readGivenSkills(paths);
  const listed = given.skills.slice(0, MAX_PROMPT_SKILLS);
  if (listed.length === 0) return "";
  const lines = ["Read a skill's SKILL.md before doing what it describes."];
  for (const skill of listed) {
    const file = join(skill.path, "SKILL.md");
    let description: string | undefined;
    try {
      description = skillDescription(readFileSync(file, "utf8"));
    } catch {
      description = undefined;
    }
    const head = description === undefined ? skill.name : `${skill.name}: ${promptDescription(description)}`;
    lines.push(`- ${head} (SKILL.md at ${file})`);
  }
  const omitted = given.skills.length - listed.length;
  if (omitted > 0) {
    lines.push(`Only the first ${MAX_PROMPT_SKILLS} skills are listed; ${omitted} more are not.`);
  }
  return lines.join("\n");
}

/**
 * The prompt a harness step runs: the step's prompt, plus the skill list when
 * the harness does not declare that it loads skills itself. A harness that
 * declares `loadsSkills` never gets the list.
 */
export function promptWithSkills(
  prompt: string,
  paths: readonly string[],
  capabilities?: HarnessCapabilities,
): string {
  if (capabilities?.loadsSkills === true || paths.length === 0) return prompt;
  const list = skillListText(paths);
  return list.length === 0 ? prompt : `${prompt}\n\n${list}`;
}
