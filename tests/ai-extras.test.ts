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

describe("Markdown copies are safe to publish (review findings)", () => {
  const BODY = [
    "# My notes",
    "",
    "Hello <span>inline</span> world. <!-- INTERNAL: client pays 42k -->",
    "",
    "<!-- private block note -->",
    "",
    '<script src="https://evil.example/x.js"></script>',
    "",
    '<iframe src="https://casino-spam.example/"></iframe>',
    "",
    "- item one",
    "  <!--",
    "  SECRET-IN-LIST",
    "  -->",
    "",
    "> quoted",
    "> <!-- SECRET-IN-QUOTE -->",
    "",
    "Use `<script>` here, then <script>SECRET_SCRIPT()</script> end.",
    "",
    "See [about](../about/), ![pic](img/a.png), [ext](https://example.org/x), [ref][d] and [angle](<other page/>).",
    "",
    "[d]: ../ref-target/",
    "[unused]: https://unused-spam.example/",
    "",
    "```html",
    "<script>console.log('code sample')</script>",
    "```",
    "",
  ].join("\n");

  function site(extra = "") {
    const root = copyFixture();
    write(root, "vage.config.ts", `export default { site: "https://fixture.example", title: "Fixture Site", seo: { markdownCopies: true, llmsTxt: { full: true } }${extra} };`);
    write(root, "src/pages/docs/notes.md", `---\ntitle: Notes page\ndescription: Notes.\n---\n${BODY}`);
    return root;
  }

  it("contain only what the page shows: no comments, raw HTML or unused links; absolute links; code kept", async () => {
    const root = site();
    await build(root);
    for (const file of ["docs/notes.md", "llms-full.txt"]) {
      const text = read(root, file);
      expect(text, file).not.toMatch(/INTERNAL|private block note|evil\.example|casino-spam|SECRET|unused-spam|<span>|<iframe/);
      expect(text, file).toContain("<script>console.log('code sample')</script>"); // a code block, shown as code on the page
      expect(text, file).toContain("`<script>`");
      expect(text, file).toContain("[about](https://fixture.example/docs/about/)");
      expect(text, file).toContain("![pic](https://fixture.example/docs/notes/img/a.png)");
      expect(text, file).toContain("[ext](https://example.org/x)");
      expect(text, file).toContain("[ref](https://fixture.example/docs/ref-target/)");
      expect(text, file).toContain("https://fixture.example/docs/notes/other%20page/");
      expect(text, file).toContain("inline world.");
    }
    expect(read(root, "docs/notes.md").startsWith("# My notes\n\n> Notes.")).toBe(true);
    expect(read(root, "llms.txt")).toContain("(https://fixture.example/docs/notes.md)");
  });

  it("strip scripts and comments even when every author is trusted", async () => {
    const root = site(', markdown: { html: "allow" }');
    await build(root);
    expect(read(root, "docs/notes.md")).not.toMatch(/INTERNAL|SECRET|evil\.example/);
  });

  it("keep tables as Markdown tables", async () => {
    const root = site();
    write(root, "src/pages/docs/table.md", "---\ntitle: Table\ndescription: Table.\n---\n# Table\n\n| A | B |\n| --- | --- |\n| 1 | x \\| y |\n");
    await build(root);
    expect(read(root, "docs/table.md")).toContain("| A | B |\n| --- | --- |\n| 1 | x \\| y |");
  });

  it("refuses two pages that would produce the same copy", async () => {
    const root = site();
    write(root, "src/pages/index/index.md", "---\ntitle: Index dir\ndescription: Clash.\n---\n# Clash\n");
    await expect(build(root)).rejects.toThrow(/Two generated files would be written to index\.md/);
  });
});

