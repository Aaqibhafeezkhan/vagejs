// Regression tests for the security review (2026-10-23). Each block names the issue it guards.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PreviewServer, ViteDevServer } from "vite";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { parseConfig } from "../src/core/config.js";
import { assertBranchName, assertCloudflareProject, assertGitRemote, assertVageSpec, assertWorkerName } from "../src/core/validate.js";
import { parseMarkdown } from "../src/content/markdown.js";
import { changedPageRoutes } from "../src/deploy/git.js";
import { findSecrets } from "../src/deploy/secrets.js";
import { startDevServer } from "../src/dev/server.js";
import { startPreviewServer } from "../src/dev/preview.js";
import { llmsTxt } from "../src/discovery/llms.js";
import { changeReport, untrusted } from "../src/guidelines/monitor.js";
import { rulePack } from "../src/guidelines/pack.js";
import { copyFixture, write } from "./helpers.js";

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");
const XSS = '<script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">j</a><iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name=pw></form><meta http-equiv="refresh" content="0;url=https://evil.example">';

describe("stored XSS from page content", () => {
  it("sanitizes content by default, keeping safe HTML and analytics attributes", async () => {
    const root = copyFixture();
    write(root, "src/pages/evil.md", `---\ntitle: Evil\ndescription: x\n---\n# Evil\n\n${XSS}\n\n[md](javascript:alert(4)) <a href="/about/" data-vage-event="e" title="ok">safe</a>\n`);
    await build(root);
    const main = read(root, "evil/index.html").split("<main>")[1]!;
    for (const bad of ["<script", "onerror", "javascript:", "<iframe", "<form", "<input", "http-equiv"]) expect(main).not.toContain(bad);
    expect(main).toContain('<a href="/about/" data-vage-event="e" title="ok">safe</a>');
  });

  it("keeps raw HTML only when the owner opts in, and check flags script URLs", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", markdown: { html: "allow" } };');
    write(root, "src/pages/evil.md", "---\ntitle: Evil\ndescription: x\n---\n# Evil\n\n[md](javascript:alert(4))\n");
    await build(root);
    expect(read(root, "evil/index.html")).toContain('href="javascript:alert(4)"');
    expect((await check(root)).findings).toContainEqual(expect.objectContaining({ rule: "unsafe-url", severity: "error", page: "/evil/" }));
  });
});

describe("frontmatter and config injection", () => {
  it("rejects multi-line titles, protocol-relative canonicals and script image URLs", () => {
    expect(() => parseMarkdown("---\ntitle: \"A\\n## Injected\"\n---\n", "x.md")).toThrow(/single line/);
    expect(() => parseMarkdown("---\ntitle: A\ncanonical: //evil.example/x\n---\n", "x.md")).toThrow(/single "\/"/);
    expect(() => parseMarkdown("---\ntitle: A\nimage: javascript:alert(1)\n---\n", "x.md")).toThrow(/single "\/"/);
  });

  it("escapes Markdown link syntax in llms.txt", () => {
    const txt = llmsTxt("Site", undefined, [{ title: "x](https://evil.example) [y", url: "https://a.example/a b/", description: "d", body: "" }]);
    expect(txt).toContain("- [x\\]\\(https://evil.example\\) \\[y](https://a.example/a%20b/): d");
  });

  it("rejects redirect traversal, script targets and robots line injection", () => {
    expect(() => parseConfig({ redirects: { "/../../pwn/": "/" } })).toThrow(/"\.\." segments/);
    expect(() => parseConfig({ redirects: { "/old/": "javascript:alert(1)" } })).toThrow(/single "\/"/);
    expect(() => parseConfig({ redirects: { "/old/": "//evil.example" } })).toThrow(/single "\/"/);
    expect(() => parseConfig({ seo: { robots: { rules: [{ userAgent: "*", disallow: ["/x\nUser-agent: GPTBot"] }] } } })).toThrow(/spaces or line breaks/);
  });

  it("warns when a layout points canonical at another site", async () => {
    const root = copyFixture();
    write(root, "src/layouts/plain.ts", 'export default ({ content }: { content: string }) => `<html lang="en"><head><title>t</title><link rel="canonical" href="https://evil.example/"></head><body>${content}</body></html>`;');
    expect((await check(root)).findings).toContainEqual(expect.objectContaining({ rule: "canonical", severity: "warning", page: "/blog/" }));
  });

  it("reports malformed links instead of crashing", async () => {
    const root = copyFixture();
    write(root, "src/pages/index.md", "---\ntitle: Home\ndescription: Home.\n---\n# Home\n\n[bad](/%zz)\n");
    expect((await check(root)).findings).toContainEqual(expect.objectContaining({ rule: "link-broken", message: 'Link to "/%zz" is a malformed URL.' }));
  });
});

