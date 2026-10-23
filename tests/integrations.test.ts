import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { parseConfig } from "../src/core/config.js";
import { analyticsReport } from "../src/integrations/ga4-data.js";
import { connectGoogle, credentialsPath, disconnectGoogle, getAccessToken, loadCredentials, SCOPES } from "../src/integrations/google-auth.js";
import { listSites, pacificDate, searchReport } from "../src/integrations/search-console.js";
import { analyticsTags } from "../src/integrations/tags.js";
import { startDevServer } from "../src/dev/server.js";
import { copyFixture, write } from "./helpers.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};
const REFRESH = "1//refresh-token-secret";
const ACCESS = "ya29.access-token-secret";

function withAnalytics(root: string, integrations: string) {
  write(root, "vage.config.ts", `export default { site: "https://fixture.example", title: "Fixture Site", integrations: ${integrations} };`);
  write(root, "src/layouts/plain.ts", 'export default ({ content }: { content: string }) => `<html lang="en"><head><title>t</title></head><body><main>${content}</main></body></html>`;');
}

describe("analytics config", () => {
  it("validates IDs, event names and parameter names", () => {
    expect(() => parseConfig({ integrations: { ga4: { measurementId: "UA-123" } } })).toThrow(/G-XXXXXXX/);
    expect(() => parseConfig({ integrations: { ga4: { events: { "1bad": {} } } } })).toThrow(/start with a letter/);
    expect(() => parseConfig({ integrations: { ga4: { events: { ok: { params: ["google_x"] } } } } })).toThrow(/reserved prefix/);
    expect(() => parseConfig({ integrations: { ga4: { events: { [`e${"x".repeat(40)}`]: {} } } } })).toThrow();
    expect(() => parseConfig({ integrations: { searchConsole: { property: "example.com" } } })).toThrow(/sc-domain/);
  });

  it("refuses GA4 and GTM together", () => {
    expect(() => parseConfig({ integrations: { ga4: { measurementId: "G-ABC123" }, gtm: { containerId: "GTM-ABC123" } } })).toThrow(/not both/);
  });

  it("adds nothing unless an ID is configured", () => {
    expect(analyticsTags(parseConfig({}))).toBeUndefined();
    expect(analyticsTags(parseConfig({ integrations: { ga4: {} } }))).toBeUndefined();
  });
});

