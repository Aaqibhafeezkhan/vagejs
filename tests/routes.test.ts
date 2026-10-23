import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverRoutes, findNotFoundPage, normalizeRequestPath } from "../src/core/routes.js";
import { copyFixture, FIXTURE, write } from "./helpers.js";

describe("discoverRoutes", () => {
  it("maps markdown files to trailing-slash routes", () => {
    const routes = discoverRoutes(path.join(FIXTURE, "src", "pages"));
    expect(routes.map((r) => [r.route, r.outFile])).toEqual([
      ["/", "index.html"],
      ["/about/", "about/index.html"],
      ["/blog/", "blog/index.html"],
      ["/blog/post/", "blog/post/index.html"],
      ["/blog/wip/", "blog/wip/index.html"],
    ]);
  });

  it("excludes 404.md and _-prefixed paths", () => {
    const routes = discoverRoutes(path.join(FIXTURE, "src", "pages")).map((r) => r.route);
    expect(routes).not.toContain("/404/");
    expect(routes.some((r) => r.includes("_drafts"))).toBe(false);
    expect(findNotFoundPage(path.join(FIXTURE, "src", "pages"))).toMatch(/404\.md$/);
  });

  it("errors when two files map to the same route", () => {
    const root = copyFixture();
    write(root, "src/pages/about/index.md", "---\ntitle: Dup\n---\n");
    expect(() => discoverRoutes(path.join(root, "src", "pages"))).toThrow(/Two pages map to the route "\/about\/"/);
  });

  it("returns no routes when the pages directory is missing", () => {
    expect(discoverRoutes("/nonexistent/pages")).toEqual([]);
  });
});

describe("normalizeRequestPath", () => {
  it.each([
    ["/", "/"],
    ["/about", "/about/"],
    ["/about/", "/about/"],
    ["/about/index.html", "/about/"],
    ["/about.html", "/about/"],
    ["/about?x=1#y", "/about/"],
    ["/caf%C3%A9", "/café/"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeRequestPath(input)).toBe(expected);
  });
});
