import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { copyFixture, write } from "./helpers.js";

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");

describe("build", () => {
  it("writes one HTML file per published route plus 404 and public files", async () => {
    const root = copyFixture();
    const result = await build(root);

    expect(result.pages.map((p) => p.output)).toEqual([
      "index.html",
      "about-copy/index.html",
      "about/index.html",
      "blog/index.html",
      "blog/post/index.html",
      "hidden/index.html",
    ]);
    expect(result.skippedDrafts).toEqual([path.join("src", "pages", "blog", "wip.md")]);
    expect(fs.existsSync(path.join(root, "dist", "blog", "wip"))).toBe(false);
    expect(read(root, "404.html")).toContain("<h1>Missing</h1>");
    expect(read(root, "images/note.txt")).toBe("public file\n");
  });

  it("uses config and the built-in default layout", async () => {
    const root = copyFixture();
    await build(root);
    const home = read(root, "index.html");
    expect(home).toContain('<html lang="en-GB">');
    expect(home).toContain("<title>Home | Fixture Site</title>");
    expect(home).toContain('content="Fixture home &lt;page&gt;"');
    // JSON-LD is data, not executable JavaScript.
    expect(home).not.toMatch(/<script(?![^>]*application\/ld\+json)/);
  });

  it("uses a named TypeScript layout from src/layouts", async () => {
    const root = copyFixture();
    await build(root);
    expect(read(root, "blog/index.html")).toContain('<body data-layout="plain"><h1>Blog index</h1>');
  });

  it("is deterministic across builds", async () => {
    const root = copyFixture();
    await build(root);
    const first = read(root, "about/index.html");
    await build(root);
    expect(read(root, "about/index.html")).toBe(first);
  });

  it("removes stale output from previous builds", async () => {
    const root = copyFixture();
    await build(root);
    fs.rmSync(path.join(root, "src", "pages", "about.md"));
    await build(root);
    expect(fs.existsSync(path.join(root, "dist", "about"))).toBe(false);
  });

  it("keeps the previous output when a build fails", async () => {
    const root = copyFixture();
    await build(root);
    write(root, "src/pages/broken.md", "---\nlayout: missing\ntitle: x\n---\n");
    await expect(build(root)).rejects.toThrow(/Layout "missing" not found[\s\S]*broken\.md/);
    expect(fs.existsSync(path.join(root, "dist", "index.html"))).toBe(true);
  });

  it("reports a clear error outside a vagejs project", async () => {
    await expect(build(path.join(copyFixture(), "public"))).rejects.toThrow(/No src\/pages directory/);
  });
});
