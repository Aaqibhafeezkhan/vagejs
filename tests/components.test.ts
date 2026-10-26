import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { createPage } from "../src/cli/new.js";
import { copyFixture, write } from "./helpers.js";

/** The fixture with this repo's node_modules, so react, vue, @vitejs/plugin-vue and @mdx-js/mdx resolve from the site. */
function siteWithPackages(): string {
  const root = copyFixture();
  fs.symlinkSync(path.join(import.meta.dirname, "..", "node_modules"), path.join(root, "node_modules"), "junction");
  return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");

const REACT_LAYOUT = `import type { LayoutProps } from "vagejs";
export default function Layout({ content, page }: LayoutProps) {
  return (
    <html lang={page.lang}>
      <head><title>{page.title + " <react>"}</title></head>
      <body><main data-layout="react" dangerouslySetInnerHTML={{ __html: content }} /></body>
    </html>
  );
}
`;

describe("React, Vue and MDX (rendered at build time)", () => {
  it("renders a React layout to static HTML with the usual head tags", async () => {
    const root = siteWithPackages();
    write(root, "src/layouts/default.tsx", REACT_LAYOUT);
    await build(root);
    const html = read(root, "about/index.html");
    expect(html.startsWith("<!doctype html>\n<html lang=\"en-GB\">")).toBe(true);
    expect(html).toContain("<title>About &lt;react&gt;</title>");
    expect(html).toMatch(/<main data-layout="react"><h1[^>]*>About<\/h1>/);
    expect(html).toContain('<link rel="canonical" href="https://fixture.example/about/" />');
    expect(html).not.toContain("<script src");
  });

  it("renders a Vue layout, dropping props it doesn't declare", async () => {
    const root = siteWithPackages();
    write(
      root,
      "src/layouts/default.vue",
      `<script setup lang="ts">
defineProps<{ content: string; page: { title: string; lang: string } }>();
</script>
<template>
  <html :lang="page.lang">
    <head><title>{{ page.title }} (vue)</title></head>
    <body><main data-layout="vue" v-html="content"></main></body>
  </html>
</template>
`,
    );
    await build(root);
    const html = read(root, "about/index.html");
    expect(html).toContain("<title>About (vue)</title>");
    expect(html).toMatch(/<main data-layout="vue"><h1[^>]*>About<\/h1>/);
    expect(html).not.toMatch(/ site=| menus=| pages=|<!--\[-->/);
  });

  it("builds .mdx pages with imported components", async () => {
    const root = siteWithPackages();
    write(root, "src/components/Card.tsx", "export default function Card({ plan }: { plan: string }) {\n  return <div className=\"card\">{plan} plan</div>;\n}\n");
    write(
      root,
      "src/pages/pricing.mdx",
      `---
title: Pricing
description: Plans and prices.
---
import Card from "../components/Card.tsx";

# Pricing

Our plans, from **{1 + 1}** options:

<Card plan="Team" />

[About us](/about/)
`,
    );
    const result = await build(root);
    expect(result.pages).toContainEqual({ route: "/pricing/", source: "src/pages/pricing.mdx", output: "pricing/index.html" });
    const html = read(root, "pricing/index.html");
    expect(html).toContain("<title>Pricing | Fixture Site</title>");
    expect(html).toContain('<meta name="description" content="Plans and prices." />');
    expect(html).toContain("<strong>2</strong>");
    expect(html).toContain('<div class="card">Team plan</div>');
    expect(html).not.toContain("title: Pricing");
    expect(read(root, "sitemap.xml")).toContain("https://fixture.example/pricing/");
  });

  it("checks .mdx pages like any other page", async () => {
    const root = siteWithPackages();
    write(root, "src/pages/pricing.mdx", "---\ntitle: Pricing\ndescription: Plans and prices.\n---\n\n# Pricing\n\n[Gone](/nowhere/)\n");
    const result = await check(root);
    expect(result.findings).toContainEqual(expect.objectContaining({ source: "src/pages/pricing.mdx", severity: "error", message: expect.stringContaining("/nowhere/") }));
  });

  it("refuses two layouts with the same name", async () => {
    const root = siteWithPackages();
    write(root, "src/layouts/default.ts", "export default ({ content }) => `<html><head><title>t</title></head><body>${content}</body></html>`;\n");
    write(root, "src/layouts/default.tsx", REACT_LAYOUT);
    await expect(build(root)).rejects.toThrow(/More than one layout is named "default": src\/layouts\/default\.ts, src\/layouts\/default\.tsx/);
  });

  it("uses 404.mdx as the 404 page", async () => {
    const root = siteWithPackages();
    fs.rmSync(path.join(root, "src/pages/404.md"));
    write(root, "src/pages/404.mdx", "---\ntitle: Not found\n---\n\n# Not found {2 + 2}\n");
    const result = await build(root);
    expect(result.pages.some((p) => p.route === "/404/")).toBe(false);
    expect(read(root, "404.html")).toContain("Not found 4");
    write(root, "src/pages/404.md", "---\ntitle: Not found\n---\n# Not found\n");
    await expect(build(root)).rejects.toThrow(/Both 404\.md and 404\.mdx/);
  });

  it("vage new doesn't create a page an .mdx page already has", () => {
    const root = copyFixture();
    write(root, "src/pages/pricing.mdx", "---\ntitle: Pricing\n---\n# Pricing\n");
    expect(() => createPage(root, "page", "pricing")).toThrow(/pricing\.mdx already exists/);
  });

  it("names the package to install when one is missing", async () => {
    const root = copyFixture();
    write(root, "src/pages/pricing.mdx", "---\ntitle: Pricing\n---\n\n# Pricing\n");
    await expect(build(root)).rejects.toThrow(/needs the "@mdx-js\/mdx" package\. Install it with: npm install react react-dom && npm install --save-dev @mdx-js\/mdx/);

    const vue = copyFixture();
    write(vue, "src/layouts/default.vue", "<template><html><head><title>x</title></head><body></body></html></template>\n");
    await expect(build(vue)).rejects.toThrow(/needs the "@vitejs\/plugin-vue" package/);
  });
});
