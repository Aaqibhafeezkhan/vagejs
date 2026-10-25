import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { check } from "../src/checks/check.js";
import { copyFixture, EMPTY_GIT_CONFIG, write } from "./helpers.js";

beforeAll(() => {
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  });
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const missing = async (root: string) => (await check(root)).findings.filter((f) => f.rule === "redirect-missing").map((f) => f.message);

describe("redirect-missing", () => {
  it("suggests a redirect for pages moved or deleted since the last commit", async () => {
    const root = copyFixture();
    write(root, "src/pages/team.md", "---\ntitle: Team\ndescription: Our team.\n---\n# Team\n");
    write(root, "src/pages/wip-old.md", "---\ntitle: Old draft\ndraft: true\n---\n# Old\n");
    sh(root, "init", "-q");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "init");
    sh(root, "mv", "src/pages/about.md", "src/pages/about-us.md");
    fs.rmSync(path.join(root, "src/pages/team.md"));
    fs.rmSync(path.join(root, "src/pages/wip-old.md"));
    expect(await missing(root)).toEqual([
      'src/pages/about.md was moved to src/pages/about-us.md since the last commit, so /about/ will stop working for anyone with an old link. Add to vage.config.ts: redirects: { "/about/": "/about-us/" }',
      'src/pages/team.md was deleted since the last commit, so /team/ will stop working for anyone with an old link. Add to vage.config.ts: redirects: { "/team/": "/new-address/" }',
    ]);

    const config = path.join(root, "vage.config.ts");
    fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace('redirects: { "/old": "/about/" }', 'redirects: { "/old": "/about-us/", "/about/": "/about-us/", "/team": "/" }'));
    expect(await missing(root)).toEqual([]);
  });

  it("stays quiet outside a git repository", async () => {
    expect(await missing(copyFixture())).toEqual([]);
  });
});