describe("public/ is published", () => {
  it("refuses symlinks", async () => {
    const root = copyFixture();
    write(root, ".env", "SECRET=abc\n");
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "public", "env.txt"));
    await expect(build(root)).rejects.toThrow(/public\/env.txt is a symlink/);
  });

  it("refuses secrets but only warns about Google browser keys", async () => {
    const root = copyFixture();
    write(root, "public/.dev.vars", "TOKEN=x\n");
    await expect(build(root)).rejects.toThrow(/public\/\.dev\.vars: environment file/);
    fs.rmSync(path.join(root, "public/.dev.vars"));
    write(root, "public/maps.js", `const key = "AIza${"a".repeat(35)}";`);
    expect((await build(root)).warnings.join()).toMatch(/public\/maps.js contains a Google API key/);
  });
});

describe("secret scanner coverage", () => {
  it("catches Cloudflare/direnv files, Google OAuth secrets and refresh tokens, and big text files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vage-sec-"));
    write(dir, "a.json", `{"client_secret":"GOCSPX-${"a".repeat(28)}"}`);
    write(dir, "b.json", `{"refresh_token":"1//0${"b".repeat(40)}"}`);
    write(dir, "big.txt", "x".repeat(21 * 1024 * 1024));
    const hits = findSecrets(dir, [".dev.vars", ".envrc", "a.json", "b.json", "big.txt", "google.json"]);
    expect(hits.map((h) => `${h.path}: ${h.reason}`)).toEqual([
      ".dev.vars: environment file",
      ".envrc: environment file",
      "a.json: looks like a Google OAuth client secret",
      "b.json: looks like a Google OAuth refresh token",
      "big.txt: text file too large to scan for secrets; review it manually",
      "google.json: vagejs credentials file",
    ]);
  });
});

