import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { check, emptyValues } from "../src/checks/check.js";
import { copyFixture, write } from "./helpers.js";

const ZOD = JSON.stringify(path.resolve("node_modules/zod/index.js"));
const ESCAPE = JSON.stringify(path.resolve("src/core/html.ts"));

describe("empty frontmatter values", () => {
  it("finds nulls at any depth", () => {
    expect(emptyValues({ a: 1, b: null, c: [{ d: null }, { e: "x" }], f: { g: null } })).toEqual(["b", "c[0].d", "f.g"]);
  });

  it("warns when a comma inside { } splits a value", async () => {
    const root = copyFixture();
    write(root, "src/pages/faq.md", `---\ntitle: FAQ\ndescription: Questions.\nfaq:\n  - { q: Does it work with ChatGPT, Claude and others?, a: Yes. }\n---\n# FAQ\n`);
    const result = await check(root);
    const hit = result.findings.find((f) => f.rule === "frontmatter-empty");
    expect(hit?.source).toBe(path.join("src", "pages", "faq.md"));
    expect(hit?.message).toContain('"faq[0].Claude and others?"');
  });
});

describe("layout field schemas", () => {
  const layout = `import { z } from ${ZOD};
import { escapeHtml } from ${ESCAPE};
export const frontmatter = z.object({ accent: z.string().optional(), cta: z.boolean().default(true) });
export default ({ content, page }) => \`<!doctype html><html lang="en"><head><title>\${escapeHtml(page.title)}</title></head><body data-cta="\${page.frontmatter.cta}">\${content}</body></html>\`;`;

  it("fills in defaults for the layout's fields", async () => {
    const root = copyFixture();
    write(root, "src/layouts/landing.ts", layout);
    write(root, "src/pages/landing.md", `---\ntitle: Landing\ndescription: A landing page.\nlayout: landing\naccent: Hello\n---\n# Landing\n`);
    await build(root);
    expect(fs.readFileSync(path.join(root, "dist/landing/index.html"), "utf8")).toContain('data-cta="true"');
  });

  it("rejects a misspelled field and names the file", async () => {
    const root = copyFixture();
    write(root, "src/layouts/landing.ts", layout);
    write(root, "src/pages/landing.md", `---\ntitle: Landing\ndescription: A landing page.\nlayout: landing\naccnet: Hello\n---\n# Landing\n`);
    await expect(build(root)).rejects.toThrow(/landing" layout's fields[\s\S]*accnet/);
  });

  it("rejects a wrong type", async () => {
    const root = copyFixture();
    write(root, "src/layouts/landing.ts", layout);
    write(root, "src/pages/landing.md", `---\ntitle: Landing\ndescription: A landing page.\nlayout: landing\ncta: "no"\n---\n# Landing\n`);
    await expect(build(root)).rejects.toThrow(/cta/);
  });

  it("leaves pages alone when the layout declares no schema", async () => {
    const root = copyFixture();
    write(root, "src/pages/free.md", `---\ntitle: Free\ndescription: Any fields.\nlayout: plain\nwhatever: 1\n---\n# Free\n`);
    await expect(build(root)).resolves.toBeDefined();
  });
});

describe("layout fields everywhere (review findings)", () => {
  const COLLECTION = JSON.stringify(path.resolve("src/core/pages.ts"));
  const postLayout = `import { z } from ${ZOD};
export const frontmatter = z.object({ featured: z.boolean().default(false), author: z.string() });
export default ({ content, page }) => \`<!doctype html><html lang="en"><head><title>\${page.title}</title></head><body>\${content}</body></html>\`;`;
  const indexLayout = `import { collection } from ${COLLECTION};
export default ({ content, page, pages }) => \`<!doctype html><html lang="en"><head><title>\${page.title}</title></head><body>\${content}<ul>\${collection(pages, { under: "/blog/" }).map((p) => \`<li>\${p.route}:\${p.frontmatter.featured}</li>\`).join("")}</ul></body></html>\`;`;

  function site() {
    const root = copyFixture();
    write(root, "src/layouts/post.ts", postLayout);
    write(root, "src/layouts/list.ts", indexLayout);
    const index = path.join(root, "src/pages/blog/index.md");
    fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("layout: plain", "layout: list"));
    const post = path.join(root, "src/pages/blog/post.md");
    fs.writeFileSync(post, fs.readFileSync(post, "utf8").replace("---\ntitle: Post", "---\nlayout: post\ntitle: Post"));
    return root;
  }

  it("gives list entries the layout's defaults, and lets a schema require a built-in field", async () => {
    const root = site();
    await build(root);
    expect(fs.readFileSync(path.join(root, "dist/blog/index.html"), "utf8")).toContain("<li>/blog/post/:false</li>");
  });

  it("fails when a schema-required built-in field is missing", async () => {
    const root = site();
    const post = path.join(root, "src/pages/blog/post.md");
    fs.writeFileSync(post, fs.readFileSync(post, "utf8").replace(/^author: .*\n/m, ""));
    await expect(build(root)).rejects.toThrow(/author/);
  });

  it("skips drafts entirely, even with fields their layout doesn't allow", async () => {
    const root = site();
    write(root, "src/pages/blog/later.md", "---\ntitle: Later\ndescription: Soon.\nlayout: post\ndraft: true\ntagz: oops\n---\n# Later\n");
    const result = await build(root);
    expect(result.skippedDrafts).toContain(path.join("src", "pages", "blog", "later.md"));
  });

  it("reports a page that fails to render as a check finding and keeps checking", async () => {
    const root = site();
    write(root, "src/pages/blog/typo.md", "---\ntitle: Typo\ndescription: Typo.\nlayout: post\nauthor: A\nfeaturd: true\n---\n# Typo\n");
    const result = await check(root);
    const hit = result.findings.find((f) => f.rule === "page-error");
    expect(hit).toMatchObject({ severity: "error", source: path.join("src", "pages", "blog", "typo.md") });
    expect(hit!.message).toMatch(/featurd/);
    expect(hit!.message).not.toContain(root);
    expect(result.pagesChecked).toBeGreaterThan(2);
    await expect(build(root)).rejects.toThrow(/featurd/);
  });

  it("hands layouts a frozen list, so one layout can't change what others see", async () => {
    const root = copyFixture();
    write(root, "src/layouts/bad.ts", `export default ({ pages }) => { pages.reverse(); return "<html lang=en><head><title>x</title></head></html>"; };`);
    write(root, "src/pages/bad.md", "---\ntitle: Bad\ndescription: Bad.\nlayout: bad\n---\n# Bad\n");
    await expect(build(root)).rejects.toThrow(/read only|frozen|Cannot assign/i);
  });
});
