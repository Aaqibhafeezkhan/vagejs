import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { editorEnabled, editorUrl } from "../src/dev/editor.js";
import { startDevServer } from "../src/dev/server.js";
import { copyFixture, write } from "./helpers.js";

let servers: ViteDevServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function editor(root = copyFixture(), host?: string | boolean) {
  const server = await startDevServer(root, { host });
  servers.push(server);
  const devPort = (server.httpServer!.address() as { port: number }).port;
  const url = await editorUrl(server);
  const port = url ? Number(new URL(url).port) : 0;
  const base = `http://localhost:${port}`;
  const page = url ? await fetch(url) : undefined;
  const html = (await page?.text()) ?? "";
  const token = /name="vage-token" content="([0-9a-f]+)"/.exec(html)?.[1];
  const api = (action: string, init: RequestInit & { query?: Record<string, string> } = {}) =>
    fetch(`${base}/api/${action}${init.query ? `?${new URLSearchParams(init.query)}` : ""}`, {
      ...init,
      headers: { "x-vage-token": token ?? "", ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) },
    });
  return { root, base, page, html, token, api, port, devPort, url, server };
}

/** A raw request, so the Host header can be anything (fetch always sends the real one). */
function rawGet(port: number, pathname: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: "localhost", port, path: pathname, headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on("error", reject);
  });
}

