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
