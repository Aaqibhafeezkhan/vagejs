import { z } from "zod";
import { VageError } from "../core/errors.js";
import { rate, type Rating, type VitalName } from "./vitals.js";

export type Strategy = "mobile" | "desktop";
type Fetch = typeof fetch;

export interface RemoteOptions {
  fetch?: Fetch;
  /** Waits between retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CRUX_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch with retries for rate limits and transient errors. The API key is sent
 * as a header (x-goog-api-key) so it never appears in URLs, and any error text
 * is scrubbed of it before being shown.
 */
async function request(service: string, url: string, init: RequestInit, key: string | undefined, opts: RemoteOptions): Promise<Response | undefined> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 3;
  const headers = { ...(init.headers as Record<string, string>), ...(key ? { "x-goog-api-key": key } : {}) };
  let lastError = "";

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await doFetch(url, { ...init, headers, signal: AbortSignal.timeout(120_000) });
      if (res.ok || !RETRY_STATUS.has(res.status) || i === attempts) return res;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
      if (i === attempts) throw new VageError(redact(`${service} request failed after ${attempts} attempts: ${lastError}`, key));
    }
    await sleep(1000 * 2 ** (i - 1));
  }
  return undefined;
}

async function apiError(service: string, res: Response, key: string | undefined): Promise<VageError> {
  let detail = "";
  try {
    detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    // Non-JSON error body; the status is enough.
  }
  const hint =
    res.status === 429
      ? " Rate limited: wait and retry, or use an API key with quota."
      : res.status === 400 || res.status === 403
        ? " Check the URL is public and the API key has this API enabled."
        : "";
  return new VageError(redact(`${service} returned HTTP ${res.status}${detail ? `: ${detail.replace(/\.+$/, "")}` : ""}.${hint}`, key));
}

export function redact(text: string, key: string | undefined): string {
  return key ? text.split(key).join("[redacted]") : text;
}

// ---------------------------------------------------------------- PageSpeed Insights (lab)

const CATEGORY_IDS = ["performance", "accessibility", "seo", "best-practices"] as const;

const psiSchema = z.object({
  lighthouseResult: z.object({
    lighthouseVersion: z.string(),
    fetchTime: z.string(),
    finalDisplayedUrl: z.string().optional(),
    categories: z.record(z.string(), z.object({ score: z.number().nullable() })),
    audits: z.record(
      z.string(),
      z.object({ title: z.string(), score: z.number().nullable().optional(), numericValue: z.number().optional(), displayValue: z.string().optional() }),
    ),
  }),
});

export interface LabReport {
  source: "pagespeed-insights" | "lighthouse";
  url: string;
  strategy: Strategy;
  fetchTime: string;
  toolVersion: string;
  /** 0-100, or null when the tool returned no score. */
  scores: Record<(typeof CATEGORY_IDS)[number], number | null>;
  metrics: { lcpMs?: number; cls?: number; tbtMs?: number; fcpMs?: number; speedIndexMs?: number };
  /** Lowest-scoring audits, most impactful first. */
  opportunities: { id: string; title: string; displayValue?: string }[];
}

/** Normalizes a Lighthouse result (from PSI or a local run). */
export function labReport(lhr: z.infer<typeof psiSchema>["lighthouseResult"], source: LabReport["source"], url: string, strategy: Strategy): LabReport {
  const score = (id: string) => {
    const s = lhr.categories[id]?.score;
    return s === null || s === undefined ? null : Math.round(s * 100);
  };
  const num = (id: string) => lhr.audits[id]?.numericValue;
  const opportunities = Object.entries(lhr.audits)
    .filter(([, a]) => typeof a.score === "number" && a.score < 0.9 && a.displayValue)
    .sort(([, a], [, b]) => (a.score ?? 1) - (b.score ?? 1))
    .slice(0, 8)
    .map(([id, a]) => ({ id, title: a.title, displayValue: a.displayValue }));
  return {
    source,
    url,
    strategy,
    fetchTime: lhr.fetchTime,
    toolVersion: `lighthouse ${lhr.lighthouseVersion}`,
    scores: {
      performance: score("performance"),
      accessibility: score("accessibility"),
      seo: score("seo"),
      "best-practices": score("best-practices"),
    },
    metrics: {
      lcpMs: num("largest-contentful-paint"),
      cls: num("cumulative-layout-shift"),
      tbtMs: num("total-blocking-time"),
      fcpMs: num("first-contentful-paint"),
      speedIndexMs: num("speed-index"),
    },
    opportunities,
  };
}

