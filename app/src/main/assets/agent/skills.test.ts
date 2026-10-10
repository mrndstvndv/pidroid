import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverSkills, expandSkillCommand } from "./skills.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pidroid-skills-"));
  roots.push(root);
  return root;
}

function writeSkill(root: string, relativePath: string, content: string): string {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("discoverSkills", () => {
  test("finds a skill folder with name and description", () => {
    const root = makeRoot();
    const file = writeSkill(root, "my-skill/SKILL.md", skillMd("my-skill", "Does useful things"));

    expect(discoverSkills(root)).toEqual([
      { name: "my-skill", description: "Does useful things", location: file },
    ]);
  });

  test("finds a nested skill below plain grouping folders", () => {
    const root = makeRoot();
    const file = writeSkill(root, "group/inner/SKILL.md", skillMd("inner", "Nested skill"));

    const skills = discoverSkills(root);
    expect(skills.map((s) => s.name)).toEqual(["inner"]);
    expect(skills[0].location).toBe(file);
  });

  test("ignores a SKILL.md at the root and still finds the other skills", () => {
    const root = makeRoot();
    writeSkill(root, "SKILL.md", skillMd("root-skill", "Should be ignored"));
    writeSkill(root, "my-skill/SKILL.md", skillMd("my-skill", "Still visible"));

    expect(discoverSkills(root).map((s) => s.name)).toEqual(["my-skill"]);
  });

  test("skips a SKILL.md without frontmatter or without a description", () => {
    const root = makeRoot();
    writeSkill(root, "plain/SKILL.md", "Just text, no frontmatter.\n");
    writeSkill(root, "nodesc/SKILL.md", "---\nname: nodesc\n---\n\nbody\n");
    writeSkill(root, "good/SKILL.md", skillMd("good", "Valid"));

    expect(discoverSkills(root).map((s) => s.name)).toEqual(["good"]);
  });

  test("keeps the first skill when two folders declare the same name", () => {
    const root = makeRoot();
    writeSkill(root, "a-first/SKILL.md", skillMd("dupe", "first"));
    writeSkill(root, "b-second/SKILL.md", skillMd("dupe", "second"));

    const skills = discoverSkills(root);
    expect(skills.length).toBe(1);
    expect(skills[0].description).toBe("first");
  });

  test("does not treat files under a skill's own folder as separate skills", () => {
    const root = makeRoot();
    writeSkill(root, "outer/SKILL.md", skillMd("outer", "Owns its folder"));
    writeSkill(root, "outer/sub/SKILL.md", skillMd("sub", "Bundled resource"));

    expect(discoverSkills(root).map((s) => s.name)).toEqual(["outer"]);
  });

  test("returns the new description after a SKILL.md is edited", () => {
    const root = makeRoot();
    const file = writeSkill(root, "cached/SKILL.md", skillMd("cached", "old description"));
    expect(discoverSkills(root)[0].description).toBe("old description");

    writeFileSync(file, skillMd("cached", "new description"));
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);

    expect(discoverSkills(root)[0].description).toBe("new description");
  });

  test("expands /skill:name like pi-coding-agent, strips frontmatter and appends the request", () => {
    const root = makeRoot();
    const file = writeSkill(root, "writer/SKILL.md", `---\nname: writer\ndescription: Writes well\n---\n\n# Writer\n\nFollow the style guide.\n`);
    const expanded = expandSkillCommand("/skill:writer Draft a short note", root);

    expect(expanded.error).toBeUndefined();
    expect(expanded.skill?.name).toBe("writer");
    expect(expanded.content).toBe(
      `<skill name="writer" location="${realpathSync(file)}">\nReferences are relative to ${dirname(realpathSync(file))}.\n\n# Writer\n\nFollow the style guide.\n</skill>\n\nDraft a short note`,
    );
  });

  test("leaves regular messages alone and reports an unknown explicit skill", () => {
    const root = makeRoot();
    expect(expandSkillCommand("just a regular message", root)).toEqual({ content: "just a regular message" });
    const unknown = expandSkillCommand("/skill:missing do something", root);
    expect(unknown.content).toBe("/skill:missing do something");
    expect(unknown.error).toContain("Skill 'missing' was not found");
  });
});