describe("local editor", () => {
  it("serves the editor on its own port, with a key, its script and styles", async () => {
    const { base, page, token, html, devPort, port, url } = await editor();
    expect(page!.status).toBe(200);
    expect(port).not.toBe(devPort);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    // The site's address: the same host name the editor was opened with, on the dev server's port.
    expect(html).toContain(`name="vage-site" content="http://${new URL(url!).host.replace(/:\d+$/, "")}:${devPort}"`);
    expect((await fetch(`${base}/editor.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/editor.css`)).status).toBe(200);
    // The dev server sends people to it, and serves none of its files.
    const dev = `http://localhost:${devPort}`;
    expect((await fetch(`${dev}/_vage/edit/`, { redirect: "manual" })).headers.get("location")).toBe(url);
    expect((await fetch(`${dev}/_vage/edit/editor.js`)).status).toBe(404);
  });

  it("lists every page with its status", async () => {
    const { api } = await editor();
    const { pages } = (await (await api("pages")).json()) as { pages: { source: string; route: string | null; status: string; title: string }[] };
    const by = (source: string) => pages.find((p) => p.source === source);
    expect(by("src/pages/about.md")).toMatchObject({ route: "/about/", status: "published", title: "About" });
    expect(by("src/pages/blog/wip.md")?.status).toBe("draft");
    expect(by("src/pages/404.md")?.route).toBeNull();
    expect(pages.some((p) => p.source.includes("_drafts"))).toBe(false);
  });

  it("saves fields and text, keeping comments, field order and fields it doesn't know", async () => {
    const { root, api } = await editor();
    write(root, "src/pages/about.md", "---\n# The page name\ntitle: About\ndescription:   About the fixture.\nextra: kept\n---\n# About\n\nOld text.\n");
    const page = (await (await api("page", { query: { source: "src/pages/about.md" } })).json()) as { data: Record<string, unknown>; body: string; version: string; fields: { key: string }[] };
    expect(page.data).toEqual({ title: "About", description: "About the fixture.", extra: "kept" });
    expect(page.body).toBe("# About\n\nOld text.\n");
    expect(page.fields.map((f) => f.key)).toContain("datePublished");

    const res = await api("page", { method: "PUT", body: JSON.stringify({ source: "src/pages/about.md", version: page.version, data: { ...page.data, title: "About us", tags: ["News", "Team"] }, body: "# About us\n\nNew text.\n" }) });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "src/pages/about.md"), "utf8")).toBe(
      "---\n# The page name\ntitle: About us\ndescription: About the fixture.\nextra: kept\ntags:\n  - News\n  - Team\n---\n# About us\n\nNew text.\n",
    );
  });

  it("refuses a save when the file changed since it was opened", async () => {
    const { root, api } = await editor();
    const { version } = (await (await api("page", { query: { source: "src/pages/about.md" } })).json()) as { version: string };
    write(root, "src/pages/about.md", "---\ntitle: About\nauthor: An agent\n---\nAgent text.\n");
    const res = await api("page", { method: "PUT", body: JSON.stringify({ source: "src/pages/about.md", version, data: { title: "Mine" }, body: "Mine.\n" }) });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(path.join(root, "src/pages/about.md"), "utf8")).toContain("Agent text.");
  });

  it("only loads layouts from src/layouts", async () => {
    const { root, api } = await editor();
    write(root, "evil.ts", `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(root, "ran.txt"))}, "x"); export default () => "";\n`);
    expect((await api("schema", { query: { layout: "../../evil" } })).status).toBe(400);
    write(root, "src/pages/about.md", "---\ntitle: About\nlayout: ../../evil\n---\nx\n");
    expect((await api("page", { query: { source: "src/pages/about.md" } })).status).toBe(200);
    expect(fs.existsSync(path.join(root, "ran.txt"))).toBe(false);
  });

  it("refuses invalid fields and leaves the file as it was", async () => {
    const { root, api } = await editor();
    const before = fs.readFileSync(path.join(root, "src/pages/about.md"), "utf8");
    const { version } = (await (await api("page", { query: { source: "src/pages/about.md" } })).json()) as { version: string };
    const res = await api("page", { method: "PUT", body: JSON.stringify({ source: "src/pages/about.md", version, data: { title: "" }, body: "x" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/title/);
    const bad = await api("page", { method: "PUT", body: JSON.stringify({ source: "src/pages/about.md", version, data: { title: "A", datePublished: "26/10/2026" }, body: "x" }) });
    expect(((await bad.json()) as { error: string }).error).toMatch(/ISO date/);
    expect(fs.readFileSync(path.join(root, "src/pages/about.md"), "utf8")).toBe(before);
  });

  it("only touches pages in src/pages", async () => {
    const { api } = await editor();
    for (const source of ["vage.config.ts", "../outside.md", "src/pages/../../vage.config.md", "src/pages/blog/_drafts/idea.md", "src/layouts/plain.ts"]) {
      const res = await api("page", { query: { source } });
      expect(res.status, source).toBe(400);
    }
  });

  it("previews unsaved changes without writing them", async () => {
    const { root, api } = await editor();
    const before = fs.readFileSync(path.join(root, "src/pages/about.md"), "utf8");
    const res = await api("preview", { method: "POST", body: JSON.stringify({ source: "src/pages/about.md", data: { title: "Preview title", layout: "plain" }, body: "# Hello **preview**\n" }) });
    const html = await res.text();
    expect(html).toContain("<strong>preview</strong>");
    expect(html).toContain('data-layout="plain"');
    expect(fs.readFileSync(path.join(root, "src/pages/about.md"), "utf8")).toBe(before);
  });

  it("returns the page text as it would be saved, for the AI prompt", async () => {
    const { root, api } = await editor();
    const before = fs.readFileSync(path.join(root, "src/pages/about.md"), "utf8");
    const res = await api("text", { method: "POST", body: JSON.stringify({ source: "src/pages/about.md", data: { title: "Unsaved title", description: "About the fixture." }, body: "# New\n" }) });
    expect(await res.text()).toBe("---\ntitle: Unsaved title\ndescription: About the fixture.\n---\n# New\n");
    expect(fs.readFileSync(path.join(root, "src/pages/about.md"), "utf8")).toBe(before);
  });

  it("creates pages and posts as drafts", async () => {
    const { root, api } = await editor();
    const res = await api("new", { method: "POST", body: JSON.stringify({ kind: "page", name: "pricing", title: "Pricing" }) });
    expect(await res.json()).toEqual({ source: "src/pages/pricing.md" });
    expect(fs.readFileSync(path.join(root, "src/pages/pricing.md"), "utf8")).toContain("draft: true");
    const taken = await api("new", { method: "POST", body: JSON.stringify({ kind: "page", name: "pricing" }) });
    expect(taken.status).toBe(400);
  });

  it("uploads images to public/images without overwriting", async () => {
    const { root, api } = await editor();
    const png = fs.readFileSync(path.join(root, "public/images/logo.png"));
    const first = await api("image", { method: "POST", query: { name: "My Photo.PNG" }, body: png, headers: { "content-type": "image/png" } });
    expect(await first.json()).toEqual({ path: "/images/my-photo.png" });
    const second = await api("image", { method: "POST", query: { name: "my photo.png" }, body: png });
    expect(await second.json()).toEqual({ path: "/images/my-photo-2.png" });
    expect(fs.existsSync(path.join(root, "public/images/my-photo-2.png"))).toBe(true);
    const svg = await api("image", { method: "POST", query: { name: "x.svg" }, body: "<svg/>" });
    expect(svg.status).toBe(400);
  });

  it("reports the page's check findings", async () => {
    const { root, api } = await editor();
    write(root, "src/pages/about.md", "---\ntitle: About\ndescription: About the fixture.\n---\n# About\n\n[Gone](/nope/)\n");
    const config = fs.readFileSync(path.join(root, "vage.config.ts"), "utf8");
    write(root, "vage.config.ts", config.replace('lang: "en-GB",', 'lang: "en-GB",\n  menus: { main: [{ page: "/gone/" }] },'));
    const { findings, site } = (await (await api("findings", { query: { source: "src/pages/about.md" } })).json()) as { findings: { rule: string }[]; site: { rule: string }[] };
    expect(findings.map((f) => f.rule)).toContain("link-broken");
    expect(site.map((f) => f.rule)).toEqual(["menu-link"]);
  });

  it("refuses requests without the key, from other sites or the site's own pages, or for another host name", async () => {
    const { api, port, base, devPort } = await editor();
    expect((await api("pages", { headers: { "x-vage-token": "nope" } })).status).toBe(403);
    expect((await api("pages", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await api("pages", { headers: { origin: `http://localhost:${devPort}`, "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await api("pages", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(await rawGet(port, "/", { host: "evil.example" })).toBe(403);
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
    // No CORS: other local sites can't read the page that holds the key.
    const cors = await fetch(`${base}/`, { headers: { origin: "http://localhost:3000" } });
    expect(cors.headers.get("access-control-allow-origin")).toBeNull();
    expect(cors.headers.get("x-frame-options")).toBe("DENY");
  });

  it("is off when the dev server is on the network", async () => {
    expect(editorEnabled(undefined)).toBe(true);
    expect(editorEnabled("127.0.0.1")).toBe(true);
    expect(editorEnabled("::1")).toBe(true);
    expect(editorEnabled(true)).toBe(false);
    expect(editorEnabled("0.0.0.0")).toBe(false);
    expect(editorEnabled("192.168.1.5")).toBe(false);
    const { url } = await editor(copyFixture(), "0.0.0.0");
    expect(url).toBeUndefined();
  });
});
