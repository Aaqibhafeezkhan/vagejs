import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { confirmPagesDeployment, ensurePagesEnabled, npxCli, pagesWorkflow, PAGES_WORKFLOW, runCommand, type Runner, pagesSubfolderProblem } from "../src/deploy/github-pages.js";
import { publish, type PublishPlan } from "../src/deploy/publish.js";
import { findSecrets } from "../src/deploy/secrets.js";
import { copyFixture, write, EMPTY_GIT_CONFIG } from "./helpers.js";

beforeAll(() => {
  // Isolate from the developer's git config (signing, hooks, identity).
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
const yes = async () => true;

/** Fixture with a clean check and a .gitignore, plus an empty bare repo as the remote. */
function setup() {
  const root = copyFixture();
  write(root, "src/layouts/plain.ts", 'export default ({ content }: { content: string }) => `<html lang="en"><head><title>t</title></head><body><main>${content}</main></body></html>`;');
  write(root, ".gitignore", "node_modules/\ndist/\n");
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "vage-remote-"));
  sh(remote, "init", "-q", "--bare", "-b", "main");
  return { root, remote };
}

describe("publish (deploy:github)", () => {
  it("initializes, commits and pushes a new project, confirming the remote head", async () => {
    const { root, remote } = setup();
    let seen: PublishPlan | undefined;
    const result = await publish(root, { remote, confirm: async (plan) => ((seen = plan), true) });

    expect(seen).toMatchObject({ initRepo: true, branch: "main", addRemote: true, remote });
    expect(seen!.files.map((f) => f.path)).toContain("vage.config.ts");
    expect(seen!.files.some((f) => f.path.startsWith("dist/"))).toBe(false);
    expect(result.status).toBe("published");
    expect(result.confirmedRemote).toEqual({ url: remote, branch: "main", sha: result.commit });
    expect(sh(remote, "rev-parse", "main")).toBe(result.commit);
  });

  it("changes nothing when the plan is declined", async () => {
    const { root, remote } = setup();
    expect((await publish(root, { remote, confirm: async () => false })).status).toBe("aborted");
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    expect(sh(remote, "branch")).toBe("");
  });

  it("reports up-to-date when there is nothing to publish", async () => {
    const { root, remote } = setup();
    await publish(root, { remote, confirm: yes });
    let asked = false;
    expect((await publish(root, { confirm: async () => (asked = true) })).status).toBe("up-to-date");
    expect(asked).toBe(false);
  });

  it("commits locally when there is no remote", async () => {
    const { root } = setup();
    const result = await publish(root, { confirm: yes });
    expect(result.status).toBe("committed");
    expect(result.plan.warnings[0]).toMatch(/No remote/);
    expect(sh(root, "rev-parse", "HEAD")).toBe(result.commit);
  });

  it("never force-pushes over newer remote commits", async () => {
    const { root, remote } = setup();
    await publish(root, { remote, confirm: yes });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "vage-other-"));
    sh(other, "clone", "-q", remote, ".");
    fs.writeFileSync(path.join(other, "README.md"), "theirs\n");
    sh(other, "add", "-A");
    sh(other, "commit", "-q", "-m", "theirs");
    sh(other, "push", "-q");
    const theirs = sh(other, "rev-parse", "HEAD");

    write(root, "src/pages/new.md", "---\ntitle: New\ndescription: New page.\n---\n# New\n");
    await expect(publish(root, { confirm: yes })).rejects.toThrow(/Push rejected[\s\S]*git pull --rebase origin main[\s\S]*never force-pushes/);
    expect(sh(remote, "rev-parse", "main")).toBe(theirs);
    expect(sh(root, "log", "-1", "--format=%s")).toBe("Publish site with vagejs"); // kept locally
  });

  it("refuses possible secrets and build output, before changing anything", async () => {
    const { root, remote } = setup();
    write(root, ".env", "TOKEN=x\n");
    await expect(publish(root, { remote, confirm: yes })).rejects.toThrow(/possible secrets:\n  \.env: environment file/);
    fs.rmSync(path.join(root, ".env"));

    write(root, "src/pages/leak.md", "---\ntitle: Leak\n---\n# Leak\n\nAKIAABCDEFGHIJKLMNOP\n");
    await expect(publish(root, { remote, confirm: yes })).rejects.toThrow(/src\/pages\/leak\.md: looks like a AWS access key ID/);
    fs.rmSync(path.join(root, "src/pages/leak.md"));

    write(root, ".gitignore", "node_modules/\n");
    await expect(publish(root, { remote, confirm: yes })).rejects.toThrow(/Refusing to commit build output/);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
  });

  it("refuses to publish when vage check has errors", async () => {
    const root = copyFixture(); // the fixture's plain layout has no <html lang>
    await expect(publish(root, { confirm: yes })).rejects.toThrow(/vage check found 1 error/);
  });

  it("does not change an existing origin or switch branches", async () => {
    const { root, remote } = setup();
    await publish(root, { remote, confirm: yes });
    write(root, "src/pages/x.md", "---\ntitle: X\ndescription: X.\n---\n# X\n");
    await expect(publish(root, { remote: "https://elsewhere.example/repo.git", confirm: yes })).rejects.toThrow(/origin is already/);
    await expect(publish(root, { branch: "gh-pages", confirm: yes })).rejects.toThrow(/You are on "main", not "gh-pages"/);
  });

  it("adds generated files only when missing and warns about file: dependencies", async () => {
    const { root, remote } = setup();
    write(root, "package.json", JSON.stringify({ devDependencies: { vagejs: "file:../vagejs.tgz" } }));
    const result = await publish(root, { remote, confirm: yes, extraFiles: (branch) => ({ [PAGES_WORKFLOW]: pagesWorkflow(branch) }) });
    expect(result.plan.warnings.join()).toMatch(/"file:" dependencies \(vagejs\)/);
    expect(sh(remote, "show", `main:${PAGES_WORKFLOW}`)).toContain('branches: ["main"]');

    write(root, PAGES_WORKFLOW, "# customized\n");
    const again = await publish(root, { confirm: yes, extraFiles: (b) => ({ [PAGES_WORKFLOW]: pagesWorkflow(b) }) });
    expect(again.plan.extraFiles).toEqual({});
    expect(fs.readFileSync(path.join(root, PAGES_WORKFLOW), "utf8")).toBe("# customized\n");
  });
});

