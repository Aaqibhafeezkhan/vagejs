import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { check } from "../src/checks/check.js";
import { contactForm } from "../src/content/contact-form.js";
import { parseConfig } from "../src/core/config.js";
import { CONTACT_WORKER, deployCloudflareWorkers, planWorkersDeploy } from "../src/deploy/cloudflare-workers.js";
import type { Runner } from "../src/deploy/github-pages.js";
import { startDevServer } from "../src/dev/server.js";
import { contactEmail, contactWorker, readContactForm, type ContactEnv } from "../src/worker/contact-mail.js";
import { copyFixture, write } from "./helpers.js";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const OK = { name: "Ana", email: "ana@example.org", message: "Hello" };

describe("contact form messages", () => {
  it("reads the fields, rejects incomplete ones and flags the honeypot", () => {
    expect(readContactForm(form(OK))).toEqual(OK);
    expect(readContactForm(form({ ...OK, email: "not-an-email" }))).toBeUndefined();
    expect(readContactForm(form({ ...OK, message: "  " }))).toBeUndefined();
    expect(readContactForm(form({ ...OK, website: "https://spam.example" }))).toBe("spam");
    // Line breaks would let a sender add mail headers.
    expect(readContactForm(form({ ...OK, name: "Ana\r\nBcc: x@evil.example" }))).toMatchObject({ name: "Ana Bcc: x@evil.example" });
  });

  it("builds an email with Reply-To set to the sender and every value encoded", () => {
    const raw = contactEmail({ name: "Zoë", email: "z@example.org", message: "Hi\nthere" }, { to: "me@site.example", from: "form@site.example", site: "Site", date: new Date(0), id: "1" });
    const [head, body] = raw.split("\r\n\r\n");
    expect(head!.split("\r\n")).toEqual([
      `From: =?UTF-8?B?${btoa("Site contact form")}?= <form@site.example>`,
      "To: <me@site.example>",
      `Reply-To: =?UTF-8?B?${Buffer.from("Zoë").toString("base64")}?= <z@example.org>`,
      `Subject: =?UTF-8?B?${Buffer.from("Contact form: Zoë").toString("base64")}?=`,
      "Date: Thu, 01 Jan 1970 00:00:00 GMT",
      "Message-ID: <1@site.example>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString()).toBe("From: Zoë <z@example.org>\n\nHi\nthere\n");
  });
});

describe("contact Worker", () => {
  class Message {
    constructor(
      public from: string,
      public to: string,
      public raw: string,
    ) {}
  }
  const worker = contactWorker(Message);
  const env = (extra: Partial<ContactEnv> = {}) => {
    const sent: Message[] = [];
    const e: ContactEnv = {
      ASSETS: { fetch: async () => new Response("asset") },
      EMAIL: { send: async (m) => void sent.push(m as Message) },
      CONTACT_TO: "me@site.example",
      CONTACT_FROM: "form@site.example",
      ...extra,
    };
    return { e, sent };
  };
  const post = (fields: Record<string, string>, url = "https://site.example/contact/") => new Request(url, { method: "POST", body: form(fields) });

  it("emails a message and shows the sent page", async () => {
    const { e, sent } = env();
    const res = await worker.fetch(post(OK), e);
    expect([res.status, res.headers.get("location")]).toEqual([303, "https://site.example/contact/sent/"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "form@site.example", to: "me@site.example" });
  });

  it("serves everything else from the site's files", async () => {
    const { e } = env();
    expect(await (await worker.fetch(new Request("https://site.example/contact/"), e)).text()).toBe("asset");
    expect(await (await worker.fetch(post(OK, "https://site.example/other/"), e)).text()).toBe("asset");
  });

  it("sends nothing for bots, invalid forms, visitors over the limit, missing settings or a failed send", async () => {
    const cases: [Record<string, string>, Partial<ContactEnv>, string][] = [
      [{ ...OK, website: "x" }, {}, "/contact/sent/"],
      [{ ...OK, email: "x" }, {}, "/contact/not-sent/"],
      [OK, { CONTACT_LIMIT: { limit: async () => ({ success: false }) } }, "/contact/not-sent/"],
      [OK, { CONTACT_TO: undefined }, "/contact/not-sent/"],
      [OK, { EMAIL: { send: async () => Promise.reject(new Error("unverified")) } }, "/contact/not-sent/"],
    ];
    for (const [fields, extra, to] of cases) {
      const { e, sent } = env(extra);
      const res = await worker.fetch(post(fields), e);
      expect(res.headers.get("location")).toBe(`https://site.example${to}`);
      expect(sent).toHaveLength(0);
    }
  });
});

describe("contactForm()", () => {
  it("posts to contact.path with a hidden honeypot, and needs the contact setting", () => {
    const site = parseConfig({ contact: { to: "me@site.example", from: "form@site.example", path: "/hello/" } });
    const out = String(contactForm(site, { send: "Send <now>" }));
    expect(out).toContain('<form class="vage-contact" method="post" action="/hello/"');
    expect(out).toContain('name="website" type="text" tabindex="-1"');
    expect(out).toContain("Send &lt;now&gt;</button>");
    expect(() => contactForm(parseConfig({}))).toThrow(/contact: \{ to, from \}/);
  });
});

describe("contact checks and deploys", () => {
  const site = (target = '"cloudflare-workers", cloudflareWorker: "site"') => {
    const root = copyFixture();
    write(root, "vage.config.ts", `export default { site: "https://fixture.example", title: "Fixture", deploy: { target: ${target} }, contact: { to: "me@fixture.example", from: "form@fixture.example" } };`);
    return root;
  };
  const contactFindings = async (root: string) => (await check(root)).findings.filter((f) => f.rule === "contact").map((f) => `${f.severity}: ${f.message}`);

  it("asks for the Workers target, the result pages and a form", async () => {
    const root = site('"netlify", netlifySite: "site"');
    expect(await contactFindings(root)).toEqual([
      'error: contact needs deploy.target "cloudflare-workers" (it emails through Cloudflare Email Routing); the target is "netlify".',
      "error: contact.sent is /contact/sent/, but there's no published page there. Create it (e.g. src/pages/contact/sent.md).",
      "error: contact.failed is /contact/not-sent/, but there's no published page there. Create it (e.g. src/pages/contact/not-sent.md).",
      'warning: No page has a form that posts to /contact/. Add contactForm(site) from "vagejs" to the layout of that page.',
    ]);
  });

  it("is satisfied by a contact page with the form and both result pages", async () => {
    const root = site();
    write(root, "src/pages/contact/sent.md", "---\ntitle: Sent\ndescription: Sent.\n---\n# Sent\n");
    write(root, "src/pages/contact/not-sent.md", "---\ntitle: Not sent\ndescription: Not sent.\n---\n# Not sent\n");
    write(root, "src/pages/contact.md", "---\ntitle: Contact\ndescription: Write to us.\nlayout: contact\n---\n# Contact\n");
    write(root, "src/layouts/contact.ts", 'export default ({ content }: { content: string }) => `<html lang="en"><head><title>t</title></head><body><main>${content}<form method="post" action="/contact/"></form></main></body></html>`;');
    expect(await contactFindings(root)).toEqual([]);
  });

  type Reply = { code: number; stdout?: string };
  const runner = (replies: Reply[]) => {
    const calls: string[][] = [];
    const configs: unknown[] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const at = args.indexOf("--config");
      if (at > -1 && args[at + 1]!.includes("vage-wrangler-")) configs.push(JSON.parse(fs.readFileSync(args[at + 1]!, "utf8")));
      const r = replies.shift() ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? "", stderr: "" };
    };
    return { run, calls, configs };
  };
  const VERSION = "317282a4-115f-451f-bf9f-c155d6ce13f9";
  const contact = parseConfig({ contact: { to: "me@fixture.example", from: "form@fixture.example" } }).contact!;

  it("adds vagejs's contact Worker, its bindings and settings to the generated config", async () => {
    const root = copyFixture();
    const r = runner([{ code: 0, stdout: `Worker Version ID: ${VERSION}` }, { code: 0 }]);
    await deployCloudflareWorkers(root, { plan: { worker: "site", warnings: [], contact, siteTitle: "Fixture" }, siteUrl: "https://fixture.example", run: r.run, fetch: async () => new Response("ok"), sleep: async () => {} });
    expect(r.configs[0]).toMatchObject({
      main: CONTACT_WORKER,
      send_email: [{ name: "EMAIL", destination_address: "me@fixture.example" }],
      ratelimits: [{ name: "CONTACT_LIMIT", simple: { limit: 3, period: 60 } }],
      assets: { binding: "ASSETS", run_worker_first: ["/contact/"], not_found_handling: "404-page" },
    });
    expect(CONTACT_WORKER).toMatch(/worker[\\/]contact\.js$/);
    const upload = r.calls[0]!;
    expect(upload.slice(upload.indexOf("--var"), upload.indexOf("--config"))).toEqual([
      "--var", "CONTACT_TO:me@fixture.example", "--var", "CONTACT_FROM:form@fixture.example", "--var", "CONTACT_PATH:/contact/",
      "--var", "CONTACT_SENT:/contact/sent/", "--var", "CONTACT_FAILED:/contact/not-sent/", "--var", "CONTACT_SITE:Fixture",
    ]);
    expect(r.calls[1]).not.toContain("--var"); // versions deploy takes no variables
  });

  it("says what a project's own wrangler config is missing", () => {
    const root = copyFixture();
    write(root, "wrangler.jsonc", '{ "name": "site", "assets": { "directory": "dist", "not_found_handling": "404-page" } }');
    expect(() => planWorkersDeploy(root, undefined, { contact })).toThrow(/needs these for the contact form: "main": "node_modules\/vagejs\/dist\/worker\/contact\.js"; "binding": "ASSETS"/);
    write(
      root,
      "wrangler.jsonc",
      '{ "name": "site", "main": "node_modules/vagejs/dist/worker/contact.js", "send_email": [{ "name": "EMAIL", "destination_address": "me@fixture.example" }], "assets": { "directory": "dist", "binding": "ASSETS", "run_worker_first": ["/contact/"], "not_found_handling": "404-page" } }',
    );
    expect(planWorkersDeploy(root, undefined, { contact }).contact).toEqual(contact);
  });
});

describe("contact form in the dev server", () => {
  let server: ViteDevServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("shows the sent page without emailing anything", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { title: "F", deploy: { target: "cloudflare-workers", cloudflareWorker: "f" }, contact: { to: "me@f.example", from: "form@f.example" } };');
    server = await startDevServer(root, {});
    const url = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
    const res = await fetch(`${url}/contact/`, { method: "POST", body: form(OK), redirect: "manual" });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/contact/sent/"]);
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false);
  });
});