describe("analytics tags", () => {
  it("sets consent defaults before config, first in <head>, skipping localhost", async () => {
    const root = copyFixture();
    withAnalytics(root, '{ ga4: { measurementId: "G-TEST123", events: { signup_click: { params: ["plan"] } } } }');
    await build(root);
    const html = fs.readFileSync(path.join(root, "dist", "index.html"), "utf8");
    const head = html.slice(html.indexOf("<head>"));
    const script = parse(html).querySelector("head script")!.rawText;
    expect(head.indexOf("<script>")).toBeLessThan(head.indexOf("<title>"));
    expect(script).toMatch(/^if\(!\/\^\(localhost/);
    expect(script.indexOf('gtag("consent","default",{"ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied","analytics_storage":"denied"})')).toBeLessThan(
      script.indexOf('gtag("config","G-TEST123")'),
    );
    expect(script).toContain("https://www.googletagmanager.com/gtag/js?id=");
    expect(head).toContain("window.vageConsent=");
  });

  it("adds the GTM noscript after <body>", async () => {
    const root = copyFixture();
    withAnalytics(root, '{ gtm: { containerId: "GTM-TEST12", consentDefault: "granted" } }');
    await build(root);
    const html = fs.readFileSync(path.join(root, "dist", "about", "index.html"), "utf8");
    expect(html).toMatch(/<body>\s*<noscript><iframe src="https:\/\/www.googletagmanager.com\/ns.html\?id=GTM-TEST12"/);
    expect(html).toContain('"analytics_storage":"granted"');
  });

  it("never adds analytics in the dev server", async () => {
    const root = copyFixture();
    withAnalytics(root, '{ ga4: { measurementId: "G-TEST123" } }');
    const server = await startDevServer(root, {});
    try {
      const html = await (await fetch(`${server.resolvedUrls!.local[0]}about/`)).text();
      expect(html).not.toContain("googletagmanager");
    } finally {
      await server.close();
    }
  });

  it("checks data-vage-event usage and duplicate tags", async () => {
    const root = copyFixture();
    withAnalytics(root, '{ ga4: { measurementId: "G-TEST123", events: { signup_click: { params: ["plan"] } } } }');
    write(
      root,
      "src/pages/index.md",
      '---\ntitle: Home\ndescription: Home.\n---\n# Home\n\n<a href="/about/" data-vage-event="signup_click" data-vage-param-plan="pro">ok</a>\n<a href="/about/" data-vage-event="signup_click" data-vage-param-tier="x">bad param</a>\n<a href="/about/" data-vage-event="unknown_evt">bad event</a>\n',
    );
    // A layout (trusted code) that also loads gtag: the integration then double-counts.
    write(root, "src/layouts/default.ts", 'export default ({ content }: { content: string }) => `<html lang="en"><head><title>t</title><script async src="https://www.googletagmanager.com/gtag/js?id=G-OTHER"></script></head><body><main>${content}</main></body></html>`;');
    const messages = (await check(root)).findings.filter((f) => f.page === "/").map((f) => `${f.rule}: ${f.message}`);
    expect(messages).toEqual([
      expect.stringMatching(/^analytics-duplicate: Page loads Google tags 2 times/),
      'analytics-event: Event "signup_click" has undeclared parameter "tier". Declare it in its params list.',
      'analytics-event: Event "unknown_evt" is not declared. Add it to integrations.ga4.events in vage.config.ts.',
    ]);
  });
});

describe("Google OAuth", () => {
  const tmpEnv = () => ({ VAGE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "vage-cfg-")) });

  /** Simulates Google redirecting the browser back to the loopback server. */
  function browser(overrides: Record<string, string> = {}) {
    let authUrl: URL | undefined;
    const open = (url: string) => {
      authUrl = new URL(url);
      const back = new URL(authUrl.searchParams.get("redirect_uri")!);
      back.search = new URLSearchParams({ code: "auth-code", state: authUrl.searchParams.get("state")!, ...overrides }).toString();
      void fetch(back);
    };
    return { open, url: () => authUrl! };
  }

  it("uses PKCE S256 on a loopback redirect, stores the refresh token privately", async () => {
    const env = tmpEnv();
    const b = browser();
    const bodies: URLSearchParams[] = [];
    const fetchMock = async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(new URLSearchParams(String(init!.body)));
      return json(200, { access_token: ACCESS, refresh_token: REFRESH, scope: SCOPES.gsc });
    };
    const creds = await connectGoogle({ scopes: [SCOPES.gsc], clientId: "cid", clientSecret: "csecret", open: b.open, env, http: { fetch: fetchMock } });

    const url = b.url();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(SCOPES.gsc);
    expect(bodies[0]!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bodies[0]!.get("grant_type")).toBe("authorization_code");

    expect(creds.refreshToken).toBe(REFRESH);
    const file = credentialsPath(env);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadCredentials(env)?.scopes).toEqual([SCOPES.gsc]);
  });

  it("ignores callbacks with the wrong state and reports a denied consent", async () => {
    const env = tmpEnv();
    let redirect = "";
    let state = "";
    const pending = connectGoogle({
      scopes: [SCOPES.gsc],
      clientId: "cid",
      env,
      open: (u) => {
        const url = new URL(u);
        redirect = url.searchParams.get("redirect_uri")!;
        state = url.searchParams.get("state")!;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((await fetch(`${redirect}/?code=evil&state=wrong`)).status).toBe(400);
    void fetch(`${redirect}/?error=access_denied&state=${state}`);
    await expect(pending).rejects.toThrow(/not granted \(access_denied\)/);
    expect(loadCredentials(env)).toBeUndefined();
  });

  it("requires every requested scope to be granted", async () => {
    const b = browser();
    const fetchMock = async () => json(200, { refresh_token: REFRESH, scope: "openid" });
    await expect(connectGoogle({ scopes: [SCOPES.ga4], clientId: "cid", open: b.open, env: tmpEnv(), http: { fetch: fetchMock } })).rejects.toThrow(
      /Access was not granted for: .*analytics.readonly/,
    );
  });

  it("refreshes access tokens and explains expired or missing connections", async () => {
    const env = tmpEnv();
    await expect(getAccessToken(SCOPES.gsc, "gsc", { env })).rejects.toThrow(/Not connected to Google. Run "vage connect gsc"/);
    const b = browser();
    await connectGoogle({ scopes: [SCOPES.gsc], clientId: "cid", open: b.open, env, http: { fetch: async () => json(200, { refresh_token: REFRESH, scope: SCOPES.gsc }) } });

    expect(await getAccessToken(SCOPES.gsc, "gsc", { env, http: { fetch: async () => json(200, { access_token: ACCESS }) } })).toBe(ACCESS);
    await expect(getAccessToken(SCOPES.ga4, "ga4", { env })).rejects.toThrow(/does not include ga4 access/);
    const expired = getAccessToken(SCOPES.gsc, "gsc", { env, http: { fetch: async () => json(400, { error: "invalid_grant", error_description: `Bad ${REFRESH}` }) } });
    await expect(expired).rejects.toThrow(/expired or was revoked/);
  });

  it("revokes at Google and deletes the local token, even if revocation fails", async () => {
    const env = tmpEnv();
    const b = browser();
    await connectGoogle({ scopes: [SCOPES.gsc], clientId: "cid", open: b.open, env, http: { fetch: async () => json(200, { refresh_token: REFRESH, scope: SCOPES.gsc }) } });
    let revokedBody = "";
    const result = await disconnectGoogle({ env, http: { fetch: async (_u, init) => ((revokedBody = String(init!.body)), json(200, {})) } });
    expect(result).toEqual({ hadConnection: true, revoked: true });
    expect(new URLSearchParams(revokedBody).get("token")).toBe(REFRESH);
    expect(fs.existsSync(credentialsPath(env))).toBe(false);

    const b2 = browser();
    await connectGoogle({ scopes: [SCOPES.gsc], clientId: "cid", open: b2.open, env, http: { fetch: async () => json(200, { refresh_token: REFRESH, scope: SCOPES.gsc }) } });
    const offline = await disconnectGoogle({ env, http: { fetch: async () => { throw new Error("offline"); }, sleep: noSleep } });
    expect(offline).toEqual({ hadConnection: true, revoked: false });
    expect(fs.existsSync(credentialsPath(env))).toBe(false);
  });
});

describe("Search Console and GA4 reports", () => {
  it("lists properties and queries top queries and pages with Pacific Time dates", async () => {
    const calls: { url: string; body?: unknown; auth?: string }[] = [];
    const fetchMock = async (u: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>)?.authorization });
      if (String(u).endsWith("/sites")) return json(200, { siteEntry: [{ siteUrl: "sc-domain:fixture.example", permissionLevel: "siteOwner" }] });
      return json(200, { rows: [{ keys: ["vage js"], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 }] });
    };
    expect(await listSites(ACCESS, { fetch: fetchMock })).toEqual([{ siteUrl: "sc-domain:fixture.example", permissionLevel: "siteOwner" }]);

    const report = await searchReport(ACCESS, "sc-domain:fixture.example", 28, { fetch: fetchMock, now: new Date("2026-10-23T05:00:00Z") });
    expect(report).toMatchObject({ startDate: "2026-09-25", endDate: "2026-10-22", queries: [{ key: "vage js", clicks: 3 }] });
    expect(calls[1]!.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Afixture.example/searchAnalytics/query");
    expect(calls[1]!.body).toEqual({ startDate: "2026-09-25", endDate: "2026-10-22", dimensions: ["query"], rowLimit: 25 });
    expect(calls[2]!.body).toMatchObject({ dimensions: ["page"] });
    expect(calls.every((c) => c.auth === `Bearer ${ACCESS}`)).toBe(true);
    expect(pacificDate(new Date("2026-03-08T12:00:00Z"), 0)).toBe("2026-03-08");
  });

  it("explains permission errors without leaking the token", async () => {
    const fetchMock = async () => json(403, { error: { message: `User does not have sufficient permission (${ACCESS})` } });
    const err = await searchReport(ACCESS, "sc-domain:x.example", 7, { fetch: fetchMock }).catch((e) => e);
    expect(err.message).toMatch(/HTTP 403.*\[redacted\].*No access to sc-domain:x.example/);
    expect(err.message).not.toContain(ACCESS);
  });

  it("runs a GA4 report of top pages", async () => {
    let body: Record<string, unknown> = {};
    const fetchMock = async (u: string | URL | Request, init?: RequestInit) => {
      expect(String(u)).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport");
      body = JSON.parse(String(init!.body));
      return json(200, { rows: [{ dimensionValues: [{ value: "/about/" }], metricValues: [{ value: "12" }, { value: "7" }, { value: "9" }] }] });
    };
    const report = await analyticsReport(ACCESS, "123456", 28, { fetch: fetchMock });
    expect(body).toMatchObject({ dateRanges: [{ startDate: "28daysAgo", endDate: "today" }], dimensions: [{ name: "pagePath" }] });
    expect(report.rows).toEqual([{ pagePath: "/about/", screenPageViews: 12, activeUsers: 7, sessions: 9 }]);
  });

  it("rejects malformed responses", async () => {
    await expect(analyticsReport(ACCESS, "1", 7, { fetch: async () => json(200, { rows: [{ nope: 1 }] }) })).rejects.toThrow();
  });
});
