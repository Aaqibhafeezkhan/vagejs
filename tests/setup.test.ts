import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/cli/create.js";
import { parseConfig } from "../src/core/config.js";
import { connectInstructions, setupSteps } from "../src/dev/setup.js";

const starterConfig = { site: "https://example.com", title: "My Website", description: "A website built with vagejs." };
const done = (steps: { id: string; done: boolean }[]) => Object.fromEntries(steps.map((s) => [s.id, s.done]));

function newSite(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vage-setup-")), "site");
  createProject(dir, "^0.0.0");
  return dir;
}

describe("editor next steps", () => {
  it("lists every step as to-do on a new starter site, with the page to open", async () => {
    const root = newSite();
    const steps = setupSteps(root, await parseConfig(starterConfig));
    expect(done(steps)).toEqual({ site: false, title: false, home: false, about: false, author: false, icon: false, "share-image": false });
    expect(steps.find((s) => s.id === "about")!.page).toBe("src/pages/about.md");
    expect(steps.find((s) => s.id === "author")!.page).toBe("src/pages/blog/first-post.md");
  });

  it("ticks steps off from the project itself, wherever the change was made", async () => {
    const root = newSite();
    fs.appendFileSync(path.join(root, "src/pages/about.md"), "\nWe bake bread.\n");
    const post = path.join(root, "src/pages/blog/first-post.md");
    fs.writeFileSync(post, fs.readFileSync(post, "utf8").replace("type: article\n", "type: article\nauthor: Ann Baker\n"));
    fs.writeFileSync(path.join(root, "public/favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const site = await parseConfig({ ...starterConfig, site: "https://ann.example", title: "Ann's Bakery", seo: { defaultImage: "/images/og.png" } });
    expect(done(setupSteps(root, site))).toEqual({ site: true, title: true, home: false, about: true, author: true, icon: true, "share-image": true });
  });

  it("counts deleted sample pages as done and ignores line endings", async () => {
    const root = newSite();
    fs.rmSync(path.join(root, "src/pages/blog/first-post.md"));
    const home = path.join(root, "src/pages/index.md");
    fs.writeFileSync(home, fs.readFileSync(home, "utf8").replace(/\n/g, "\r\n"));
    const steps = done(setupSteps(root, await parseConfig(starterConfig)));
    expect(steps.author).toBe(true);
    expect(steps.home).toBe(false); // the same text with CRLF is still the starter's
  });

  it("gives the documented commands to connect an assistant, with this site's folder", () => {
    const c = connectInstructions("/sites/bakery");
    expect(c.claudeCode).toBe("claude mcp add --transport stdio --scope project vagejs -- npx -p vagejs vage mcp");
    expect(JSON.parse(c.mcpJson).mcpServers.vagejs.args).toEqual(["-p", "vagejs", "vage", "mcp", "--root", path.resolve("/sites/bakery")]);
  });
});