describe("secret scanning", () => {
  it("allows example env files and flags token formats without echoing them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vage-secrets-"));
    write(dir, ".env.example", "TOKEN=\n");
    write(dir, "a.txt", `token: ghp_${"a".repeat(36)}`);
    write(dir, "b.txt", `-----BEGIN OPENSSH ${"PRIVATE KEY"}-----`); // split so scanners don't flag this test file
    write(dir, "ok.txt", "nothing here");
    const hits = findSecrets(dir, [".env.example", "a.txt", "b.txt", "ok.txt", "deploy/id_ed25519", "config/.env.production"]);
    expect(hits).toEqual([
      { path: "a.txt", reason: "looks like a GitHub token" },
      { path: "b.txt", reason: "looks like a private key" },
      { path: "deploy/id_ed25519", reason: "SSH private key" },
      { path: "config/.env.production", reason: "environment file" },
    ]);
    expect(JSON.stringify(hits)).not.toContain("ghp_");
  });
});

describe("GitHub Pages adapter", () => {
  it("generates a least-privilege workflow that checks before deploying", () => {
    const yml = pagesWorkflow("main");
    expect(yml).toMatch(/build:[\s\S]*permissions:\n      contents: read[\s\S]*npx vage check[\s\S]*npx vage build[\s\S]*upload-pages-artifact@v5/);
    expect(yml).toMatch(/deploy:\n    needs: build[\s\S]*pages: write\n      id-token: write[\s\S]*name: github-pages[\s\S]*deploy-pages@v5/);
    // Daily, so pages with a future datePublished go live on their day.
    expect(yml).toMatch(/schedule:\n    - cron: "15 0 \* \* \*"/);
  });

  function fakeGh(responses: Record<string, { code?: number; stdout?: string }>): { run: Runner; calls: string[] } {
    const calls: string[] = [];
    const run: Runner = async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
      return { code: match?.[1].code ?? 0, stdout: match?.[1].stdout ?? "", stderr: "" };
    };
    return { run, calls };
  }

  it("reports success only after GitHub says the run succeeded", async () => {
    const { run } = fakeGh({
      "gh run list": { stdout: JSON.stringify([{ databaseId: 7, url: "https://github.com/o/r/actions/runs/7" }]) },
      "gh run view": { stdout: JSON.stringify({ conclusion: "success" }) },
      "gh api repos/{owner}/{repo}/pages": { stdout: "https://o.github.io/\n" },
    });
    expect(await confirmPagesDeployment("/x", "abc1234", { run, sleep: async () => {} })).toEqual({
      status: "success",
      runUrl: "https://github.com/o/r/actions/runs/7",
      pageUrl: "https://o.github.io/",
    });
  });

  it("reports failure and unconfirmed states honestly", async () => {
    const failed = fakeGh({
      "gh run list": { stdout: JSON.stringify([{ databaseId: 7, url: "u" }]) },
      "gh run view": { stdout: JSON.stringify({ conclusion: "failure" }) },
    });
    expect(await confirmPagesDeployment("/x", "abc", { run: failed.run, sleep: async () => {} })).toMatchObject({ status: "failure", runUrl: "u" });

    const noGh = fakeGh({ "gh auth status": { code: 127 } });
    expect(await confirmPagesDeployment("/x", "abc", { run: noGh.run })).toMatchObject({ status: "unconfirmed", reason: expect.stringMatching(/gh/) });

    const noRun = fakeGh({ "gh run list": { stdout: "[]" } });
    expect(await confirmPagesDeployment("/x", "abcdef0", { run: noRun.run, sleep: async () => {}, findRunAttempts: 2 })).toMatchObject({
      status: "unconfirmed",
      reason: expect.stringMatching(/No deploy.yml run found for abcdef0/),
    });
  });

  it("enables Pages with the Actions source only when needed", async () => {
    expect(await ensurePagesEnabled("/x", fakeGh({}).run)).toBe("already-enabled");
    const missing = fakeGh({ "gh api repos/{owner}/{repo}/pages": { code: 1 }, "gh api -X POST": { code: 0 } });
    expect(await ensurePagesEnabled("/x", missing.run)).toBe("enabled");
    expect(missing.calls).toContain("gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow");
    expect(await ensurePagesEnabled("/x", fakeGh({ "gh auth status": { code: 1 } }).run)).toMatchObject({ manual: expect.stringMatching(/Source: "GitHub Actions"/) });
  });
});