export async function pageSpeed(url: string, strategy: Strategy, key: string | undefined, opts: RemoteOptions = {}): Promise<LabReport> {
  const params = new URLSearchParams({ url, strategy: strategy.toUpperCase() });
  for (const c of CATEGORY_IDS) params.append("category", c.toUpperCase().replace("-", "_"));
  const res = await request("PageSpeed Insights", `${PSI_ENDPOINT}?${params}`, { method: "GET" }, key, opts);
  if (!res?.ok) throw await apiError("PageSpeed Insights", res!, key);
  const parsed = psiSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new VageError("PageSpeed Insights returned an unexpected response (no lighthouseResult).");
  return labReport(parsed.data.lighthouseResult, "pagespeed-insights", url, strategy);
}

// ---------------------------------------------------------------- CrUX (field)

const cruxSchema = z.object({
  record: z.object({
    metrics: z.record(z.string(), z.object({ percentiles: z.object({ p75: z.union([z.number(), z.string()]) }) })),
    collectionPeriod: z
      .object({
        firstDate: z.object({ year: z.number(), month: z.number(), day: z.number() }),
        lastDate: z.object({ year: z.number(), month: z.number(), day: z.number() }),
      })
      .optional(),
  }),
});

export interface FieldReport {
  source: "crux";
  /** "url" when page-level data exists, otherwise "origin". */
  scope: "url" | "origin";
  formFactor: "PHONE" | "DESKTOP";
  collectionPeriod?: string;
  metrics: Partial<Record<VitalName, { p75: number; rating: Rating }>>;
}

const CRUX_METRICS: Record<string, VitalName> = {
  largest_contentful_paint: "lcp",
  interaction_to_next_paint: "inp",
  cumulative_layout_shift: "cls",
};

/**
 * Queries the CrUX API for the page, falling back to the origin. Returns
 * undefined when neither has data. A 404 is treated as "no data"; the API
 * docs do not specify this response, so it is an observed-behavior assumption.
 */
export async function cruxField(url: string, strategy: Strategy, key: string, opts: RemoteOptions = {}): Promise<FieldReport | undefined> {
  const formFactor = strategy === "mobile" ? "PHONE" : "DESKTOP";
  for (const scope of ["url", "origin"] as const) {
    const body = { [scope]: scope === "url" ? url : new URL(url).origin, formFactor, metrics: Object.keys(CRUX_METRICS) };
    const res = await request("CrUX API", CRUX_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, key, opts);
    if (res?.status === 404) continue;
    if (!res?.ok) throw await apiError("CrUX API", res!, key);
    const parsed = cruxSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new VageError("CrUX API returned an unexpected response (no record.metrics).");
    const metrics: FieldReport["metrics"] = {};
    for (const [apiName, name] of Object.entries(CRUX_METRICS)) {
      const raw = parsed.data.record.metrics[apiName]?.percentiles.p75;
      if (raw === undefined) continue;
      const p75 = Number(raw); // CLS is a string-encoded double
      if (Number.isFinite(p75)) metrics[name] = { p75, rating: rate(name, p75) };
    }
    const period = parsed.data.record.collectionPeriod;
    const date = (d: { year: number; month: number; day: number }) =>
      `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
    return { source: "crux", scope, formFactor, metrics, collectionPeriod: period && `${date(period.firstDate)} to ${date(period.lastDate)}` };
  }
  return undefined;
}
