/**
 * The skills a chat can use: the ones its settings give it, read from their
 * `SKILL.md` files the same way a harness reads them. A skill can be typed as
 * `/name`; an operad command of the same name wins, and a harness that does not
 * load skills itself gets the skill's body in the message instead.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseObjectId, type StoredObject, type ViewSkill } from "@operad-io/engine";
import {
  MAX_PROMPT_DESCRIPTION_CHARS,
  readGivenSkills,
  skillDescription,
} from "@operad-io/harness-process";
import { parseCommand } from "./command.ts";
import type { ChatData } from "./model.ts";

/** One skill of a chat, with the path of its `SKILL.md`. */
export interface ChatSkill {
  readonly name: string;
  /** The description from its `SKILL.md`, on one line and cut to the menu cap. */
  readonly description?: string | undefined;
  /** The directory that holds the `SKILL.md`. */
  readonly path: string;
}

/** Reads an object as a view does, through its type's `prepare` when it has one. */
export type ObjectReader = (type: string, id: string) => Promise<StoredObject | undefined>;

/** The description on one line, cut at the same cap the harness prompt uses. */
function shortDescription(description: string): string | undefined {
  const oneLine = description.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  if (oneLine.length <= MAX_PROMPT_DESCRIPTION_CHARS) return oneLine;
  return `${oneLine.slice(0, MAX_PROMPT_DESCRIPTION_CHARS).trimEnd()}...`;
}

/** A skill file's body after its frontmatter, or the whole text when it has none. */
function bodyOf(content: string): string | undefined {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    const body = text.trim();
    return body.length === 0 ? undefined : body;
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "---") continue;
    const body = lines.slice(index + 1).join("\n").trim();
    return body.length === 0 ? undefined : body;
  }
  return undefined;
}

/** The skill directories a chat is given: its parent's when it names some, else its own. */
export async function chatSkillPaths(
  chat: ChatData,
  get: ObjectReader,
): Promise<readonly string[]> {
  const parent = chat.parent;
  if (parent !== undefined) {
    const ref = parseObjectId(parent);
    if (ref !== undefined) {
      const owner = await get(ref.type, ref.id);
      const skills = owner?.data.skills;
      if (Array.isArray(skills)) {
        return skills.filter((path): path is string => typeof path === "string");
      }
    }
  }
  return chat.skills;
}

/** Reads the skills directly from the directories a chat is given. */
export function readSkills(paths: readonly string[]): readonly ChatSkill[] {
  return readGivenSkills(paths).skills.map((skill) => {
    let description: string | undefined;
    try {
      const content = readFileSync(join(skill.path, "SKILL.md"), "utf8");
      const found = skillDescription(content);
      description = found === undefined ? undefined : shortDescription(found);
    } catch {
      description = undefined;
    }
    return {
      name: skill.name,
      ...(description === undefined ? {} : { description }),
      path: skill.path,
    };
  });
}

/** The skills a chat can use now, with its parent's current list when it has one. */
export async function readChatSkills(
  chat: ChatData,
  get: ObjectReader,
): Promise<readonly ChatSkill[]> {
  return readSkills(await chatSkillPaths(chat, get));
}

/** The skills as a view carries them: names and descriptions, never file paths. */
export function skillSummaries(skills: readonly ChatSkill[]): readonly ViewSkill[] {
  return skills.map((skill) => ({
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
  }));
}

/** The body of one skill, read from its `SKILL.md`. */
export function readSkillBody(skill: ChatSkill): string | undefined {
  try {
    return bodyOf(readFileSync(join(skill.path, "SKILL.md"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The message a harness receives for `/name rest`: unchanged for a harness that
 * loads skills itself, and otherwise the skill's body after a line naming it,
 * then the rest of the line. An unknown name stays an ordinary message.
 */
export function skillMessage(
  text: string,
  skills: readonly ChatSkill[],
  loadsSkills: boolean,
): string {
  if (loadsSkills) return text;
  const parsed = parseCommand(text);
  if (parsed === undefined) return text;
  const skill = skills.find((item) => item.name === parsed.name);
  if (skill === undefined) return text;
  const body = readSkillBody(skill);
  const rest = parsed.rest.trim();
  return [
    `The skill "${skill.name}" follows.`,
    ...(body === undefined ? [] : [body]),
    ...(rest.length === 0 ? [] : [rest]),
  ].join("\n\n");
}
