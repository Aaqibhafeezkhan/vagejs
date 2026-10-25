import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { loadConfig } from "../src/core/config.js";
import { createBuildLoader } from "../src/core/loader.js";
import { collectPages } from "../src/core/pages.js";
import { scheduledFor } from "../src/core/dates.js";
import { copyFixture, write } from "./helpers.js";

describe("scheduled publishing", () => {
  const now = new Date(2026, 10, 1, 12, 0); // 1 November 2026, noon local time

  it("is due from the day itself for dates, and from the moment for datetimes", () => {
    expect(scheduledFor(undefined, now)).toBeUndefined();
    expect(scheduledFor("2026-10-31", now)).toBeUndefined();
    expect(scheduledFor("2026-11-01", now)).toBeUndefined();
    expect(scheduledFor("2026-11-02", now)).toBe("2026-11-02");
    expect(scheduledFor(new Date(now.getTime() + 60_000).toISOString(), now)).toBeDefined();
    expect(scheduledFor(new Date(now.getTime() - 60_000).toISOString(), now)).toBeUndefined();
  });

  it("leaves future pages out of the build, lists and sitemap, and reports links to them", async () => {
    const root = copyFixture();
    write(root, "src/pages/blog/soon.md", "---\ntitle: Soon\ndescription: Coming soon.\ndatePublished: 2999-01-01\ntags: [Later]\n---\n# Soon\n");
    write(root, "src/pages/blog/past.md", "---\ntitle: Past\ndescription: Already out.\ndatePublished: 2001-01-01\n---\n# Past\n");
    const result = await build(root);
    expect(result.skippedScheduled).toEqual([{ source: path.join("src", "pages", "blog", "soon.md"), date: "2999-01-01" }]);
    expect(result.pages.map((p) => p.route)).toContain("/blog/past/");
    expect(result.pages.map((p) => p.route)).not.toContain("/blog/soon/");
    expect(fs.readFileSync(path.join(root, "dist", "sitemap.xml"), "utf8")).not.toContain("/blog/soon/");
    expect(result.pages.map((p) => p.route)).not.toContain("/tags/later/");
    const loader = await createBuildLoader(root);
    try {
      const pages = await collectPages(root, await loadConfig(root, loader.load), loader.load);
      expect(pages.map((p) => p.route)).not.toContain("/blog/soon/");
    } finally {
      await loader.close();
    }

    write(root, "src/pages/about.md", "---\ntitle: About\ndescription: About us.\n---\n# About\n\n[Soon](/blog/soon/)\n");
    const messages = (await check(root)).findings.filter((f) => f.page === "/about/" && f.rule === "link-broken").map((f) => f.message);
    expect(messages).toEqual(['Link to "/blog/soon/" points to a page scheduled for 2999-01-01, which is not published yet.']);
  });
});