describe("argument injection into git, wrangler and npm", () => {
  beforeAll(() => {
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" });
  });

  it("never passes --changed-since to git as an option", async () => {
    const root = copyFixture();
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "a"], { cwd: root });
    write(root, "src/pages/about.md", "---\ntitle: About\n---\n# Changed\n");
    fs.rmSync(path.join(root, "src/pages/hidden.md"));
    expect(await changedPageRoutes(root, "HEAD")).toEqual(["/about/", "/hidden/"]);

    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "keep me");
    await expect(changedPageRoutes(root, `--output=${victim}`)).rejects.toThrow(/Invalid ref/);
    await expect(changedPageRoutes(root, `HEAD --output=${victim}`)).rejects.toThrow(/not a commit/);
    expect(fs.readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("validates branch, project, remote and dependency spec values", () => {
    expect(assertBranchName("feature/x-1")).toBe("feature/x-1");
    for (const bad of ["--upload-pack=x", "a..b", "a b", "x.lock"]) expect(() => assertBranchName(bad)).toThrow();
    expect(() => assertCloudflareProject("--x")).toThrow();
    expect(assertWorkerName("a".repeat(63))).toHaveLength(63);
    expect(() => assertWorkerName("a".repeat(64))).toThrow();
    expect(() => assertWorkerName("-x")).toThrow();
    expect(() => assertGitRemote("ext::sh -c touch /tmp/pwn")).toThrow();
    expect(() => assertGitRemote("--upload-pack=touch /tmp/pwn")).toThrow();
    expect(assertGitRemote("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(assertVageSpec("^0.1.0")).toBe("^0.1.0");
    expect(assertVageSpec("file:../vagejs-0.1.0.tgz")).toBe("file:../vagejs-0.1.0.tgz");
    for (const bad of ["github:attacker/repo", "https://evil.example/x.tgz", "git+ssh://x"]) expect(() => assertVageSpec(bad)).toThrow();
  });
});

describe("network exposure of dev and preview servers", () => {
  let servers: (ViteDevServer | PreviewServer)[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });
  const base = (s: ViteDevServer | PreviewServer) => s.resolvedUrls!.local[0]!.replace(/\/$/, "");
  const status = async (url: string) => (await fetch(url, { redirect: "manual" })).status;

  it("dev server serves pages, public files and the reload client, but no project sources", async () => {
    const root = copyFixture();
    write(root, ".dev.vars", "SECRET=x\n");
    const server = await startDevServer(root, {});
    servers.push(server);
    const url = base(server);
    for (const ok of ["/", "/about/", "/robots.txt", "/images/note.txt", "/@vite/client"]) expect(await status(url + ok), ok).toBe(200);
    for (const blocked of ["/package.json", "/vage.config.ts", "/vage.config.ts?raw", "/src/pages/about.md", "/src/layouts/plain.ts", "/src/layouts/plain?import", "/.dev.vars", `/@fs${root}/vage.config.ts`]) {
      expect(await status(url + blocked), blocked).toBe(404);
    }
    expect(await status(`${url}/%zz`)).toBe(404);
  });

  it("serves generated Markdown copies and feeds in dev, but never the source files behind them", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", seo: { markdownCopies: true, feeds: [{ under: "/blog/" }] } };');
    write(root, "src/pages/blog/feed.xml", "<secret/>");
    write(root, "README.md", "internal notes");
    const server = await startDevServer(root, {});
    servers.push(server);
    const url = base(server);
    for (const ok of ["/about.md", "/blog/post.md"]) expect(await status(url + ok), ok).toBe(200);
    for (const blocked of ["/src/pages/about.md", "/README.md", "/src/pages/blog/feed.xml"]) expect(await status(url + blocked), blocked).toBe(404);
    // A symlinked .md in public/ must not be followed (review finding).
    fs.writeFileSync(path.join(root, "..", "outside-secret.md"), "secret");
    fs.symlinkSync(path.join(root, "..", "outside-secret.md"), path.join(root, "public", "linked.md"));
    expect(await status(`${url}/linked.md`)).toBe(404);
  });

  it("preview server has no open redirect, no file-existence oracle and no stack traces", async () => {
    const root = copyFixture();
    write(root, "src/pages/evilsite.md", "---\ntitle: E\n---\n# E\n");
    await build(root);
    const server = await startPreviewServer(root, {});
    servers.push(server);
    const url = base(server);
    // "//evilsite" must redirect to the local route, never to the protocol-relative "//evilsite/".
    const res = await fetch(`${url}//evilsite`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/evilsite/");
    // The reviewer's original exploit URL.
    const exploit = await fetch(`${url}//evil.example/x%2f%2e%2e%2f%2e%2e`, { redirect: "manual" });
    expect(exploit.headers.get("location") ?? "").not.toMatch(/^\/\//);

    const outside = await fetch(`${url}/..%2f..%2f..%2fetc%2fhosts`);
    const missing = await fetch(`${url}/definitely-missing`);
    expect(outside.status).toBe(404);
    expect(await outside.text()).toBe(await missing.text());

    const malformed = await fetch(`${url}/%zz`);
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toMatch(/at .*\.js/);
  });
});

describe("guideline monitor output", () => {
  it("renders fetched headings and LLM text as inert inline code", () => {
    const source = rulePack.sources.find((s) => s.id === "openai-bots")!;
    const report = changeReport(rulePack, [{ source, kind: "changed", added: ["[click](https://evil.example) @maintainer ![x](https://evil.example/t.png)"], removed: [], modified: [] }], "2026-10-23", [
      { sourceId: "openai-bots", section: "s", classification: "unclear", rationale: "<img src=x onerror=alert(1)> `x`", suggestedAction: "@all ping" },
    ]);
    expect(report).toContain("`[click](https://evil.example) @maintainer ![x](https://evil.example/t.png)`");
    expect(report).toContain("`<img src=x onerror=alert(1)> 'x'`");
    expect(untrusted("a\n\nb`c")).toBe("`a b'c`");
  });
});
