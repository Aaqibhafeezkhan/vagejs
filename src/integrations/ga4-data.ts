import { z } from "zod";
import { apiError, requestWithRetry, type HttpOptions } from "./http.js";

// https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
const API = "https://analyticsdata.googleapis.com/v1beta";

export interface AnalyticsRow {
  pagePath: string;
  screenPageViews: number;
  activeUsers: number;
  sessions: number;
}

const METRICS = ["screenPageViews", "activeUsers", "sessions"] as const;

const responseSchema = z.object({
  rows: z
    .array(
      z.object({
        dimensionValues: z.array(z.object({ value: z.string() })),
        metricValues: z.array(z.object({ value: z.string() })),
      }),
    )
    .default([]),
});

/** Top pages by views for the last `days` days. */
export async function analyticsReport(token: string, propertyId: string, days: number, opts?: HttpOptions): Promise<{ propertyId: string; days: number; rows: AnalyticsRow[] }> {
  const res = await requestWithRetry(
    "Google Analytics Data API",
    `${API}/properties/${encodeURIComponent(propertyId)}:runReport`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
        dimensions: [{ name: "pagePath" }],
        metrics: METRICS.map((name) => ({ name })),
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: 25,
      }),
    },
    [token],
    opts,
  );
  if (!res.ok) {
    throw await apiError("Google Analytics Data API", res, [token], {
      403: `No access to GA4 property ${propertyId}. Check integrations.ga4.propertyId and that your Google account can view it.`,
    });
  }
  const rows = responseSchema.parse(await res.json()).rows.map((r) => ({
    pagePath: r.dimensionValues[0]?.value ?? "",
    screenPageViews: Number(r.metricValues[0]?.value ?? 0),
    activeUsers: Number(r.metricValues[1]?.value ?? 0),
    sessions: Number(r.metricValues[2]?.value ?? 0),
  }));
  return { propertyId, days, rows };
}
