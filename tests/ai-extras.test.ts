import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { copyFixture, write } from "./helpers.js";

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");
const git = (cwd: string, args: string[], date?: string) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }, stdio: "ignore" });

describe("Markdown copies", () => {
  it("publishes listed pages as .md, linked from the page", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", seo: { markdownCopies: true } };');
    await build(root);
    const about = read(root, "about.md");
    expect(about.startsWith("# About")).toBe(true);
    expect(read(root, "index.md")).toContain("# Home");
    expect(read(root, "about/index.html")).toContain('<link rel="alternate" type="text/markdown" href="/about.md" />');
    expect(fs.existsSync(path.join(root, "dist/hidden.md"))).toBe(false); // noindex page
    expect(fs.existsSync(path.join(root, "dist/blog/wip.md"))).toBe(false); // draft
  });

  it("is off by default", async () => {
    const root = copyFixture();
    await build(root);
    expect(fs.existsSync(path.join(root, "dist/about.md"))).toBe(false);
    expect(read(root, "about/index.html")).not.toContain("text/markdown");
  });
});

describe("sitemap lastmod from git", () => {
  function repo() {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", seo: { lastmod: "git" } };');
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "one"], "2026-01-02T03:04:05Z");
    write(root, "src/pages/about.md", fs.readFileSync(path.join(root, "src/pages/about.md"), "utf8") + "\nMore.\n");
    git(root, ["commit", "-qam", "two"], "2026-02-03T04:05:06Z");
    return root;
  }

  it("uses each page's last commit, with dateModified still winning", async () => {
    const root = repo();
    await build(root);
    const xml = read(root, "sitemap.xml");
    expect(xml).toMatch(/fixture\.example\/about\/<\/loc>\s*<lastmod>2026-02-03T04:05:06Z<\/lastmod>/);
    expect(xml).toMatch(/fixture\.example\/<\/loc>\s*<lastmod>2026-01-02T03:04:05Z<\/lastmod>/);
    expect(xml).toMatch(/blog\/post\/<\/loc>\s*<lastmod>2026-02-01<\/lastmod>/); // its dateModified
  });

  it("refuses shallow clones and non-repositories with a warning", async () => {
    const source = repo();
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "vage-shallow-"));
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${source}`, shallow], { stdio: "ignore" });
    const a = await build(shallow);
    expect(a.warnings.join()).toMatch(/shallow git clone/);
    expect(read(shallow, "sitemap.xml")).not.toContain("2026-02-03T04:05:06Z");

    const plain = copyFixture();
    write(plain, "vage.config.ts", 'export default { site: "https://fixture.example", seo: { lastmod: "git" } };');
    expect((await build(plain)).warnings.join()).toMatch(/isn't a git repository|git isn't available/);
  });
});
