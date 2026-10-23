import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewServer, ViteDevServer } from "vite";
import { build } from "../src/core/build.js";
import { startDevServer } from "../src/dev/server.js";
import { startPreviewServer } from "../src/dev/preview.js";
import { copyFixture, write } from "./helpers.js";

let servers: (ViteDevServer | PreviewServer)[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

const baseUrl = (s: ViteDevServer | PreviewServer) => s.resolvedUrls!.local[0]!.replace(/\/$/, "");
const get = (url: string) => fetch(url, { redirect: "manual" });

describe("dev server", () => {
  async function start(root: string) {
    const server = await startDevServer(root, {});
    servers.push(server);
    return { server, url: baseUrl(server) };
  }

  it("renders routes with the Vite client injected", async () => {
    const { url } = await start(copyFixture());
    const res = await get(`${url}/about/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("/@vite/client");
  });

  it("redirects to the trailing-slash route and serves 404.md for unknown paths", async () => {
    const { url } = await start(copyFixture());
    const redirect = await get(`${url}/about?x=1`);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/about/?x=1");
    const missing = await get(`${url}/nope/`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("<h1>Missing</h1>");
  });

  it("shows drafts in dev and serves public files", async () => {
    const { url } = await start(copyFixture());
    expect((await get(`${url}/blog/wip/`)).status).toBe(200);
    expect(await (await get(`${url}/images/note.txt`)).text()).toBe("public file\n");
  });

  it("picks up edits and new pages without a restart", async () => {
    const root = copyFixture();
    const { url } = await start(root);
    write(root, "src/pages/about.md", "---\ntitle: About\n---\n# Changed\n");
    write(root, "src/pages/fresh.md", "---\ntitle: Fresh\n---\n# Fresh page\n");
    expect(await (await get(`${url}/about/`)).text()).toContain("<h1>Changed</h1>");
    expect(await (await get(`${url}/fresh/`)).text()).toContain("<h1>Fresh page</h1>");
  });

  it("re-imports edited layouts", async () => {
    const root = copyFixture();
    const { url } = await start(root);
    await get(`${url}/blog/`);
    const layout = path.join(root, "src", "layouts", "plain.ts");
    fs.writeFileSync(layout, fs.readFileSync(layout, "utf8").replace('data-layout="plain"', 'data-layout="edited"'));
    await vi.waitFor(async () => expect(await (await get(`${url}/blog/`)).text()).toContain('data-layout="edited"'));
  });

  it("sends a full reload to the browser when a source file changes", async () => {
    const root = copyFixture();
    const { server } = await start(root);
    const send = vi.spyOn(server.ws, "send");
    write(root, "src/pages/about.md", "---\ntitle: About\n---\n# Reload me\n");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" }));
  });

  it("shows render errors as a 500 page instead of crashing", async () => {
    const root = copyFixture();
    const { url } = await start(root);
    write(root, "src/pages/bad.md", "no frontmatter\n");
    const res = await get(`${url}/bad/`);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Invalid frontmatter");
    expect((await get(`${url}/`)).status).toBe(200);
  });

  it("explains port conflicts", async () => {
    const { url } = await start(copyFixture());
    const port = Number(new URL(url).port);
    await expect(startDevServer(copyFixture(), { port })).rejects.toThrow(`Port ${port} is already in use`);
  });
});

describe("preview server", () => {
  it("serves the production build like a static host", async () => {
    const root = copyFixture();
    await build(root);
    const server = await startPreviewServer(root, {});
    servers.push(server);
    const url = baseUrl(server);

    expect(await (await get(`${url}/`)).text()).toContain("<h1>Home</h1>");
    expect(await (await get(`${url}/blog/post/`)).text()).toContain("<h1>Post</h1>");
    expect((await get(`${url}/blog/post`)).headers.get("location")).toBe("/blog/post/");
    const missing = await get(`${url}/blog/wip/`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("<h1>Missing</h1>");
    expect(await (await get(`${url}/`)).text()).not.toContain("/@vite/client");
  });

  it("asks for a build when dist/ is missing", async () => {
    await expect(startPreviewServer(copyFixture(), {})).rejects.toThrow(/Run "vage build" first/);
  });
});
