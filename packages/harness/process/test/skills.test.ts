import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_PROMPT_DESCRIPTION_CHARS,
  MAX_PROMPT_SKILLS,
  promptWithSkills,
  readGivenSkills,
  skillDescription,
  skillName,
} from "../src/skills.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

async function skill(dir: string, name: string, description = "does the thing"): Promise<string> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nSay ${name}.\n`);
  return dir;
}

describe("skillName", () => {
  test("reads the name from the frontmatter, quoted or not", () => {
    expect(skillName("---\nname: one\ndescription: x\n---\n")).toBe("one");
    expect(skillName('---\nname: "two"\ndescription: x\n---\n')).toBe("two");
    expect(skillName("---\nname: three # comment\n---\n")).toBe("three");
  });

  test("a file without frontmatter or without a name has none", () => {
    expect(skillName("Say this.\n")).toBeUndefined();
    expect(skillName("---\ndescription: x\n---\n")).toBeUndefined();
  });
});

describe("skillDescription", () => {
  test("reads the description from the frontmatter, quoted or not", () => {
    expect(skillDescription("---\nname: one\ndescription: does the thing\n---\n")).toBe("does the thing");
    expect(skillDescription("---\nname: one\ndescription: 'does it'\n---\n")).toBe("does it");
    expect(skillDescription("---\nname: one\n---\n")).toBeUndefined();
    expect(skillDescription("---\nname: one\ndescription: >-\n  does the\n  thing\n---\n")).toBe("does the thing");
  });
});

describe("readGivenSkills", () => {
  test("keeps each readable skill directory and its name", async () => {
    const root = await tempRoot();
    const one = await skill(join(root, "one"), "one");
    const two = await skill(join(root, "two"), "two");
    const read = readGivenSkills([one, two]);
    expect(read.skills).toEqual([
      { path: one, name: "one" },
      { path: two, name: "two" },
    ]);
    expect(read.skipped).toEqual([]);
  });

  test("skips an unreadable SKILL.md, a missing name and an unsafe name, with a reason each", async () => {
    const root = await tempRoot();
    const missing = join(root, "missing");
    mkdirSync(missing);
    const unnamed = join(root, "unnamed");
    mkdirSync(unnamed);
    writeFileSync(join(unnamed, "SKILL.md"), "---\ndescription: x\n---\n");
    const unsafe = await skill(join(root, "unsafe"), "../escape");
    const read = readGivenSkills([missing, unnamed, unsafe]);
    expect(read.skills).toEqual([]);
    expect(read.skipped).toEqual([
      { path: missing, reason: "SKILL.md cannot be read" },
      { path: unnamed, reason: "SKILL.md has no name" },
      { path: unsafe, reason: 'the name "../escape" is not a skill name' },
    ]);
  });

  test("a second directory with the same name is skipped", async () => {
    const root = await tempRoot();
    const one = await skill(join(root, "one"), "same");
    const two = await skill(join(root, "two"), "same");
    expect(readGivenSkills([one, two])).toEqual({
      skills: [{ path: one, name: "same" }],
      skipped: [{ path: two, reason: 'the name "same" is already given' }],
    });
  });
});

describe("promptWithSkills", () => {
  test("lists two skills with their description and the path of each SKILL.md", async () => {
    const root = await tempRoot();
    const one = await skill(join(root, "one"), "one", "does one thing");
    const two = await skill(join(root, "two"), "two", "does two things");
    expect(promptWithSkills("Do the work.", [one, two])).toBe(
      [
        "Do the work.",
        "",
        "Read a skill's SKILL.md before doing what it describes.",
        `- one: does one thing (SKILL.md at ${join(one, "SKILL.md")})`,
        `- two: does two things (SKILL.md at ${join(two, "SKILL.md")})`,
      ].join("\n"),
    );
  });

  test("a harness that loads skills itself gets no list", async () => {
    const root = await tempRoot();
    const one = await skill(join(root, "one"), "one");
    expect(promptWithSkills("Do the work.", [one], { loadsSkills: true })).toBe("Do the work.");
    expect(promptWithSkills("Do the work.", [one], { loadsSkills: false })).toContain("- one: does the thing");
  });

  test("the list stops at the skill cap and says how many are left out", async () => {
    const root = await tempRoot();
    const paths: string[] = [];
    for (let index = 0; index < MAX_PROMPT_SKILLS + 2; index += 1) {
      paths.push(await skill(join(root, `skill-${index}`), `skill-${index}`, `thing ${index}`));
    }
    const text = promptWithSkills("Do the work.", paths);
    const listed = text.split("\n").filter((line) => line.startsWith("- "));
    expect(listed).toHaveLength(MAX_PROMPT_SKILLS);
    expect(listed[0]).toContain("skill-0:");
    expect(text).not.toContain("skill-20");
    expect(text).toContain(`Only the first ${MAX_PROMPT_SKILLS} skills are listed; 2 more are not.`);
  });

  test("a long description is cut at the description cap", async () => {
    const root = await tempRoot();
    const long = "x".repeat(MAX_PROMPT_DESCRIPTION_CHARS + 50);
    const one = await skill(join(root, "one"), "one", long);
    const text = promptWithSkills("Do the work.", [one]);
    expect(text).toContain(
      `- one: ${long.slice(0, MAX_PROMPT_DESCRIPTION_CHARS)}... (SKILL.md at ${join(one, "SKILL.md")})`,
    );
    expect(text).not.toContain(long.slice(0, MAX_PROMPT_DESCRIPTION_CHARS + 1));
  });

  test("a skill whose SKILL.md cannot be read is left out", async () => {
    const root = await tempRoot();
    const good = await skill(join(root, "good"), "good", "does the thing");
    const missing = join(root, "missing");
    mkdirSync(missing);
    const text = promptWithSkills("Do the work.", [missing, good]);
    expect(text).toContain(`- good: does the thing (SKILL.md at ${join(good, "SKILL.md")})`);
    expect(text).not.toContain(missing);
  });
});
