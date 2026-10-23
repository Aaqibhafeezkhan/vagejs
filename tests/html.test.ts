import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { html, raw } from "../src/core/html.js";
import { copyFixture, write } from "./helpers.js";

describe("html`` template", () => {
  it("escapes every value by default", () => {
    const title = `<script>alert("x")</script> & 'quotes'`;
    expect(String(html`<h1 title="${title}">${title}</h1>`)).toBe(
      "<h1 title=\"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;\">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;</h1>",
    );
  });

  it("keeps nested html and raw() as markup, joins arrays, drops null/undefined/false", () => {
    const items = ["a<b", "c"];
    const out = html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>${raw("<p>trusted</p>")}${null}${undefined}${false}${0}`;
    expect(String(out)).toBe("<ul><li>a&lt;b</li><li>c</li></ul><p>trusted</p>0");
  });

  it("can't be fooled by a look-alike object", () => {
    expect(String(html`${{ value: "<b>" } as unknown}`)).toBe("[object Object]");
  });

  it("works as a layout's return value", async () => {
    const root = copyFixture();
    write(
      root,
      "src/layouts/safe.ts",
      `import { html, raw } from ${JSON.stringify(path.resolve("src/core/html.ts"))};
export default ({ content, page }) => html\`<!doctype html><html lang="en"><head><title>\${page.title}</title></head><body><h2>\${page.frontmatter.tagline}</h2>\${raw(content)}</body></html>\`;`,
    );
    write(root, "src/pages/safe.md", `---\ntitle: Safe <b>page</b>\ndescription: Safe.\nlayout: safe\ntagline: "<img src=x onerror=alert(1)>"\n---\n# Hello\n`);
    await build(root);
    const out = fs.readFileSync(path.join(root, "dist/safe/index.html"), "utf8");
    expect(out).toContain("<title>Safe &lt;b&gt;page&lt;/b&gt;</title>");
    expect(out).toContain("<h2>&lt;img src=x onerror=alert(1)&gt;</h2>");
    expect(out).toContain("<h1>Hello</h1>");
  });
});