describe("git dates review fixes", () => {
  it("dates pages with non-ASCII file names, and names the real problem outside a repository", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", seo: { lastmod: "git" } };');
    write(root, "src/pages/café.md", "---\ntitle: Café\ndescription: Coffee.\n---\n# Café\n");
    write(root, "src/pages/my page.md", "---\ntitle: Spaced\ndescription: Spaces.\n---\n# Spaced\n");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "one"], "2026-03-04T05:06:07Z");
    await build(root);
    expect(read(root, "sitemap.xml")).toMatch(/caf%C3%A9\/<\/loc>\s*<lastmod>2026-03-04T05:06:07Z<\/lastmod>/i);
    expect(read(root, "sitemap.xml")).toMatch(/my%20page\/<\/loc>\s*<lastmod>2026-03-04T05:06:07Z<\/lastmod>/i);

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "vage-nogit-"));
    fs.cpSync(copyFixture(), plain, { recursive: true });
    write(plain, "vage.config.ts", 'export default { site: "https://fixture.example", seo: { lastmod: "git" } };');
    expect((await build(plain)).warnings.join()).toMatch(/isn't a git repository/);
  });

  it("generated GitHub workflows fetch full history", async () => {
    const { pagesWorkflow } = await import("../src/deploy/github-pages.js");
    expect(pagesWorkflow("main")).toContain("fetch-depth: 0");
    expect(fs.readFileSync(path.resolve("templates/starter/.github/workflows/ci.yml"), "utf8")).toContain("fetch-depth: 0");
  });
});

describe("Markdown copies, final review", () => {
  async function copyOf(body: string, extra = "") {
    const root = copyFixture();
    write(root, "vage.config.ts", `export default { site: "https://fixture.example", title: "Fixture Site", seo: { markdownCopies: true, llmsTxt: { full: true } }${extra} };`);
    write(root, "src/pages/p.md", `---\ntitle: P\ndescription: P.\n---\n# P\n\n${body}\n`);
    await build(root);
    return read(root, "p.md");
  }

  it("converts nested tables without crashing", async () => {
    const text = await copyOf("<table><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table>");
    expect(text).toContain("outer");
    expect(text).toContain("inner");
  });

  it("leaves out hidden, SVG and empty links, script URLs, and escapes < in text", async () => {
    const text = await copyOf(
      '<div hidden>SECRET15 <a href="https://secret15.test">hiddenlink</a></div>\n\n<svg><desc>SECRET12</desc><title>SECRET13</title></svg>\n\n<a href="https://secret24.test"></a>\n\nText &lt;script&gt;alert(1)&lt;/script&gt; end.',
    );
    expect(text).not.toMatch(/SECRET1[235]|secret15\.test|secret24\.test/);
    expect(text).not.toMatch(/(^|[^\\])<script>/);
    const trusted = await copyOf('<a href="javascript:alert(1)">click</a> <span style="display:none">x</span>', ', markdown: { html: "allow" }');
    expect(trusted).not.toContain("javascript:");
  });

  it("keeps <pre> and strikethrough; task lists match the page", async () => {
    const text = await copyOf("<pre>line one\n  line two</pre>\n\n~~not this~~ but this\n\n- [x] done\n- [ ] todo");
    expect(text).toContain("```\nline one\n  line two\n```");
    expect(text).toContain("~~not this~~");
    // The sanitizer removes <input>, so the page shows no checkboxes; neither does the copy.
    expect(text).toMatch(/-\s+done/);
  });
});

describe("Markdown copies, focused check", () => {
  it("keeps backticks inside <pre> from closing the fence", async () => {
    const { htmlToMarkdown } = await import("../src/discovery/markdown-copy.js");
    const { Marked } = await import("marked");
    const md = await htmlToMarkdown("<pre>```\n&lt;img src=x onerror=alert(1)&gt;</pre><ul><li><pre><span>```</span>\n&lt;img src=y onerror=alert(2)&gt;</pre></li></ul>", { route: "/p/" });
    expect(new Marked().parse(md, { async: false }) as string).not.toMatch(/<img/);
  });

  it("converts deep nested tables quickly and skips empty rows and script-URL images", async () => {
    const { htmlToMarkdown } = await import("../src/discovery/markdown-copy.js");
    let nested = "x";
    for (let i = 0; i < 30; i++) nested = `<table><tr><td>${nested}</td></tr></table>`;
    const start = performance.now();
    await htmlToMarkdown(nested, { route: "/p/" });
    expect(performance.now() - start).toBeLessThan(2000);
    expect(await htmlToMarkdown("<table><tr></tr><tr><th>A</th></tr><tr><td>1</td></tr></table>", { route: "/p/" })).toBe("| A |\n| --- |\n| 1 |");
    expect(await htmlToMarkdown('<p><img src="javascript:alert(1)" alt="x"> ok</p>', { route: "/p/" })).toBe("ok");
  });
});
