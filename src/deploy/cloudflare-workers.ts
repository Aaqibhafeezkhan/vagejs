import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteConfig } from "../core/config.js";
import { VageError } from "../core/errors.js";
import { publicPath } from "../core/routes.js";
import { redact } from "../integrations/http.js";
import { WRANGLER } from "./cloudflare-pages.js";
import type { DeployStatus, Runner } from "./github-pages.js";
import { runCommand } from "./github-pages.js";

/** In wrangler's own lookup order. */
export const WRANGLER_CONFIGS = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];

/** Compatibility date for the generated config; Workers static assets need nothing newer. Checked 2026-10-23. */
export const COMPATIBILITY_DATE = "2026-10-01";

/** What vagejs needs to know from a project's own wrangler config. */
export interface WranglerConfig {
  file: string;
  name?: string;
  /** assets.directory, resolved against the project root. */
  assetsDir?: string;
  notFoundHandling?: string;
}

/**
 * Reads name and assets settings from the project's wrangler config. Refuses setups where
 * wrangler could pick a different file or Worker than the one shown: several config files,
 * a CLOUDFLARE_ENV environment, or a .wrangler/deploy redirect.
 */
export function readWranglerConfig(root: string, env: Record<string, string | undefined> = process.env): WranglerConfig | undefined {
  const present = WRANGLER_CONFIGS.filter((f) => fs.existsSync(path.join(root, f)));
  if (present.length > 1) throw new VageError(`Found ${present.join(" and ")}. Keep one wrangler config so it's clear which Worker gets deployed.`);
  if (fs.existsSync(path.join(root, ".wrangler", "deploy", "config.json"))) {
    throw new VageError(".wrangler/deploy/config.json redirects wrangler to another config. Remove it, or deploy with wrangler directly.");
  }
  const file = present[0];
  if (!file) return undefined;
  if (env.CLOUDFLARE_ENV) throw new VageError(`CLOUDFLARE_ENV="${env.CLOUDFLARE_ENV}" makes wrangler deploy that environment's Worker. Unset it to deploy with vagejs.`);
  const text = fs.readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "");
  let name: unknown, dir: unknown, nf: unknown;
  if (file.endsWith(".toml")) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$|^\s*#.*$/, ""));
    const header = (l: string) => /^\s*\[/.test(l);
    const firstHeader = lines.findIndex(header);
    const top = firstHeader === -1 ? lines : lines.slice(0, firstHeader);
    const assetsStart = lines.findIndex((l) => /^\s*\[assets\]\s*$/.test(l));
    const assetsEnd = assetsStart === -1 ? -1 : lines.findIndex((l, i) => i > assetsStart && header(l));
    const assets = assetsStart === -1 ? [] : lines.slice(assetsStart + 1, assetsEnd === -1 ? undefined : assetsEnd);
    const value = (block: string[], key: string) => {
      for (const l of block) {
        const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*$`).exec(l);
        if (m) return m[1] ?? m[2];
      }
      return undefined;
    };
    name = value(top, "name");
    dir = value(assets, "directory");
    nf = value(assets, "not_found_handling");
    const inline = top.map((l) => /^\s*assets\s*=\s*\{(.*)\}\s*$/.exec(l)?.[1]).find(Boolean);
    if (inline) {
      dir ??= /directory\s*=\s*"([^"]*)"/.exec(inline)?.[1];
      nf ??= /not_found_handling\s*=\s*"([^"]*)"/.exec(inline)?.[1];
    }
  } else {
    let data: { name?: unknown; assets?: { directory?: unknown; not_found_handling?: unknown } };
    try {
      data = JSON.parse(stripJsonComments(text));
    } catch (err) {
      throw new VageError(`Could not read ${file}: ${(err as Error).message}`, path.join(root, file));
    }
    ({ name } = data);
    dir = data.assets?.directory;
    nf = data.assets?.not_found_handling;
  }
  return {
    file,
    name: typeof name === "string" ? name : undefined,
    assetsDir: typeof dir === "string" ? path.resolve(root, dir) : undefined,
    notFoundHandling: typeof nf === "string" ? nf : undefined,
  };
}

/** JSONC to JSON: drops // and /* *\/ comments and trailing commas outside strings. */
function stripJsonComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      const str = m ? m[0] : text.slice(i);
      out += str;
      i += str.length - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else if (c === "," && /^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(text.slice(i + 1))) {
      // trailing comma: drop it
    } else out += c;
  }
  return out;
}

/** The contact form Worker shipped with vagejs (dist/worker/contact.js). */
export const CONTACT_WORKER = fileURLToPath(new URL("../worker/contact.js", import.meta.url));

type Contact = NonNullable<SiteConfig["contact"]>;

/** Settings the contact Worker reads, passed with --var so a project's own config doesn't have to repeat them. */
export function contactVars(contact: Contact, siteTitle: string | undefined): string[] {
  const vars = { CONTACT_TO: contact.to, CONTACT_FROM: contact.from, CONTACT_PATH: contact.path, CONTACT_SENT: contact.sent, CONTACT_FAILED: contact.failed, CONTACT_SITE: siteTitle };
  return Object.entries(vars).flatMap(([k, v]) => (v ? ["--var", `${k}:${v}`] : []));
}

/**
 * The rate limit's namespace, from the Worker name: namespaces are per account, so two
 * sites on one account must not share a counter.
 */
export function rateLimitNamespace(worker: string): string {
  let h = 2166136261;
  for (const c of worker) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return String(1000 + (h % 1_000_000));
}

/** The bindings the contact Worker needs, for the generated config or to show the owner. */
export function contactBindings(contact: Contact, worker: string) {
  return {
    main: CONTACT_WORKER,
    // Both address forms: a form may post to "/contact" on a trailingSlash "never" site.
    assets: { binding: "ASSETS", run_worker_first: [contact.path, contact.path.slice(0, -1)] },
    send_email: [{ name: "EMAIL", destination_address: contact.to }],
    ratelimits: [{ name: "CONTACT_LIMIT", namespace_id: rateLimitNamespace(worker), simple: { limit: contact.perMinute, period: 60 } }],
  };
}

/** What a project's own wrangler config lacks for the contact form, read from its actual settings. */
export function contactConfigProblem(root: string, file: string, contact: Contact, worker = ""): string | undefined {
  const text = fs.readFileSync(path.join(root, file), "utf8").replace(/^\uFEFF/, "");
  let main: unknown, binding: unknown, first: unknown, email: unknown;
  if (file.endsWith(".toml")) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$|^\s*#.*$/, ""));
    const value = (key: string, block: string[]) => block.map((l) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(l)?.[1]).find(Boolean);
    const section = (header: RegExp) => {
      const start = lines.findIndex((l) => header.test(l));
      if (start === -1) return [];
      const end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
      return lines.slice(start + 1, end === -1 ? undefined : end);
    };
    const top = lines.slice(0, Math.max(0, lines.findIndex((l) => /^\s*\[/.test(l)))) ;
    const unquote = (v: string | undefined) => v?.replace(/^["']|["']$/g, "");
    main = unquote(value("main", top));
    binding = unquote(value("binding", section(/^\s*\[assets\]\s*$/)));
    const firstRaw = value("run_worker_first", section(/^\s*\[assets\]\s*$/));
    first = firstRaw && /^\[/.test(firstRaw) ? [...firstRaw.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]) : firstRaw === "true" ? true : undefined;
    const sendBlock = section(/^\s*\[\[send_email\]\]\s*$/);
    email = sendBlock.length ? [{ name: unquote(value("name", sendBlock)), destination_address: unquote(value("destination_address", sendBlock)) }] : undefined;
  } else {
    let data: { main?: unknown; assets?: { binding?: unknown; run_worker_first?: unknown }; send_email?: unknown };
    try {
      data = JSON.parse(stripJsonComments(text));
    } catch {
      return undefined; // readWranglerConfig already reports unreadable files
    }
    ({ main } = data);
    binding = data.assets?.binding;
    first = data.assets?.run_worker_first;
    email = data.send_email;
  }
  const routed = first === true || (Array.isArray(first) && first.some((p) => p === contact.path || p === `${contact.path}*`));
  const sends = Array.isArray(email) && email.some((b: { name?: unknown; destination_address?: unknown }) => b?.name === "EMAIL" && (b.destination_address === undefined || b.destination_address === contact.to));
  const missing = [
    !(typeof main === "string" && /vagejs\/dist\/worker\/contact\.js$/.test(main)) && `"main": "node_modules/vagejs/dist/worker/contact.js"`,
    binding !== "ASSETS" && `"binding": "ASSETS" under "assets"`,
    !routed && `"run_worker_first": ["${contact.path}"] under "assets"`,
    !sends && `"send_email": [{ "name": "EMAIL", "destination_address": "${contact.to}" }]`,
  ].filter(Boolean);
  const limit = `"ratelimits": [{ "name": "CONTACT_LIMIT", "namespace_id": "${rateLimitNamespace(worker)}", "simple": { "limit": ${contact.perMinute}, "period": 60 } }]`;
  return missing.length ? `${file} needs these for the contact form: ${missing.join("; ")}. (The rate limit is optional: ${limit}.)` : undefined;
}

export interface WorkersPlan {
  /** The Worker that will actually be deployed. */
  worker: string;
  /** vage.config.ts contact settings, when the site has a contact form. */
  contact?: Contact;
  siteTitle?: string;
  /** The project's wrangler config, if it has one. */
  config?: WranglerConfig;
  warnings: string[];
}

/**
 * Decides which Worker gets deployed, and refuses setups where the plan and what
 * wrangler would actually do differ (another Worker name, or a folder other than dist/).
 */
export function planWorkersDeploy(root: string, requested: string | undefined, site: Partial<Pick<SiteConfig, "contact" | "title" | "trailingSlash">> = {}): WorkersPlan {
  const config = readWranglerConfig(root);
  const warnings: string[] = [];
  // The result pages in the site's address form, so the redirect after sending lands without another hop.
  const contact = site.contact && { ...site.contact, sent: publicPath(site.contact.sent, site.trailingSlash ?? "always"), failed: publicPath(site.contact.failed, site.trailingSlash ?? "always") };
  const extra = { contact, siteTitle: site.title };
  if (!config) {
    if (!requested) throw new VageError("No Worker name. Pass --project <name>, set deploy.cloudflareWorker, or add a wrangler.jsonc.");
    return { worker: requested, warnings, ...extra };
  }
  const problem = site.contact && contactConfigProblem(root, config.file, site.contact, config.name);
  if (problem) throw new VageError(problem, path.join(root, config.file));
  if (!config.name) throw new VageError(`${config.file} has no "name". Add the Worker's name there.`, path.join(root, config.file));
  if (requested && requested !== config.name) {
    throw new VageError(
      `${config.file} deploys the Worker "${config.name}", but this deploy asks for "${requested}". ` +
        `Make them match (deploy.cloudflareWorker / --project, or "name" in ${config.file}); vagejs won't deploy a different Worker than it shows.`,
    );
  }
  const dist = path.join(root, "dist");
  if (config.assetsDir !== dist) {
    throw new VageError(
      `${config.file} must serve the built site: set assets.directory to "dist" (it is ${config.assetsDir ? `"${path.relative(root, config.assetsDir) || "."}"` : "not set"}).`,
      path.join(root, config.file),
    );
  }
  if (config.notFoundHandling !== "404-page" && fs.existsSync(path.join(root, "src", "pages", "404.md"))) {
    warnings.push(`${config.file}: add "not_found_handling": "404-page" under "assets", or unknown URLs get an empty 404 instead of your 404 page.`);
  }
  return { worker: config.name, config, warnings, ...extra };
}

export interface WorkersDeployment extends DeployStatus {
  worker: string;
  /** How it was deployed: a new version switched to 100% (existing Worker), or a full first deploy. */
  mode?: "version" | "first-deploy";
  versionId?: string;
}

/**
 * Deploys dist/ as a Cloudflare Worker with static assets (what Cloudflare now creates
 * instead of Pages projects; `_headers` and `_redirects` still apply).
 *
 * - With a wrangler config in the project (needed for custom domains and routes), that
 *   file is used as-is; `planWorkersDeploy` has already checked its name and folder.
 *   Otherwise a temporary config pointing at dist/ is generated, so the project gains no files.
 * - Existing Workers get `wrangler versions upload` + `versions deploy <id>@100%`: the new
 *   version takes all traffic without re-applying routes or custom domains, so the site
 *   stays up. Only Cloudflare's "Worker doesn't exist" error leads to a first `wrangler deploy`.
 * - Success needs wrangler to succeed AND the live site to answer 200: `siteUrl` when set,
 *   else the Worker's workers.dev URL (never a version preview URL).
 */
export async function deployCloudflareWorkers(
  root: string,
  options: {
    plan: WorkersPlan;
    tag?: string;
    siteUrl?: string;
    run?: Runner;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    env?: Record<string, string | undefined>;
  },
): Promise<WorkersDeployment> {
  const run = options.run ?? runCommand;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const secrets = [(options.env ?? process.env).CLOUDFLARE_API_TOKEN];
  const { worker } = options.plan;

  let tempDir: string | undefined;
  // Always name the config file, so wrangler can't pick another one (e.g. in a parent folder).
  const configArgs: string[] = options.plan.config ? ["--config", path.join(root, options.plan.config.file)] : [];
  if (!options.plan.config) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vage-wrangler-"));
    const contact = options.plan.contact && contactBindings(options.plan.contact, worker);
    const config = {
      name: worker,
      compatibility_date: COMPATIBILITY_DATE,
      ...(contact && { main: contact.main, send_email: contact.send_email, ratelimits: contact.ratelimits }),
      assets: { directory: path.join(root, "dist"), not_found_handling: "404-page", ...(contact?.assets ?? {}) },
    };
    fs.writeFileSync(path.join(tempDir, "wrangler.json"), JSON.stringify(config, null, 2));
    configArgs.push("--config", path.join(tempDir, "wrangler.json"));
  }

  try {
    const vars = options.plan.contact ? contactVars(options.plan.contact, options.plan.siteTitle) : [];
    const wrangler = (...args: string[]) => run("npx", ["--yes", WRANGLER, ...args, ...(args[0] === "versions" && args[1] === "deploy" ? [] : vars), ...configArgs], root);
    const out = (r: { stdout: string; stderr: string }) => redact(`${r.stdout}\n${r.stderr}`, secrets);
    const failReason = (code: number, text: string) => {
      const auth = /auth|login|token|unauthori[sz]ed|10000/i.test(text) ? " Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or run `npx wrangler login`." : "";
      return `wrangler failed (exit ${code}).${auth}\n${tail(text)}`;
    };

    let mode: WorkersDeployment["mode"] = "version";
    let versionId: string | undefined;
    let output: string;
    const tag = options.tag ?? `vage-${Date.now()}`;
    const upload = await wrangler("versions", "upload", "--tag", tag);
    output = out(upload);
    if (upload.code !== 0) {
      // Only a Worker that doesn't exist yet gets a full deploy (which also attaches routes).
      // wrangler 4.152 says "...a new version of a Worker that does not yet exist" (no code).
      if (!/\b10007\b|worker[^\n]*(?:does not (?:yet )?exist|not found)/i.test(output)) return { status: "failure", worker, reason: failReason(upload.code, output) };
      mode = "first-deploy";
      const first = await wrangler("deploy");
      output = out(first);
      if (first.code !== 0) return { status: "failure", worker, mode, reason: failReason(first.code, output) };
    } else {
      versionId = /Version ID:\s*([0-9a-f-]{36})/i.exec(output)?.[1];
      if (!versionId) return { status: "failure", worker, reason: `wrangler uploaded but printed no version ID.\n${tail(output)}` };
      const switched = await wrangler("versions", "deploy", `${versionId}@100%`, "--yes");
      if (switched.code !== 0) return { status: "failure", worker, versionId, reason: `Version ${versionId} uploaded but not deployed. ${failReason(switched.code, out(switched))}` };
      output += `\n${out(switched)}`;
    }

    // Lines mentioning "preview" carry version preview URLs, which show the new version even when the live site doesn't.
    const workersDev = output
      .split("\n")
      .filter((line) => !/preview/i.test(line))
      .join("\n")
      .match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/gi)
      ?.at(-1);
    const pageUrl = options.siteUrl ?? workersDev;
    if (!pageUrl) return { status: "unconfirmed", worker, mode, versionId, reason: "Deployed, but there is no URL to check: set `site` in vage.config.ts." };
    for (let i = 0; i < 5; i++) {
      const page = await doFetch(pageUrl, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
      if (page?.ok) return { status: "success", worker, mode, versionId, pageUrl };
      await sleep(3000);
    }
    // `site` may not point at this Worker yet (a new domain, or a typo): say where the Worker itself answers.
    const own = workersDev && workersDev !== pageUrl ? ` The Worker itself is at ${workersDev}. If ${pageUrl} is your own domain, attach it to the Worker (routes or a custom domain in your wrangler config).` : "";
    return { status: "unconfirmed", worker, mode, versionId, pageUrl, reason: `Deployed, but ${pageUrl} did not respond with 200 yet. Check it in a minute.${own}` };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-8).join("\n");
}
