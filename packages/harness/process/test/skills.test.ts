import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readGivenSkills, skillName } from "../src/skills.ts";
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
