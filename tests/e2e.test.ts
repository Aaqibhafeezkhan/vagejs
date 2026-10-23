// Full user journey against the packed package: create -> npm install -> build.
// Needs network or a warm npm cache for third-party dependencies. Run with `npm run test:e2e`.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const REPO = path.join(import.meta.dirname, "..");
const CLI = path.join(REPO, "dist", "cli", "index.js");
let work: string;
let tarball: string;

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "vage-e2e-"));
  const packed = execFileSync("npm", ["pack", "--pack-destination", work, "--json"], { cwd: REPO, encoding: "utf8" });
  tarball = path.join(work, JSON.parse(packed)[0].filename);
}, 120_000);

function vage(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

describe("vage CLI (packed package)", () => {
  it("creates, installs from lockfile and builds a starter site", () => {
    const created = vage(["create", "site", "--vage-spec", `file:${tarball}`, "--json"], work);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout).ok).toBe(true);

    const site = path.join(work, "site");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: site, stdio: "pipe" });
    expect(fs.existsSync(path.join(site, "package-lock.json"))).toBe(true);
    // Reinstall strictly from the lockfile, as CI would.
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: site, stdio: "pipe" });

    // Use the project's own installed binary, as a user would via npm scripts.
    const built = spawnSync("npx", ["vage", "build", "--json"], { cwd: site, encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    const result = JSON.parse(built.stdout);
    expect(result.ok).toBe(true);
    expect(result.pages.map((p: { route: string }) => p.route)).toEqual(["/", "/about/", "/blog/first-post/"]);
    for (const file of ["index.html", "about/index.html", "blog/first-post/index.html", "404.html", "favicon.svg"]) {
      expect(fs.existsSync(path.join(site, "dist", file)), file).toBe(true);
    }
    expect(fs.readFileSync(path.join(site, "dist", "index.html"), "utf8")).toContain("<title>Home | My Website</title>");
    for (const file of ["robots.txt", "sitemap.xml", "llms.txt"]) {
      expect(fs.existsSync(path.join(site, "dist", file)), file).toBe(true);
    }

    // A fresh starter passes checks; the only warning is the placeholder site URL.
    const checked = spawnSync("npx", ["vage", "check", "--json"], { cwd: site, encoding: "utf8" });
    expect(checked.status, checked.stdout).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ ok: true, errors: 0, warnings: 1, findings: [{ rule: "config" }] });
    expect(spawnSync("npx", ["vage", "check", "--strict"], { cwd: site, encoding: "utf8" }).status).toBe(1);

    // The starter is within budgets and has no automated accessibility violations.
    const audited = spawnSync("npx", ["vage", "audit", "--json"], { cwd: site, encoding: "utf8" });
    expect(audited.status, audited.stdout).toBe(0);
    expect(JSON.parse(audited.stdout)).toMatchObject({ ok: true, errors: 0, warnings: 0 });
  }, 300_000);

  it("supports a representative coding-agent workflow", () => {
    const site = path.join(work, "site");
    const json = (args: string[]) => {
      const res = spawnSync("npx", ["vage", ...args, "--json"], { cwd: site, encoding: "utf8" });
      return { status: res.status, data: JSON.parse(res.stdout) };
    };

    // 1. Discover the API instead of guessing.
    const info = json(["info"]).data;
    expect(info.frontmatter.schema.required).toEqual(["title"]);
    expect(info.commands.map((c: { usage: string }) => c.usage)).toContain("vage check");

    // 2. Add a page per the schema, and link to it with a typo.
    fs.writeFileSync(path.join(site, "src/pages/services.md"), "---\ntitle: Services\ndescription: What we offer.\n---\n# Services\n");
    const index = path.join(site, "src/pages/index.md");
    fs.appendFileSync(index, "\n[Our services](/service/)\n");

    // 3. check reports an actionable error with the file to fix.
    const failed = json(["check"]);
    expect(failed.status).toBe(1);
    expect(failed.data.findings).toContainEqual(
      expect.objectContaining({ rule: "link-broken", source: path.join("src", "pages", "index.md"), message: expect.stringContaining("/service/") }),
    );

    // 4. Fix, re-check, build; the new page is in the sitemap and llms.txt.
    fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("/service/", "/services/"));
    expect(json(["check"]).data.errors).toBe(0);
    expect(json(["build"]).status).toBe(0);
    expect(fs.readFileSync(path.join(site, "dist/sitemap.xml"), "utf8")).toContain("https://example.com/services/");
    expect(fs.readFileSync(path.join(site, "dist/llms.txt"), "utf8")).toContain("- [Services](https://example.com/services/): What we offer.");
  }, 120_000);

  it("returns non-zero with a JSON error for failures", () => {
    const res = vage(["build", "--root", path.join(work, "missing"), "--json"], work);
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({ ok: false, error: expect.stringMatching(/No src\/pages directory/) });
  });

  it("refuses to scaffold into a non-empty directory", () => {
    const res = vage(["create", "site"], work);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/already exists and is not empty/);
  });

  it("rejects unknown commands and invalid ports", () => {
    expect(vage(["deploy"], work).stderr).toMatch(/Unknown command "deploy"/);
    expect(vage(["dev", "--port", "abc"], work).stderr).toMatch(/Invalid port "abc"/);
  });

  it("prints help and version", () => {
    const help = vage(["--help"], work);
    expect(help.status).toBe(0);
    for (const cmd of ["create", "dev", "build", "check", "audit", "preview", "info"]) expect(help.stdout).toContain(cmd);
    expect(vage(["--version"], work).stdout).toContain("0.1.0");
  });
});
