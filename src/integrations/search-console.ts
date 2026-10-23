import { z } from "zod";
import { apiError, requestWithRetry, type HttpOptions } from "./http.js";

// https://developers.google.com/webmaster-tools/v1/searchanalytics/query
const API = "https://www.googleapis.com/webmasters/v3";

export interface SearchRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchReport {
  property: string;
  startDate: string;
  endDate: string;
  queries: SearchRow[];
  pages: SearchRow[];
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

export async function listSites(token: string, opts?: HttpOptions): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const res = await requestWithRetry("Search Console API", `${API}/sites`, { headers: auth(token) }, [token], opts);
  if (!res.ok) throw await apiError("Search Console API", res, [token]);
  const body = z.object({ siteEntry: z.array(z.object({ siteUrl: z.string(), permissionLevel: z.string() })).default([]) }).parse(await res.json());
  return body.siteEntry;
}

const rowsSchema = z.object({
  rows: z
    .array(z.object({ keys: z.array(z.string()), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() }))
    .default([]),
});

/** Top queries and pages for the last `days` days (Pacific Time dates, finalized data only). */
export async function searchReport(token: string, property: string, days: number, opts: HttpOptions & { now?: Date } = {}): Promise<SearchReport> {
  const endDate = pacificDate(opts.now ?? new Date(), 0);
  const startDate = pacificDate(opts.now ?? new Date(), days - 1);
  const query = async (dimension: "query" | "page") => {
    const res = await requestWithRetry(
      "Search Console API",
      `${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ startDate, endDate, dimensions: [dimension], rowLimit: 25 }) },
      [token],
      opts,
    );
    if (!res.ok) {
      throw await apiError("Search Console API", res, [token], {
        403: `No access to ${property}. Check the property name with "vage connect gsc" and that your Google account can view it.`,
      });
    }
    return rowsSchema.parse(await res.json()).rows.map(({ keys, ...m }) => ({ key: keys[0] ?? "", ...m }));
  };
  return { property, startDate, endDate, queries: await query("query"), pages: await query("page") };
}

/** YYYY-MM-DD in America/Los_Angeles, `daysBack` days before `now`. Search Console dates are Pacific Time. */
export function pacificDate(now: Date, daysBack: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}