describe("GitHub Pages subfolder check", () => {
  it("stops a github.io site published from a project repository (it would live in a subfolder)", () => {
    const problem = pagesSubfolderProblem("https://agevenkat.github.io", "https://github.com/agevenkat/vagejs-host-test.git");
    expect(problem).toMatch(/https:\/\/agevenkat\.github\.io\/vagejs-host-test\/, a subfolder/);
    expect(problem).toMatch(/Custom domain/);
    expect(pagesSubfolderProblem("https://agevenkat.github.io", "git@github.com:agevenkat/site")).toBeDefined();
  });

  it("allows the owner's own github.io repository, a custom domain, and other git hosts", () => {
    expect(pagesSubfolderProblem("https://agevenkat.github.io", "https://github.com/agevenkat/agevenkat.github.io.git")).toBeUndefined();
    expect(pagesSubfolderProblem("https://AgeVenkat.github.io", "git@github.com:AgeVenkat/AgeVenkat.github.io.git")).toBeUndefined();
    expect(pagesSubfolderProblem("https://www.example.org", "https://github.com/agevenkat/site.git")).toBeUndefined();
    expect(pagesSubfolderProblem("https://agevenkat.github.io", "https://gitlab.com/agevenkat/site.git")).toBeUndefined();
    expect(pagesSubfolderProblem("https://agevenkat.github.io", undefined)).toBeUndefined();
    expect(pagesSubfolderProblem("https://agevenkat.github.io", "https://notgithub.com/agevenkat/site.git")).toBeUndefined();
    expect(pagesSubfolderProblem("https://agevenkat.github.io", "ssh://git@github.com/agevenkat/site.git")).toBeDefined();
  });
});

describe("running npx", () => {
  it("finds npm's npx script next to node or npm", () => {
    expect(npxCli()).toMatch(/npx-cli\.js$/);
    expect(npxCli({}, "/nowhere/node")).toBeUndefined();
  });

  // On Windows, npx is npx.cmd, which execFile can't start without a shell.
  it("runs npx on every platform", async () => {
    const res = await runCommand("npx", ["--version"], process.cwd());
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
