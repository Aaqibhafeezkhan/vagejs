/**
 * Core Web Vitals thresholds, assessed at the 75th percentile of real-user
 * page loads. Source: https://web.dev/articles/vitals (good / needs improvement / poor).
 */
export const VITALS = {
  lcp: { label: "LCP", unit: "ms", good: 2500, poor: 4000 },
  inp: { label: "INP", unit: "ms", good: 200, poor: 500 },
  cls: { label: "CLS", unit: "", good: 0.1, poor: 0.25 },
} as const;

export type VitalName = keyof typeof VITALS;
export type Rating = "good" | "needs-improvement" | "poor";

export function rate(metric: VitalName, p75: number): Rating {
  const t = VITALS[metric];
  return p75 <= t.good ? "good" : p75 <= t.poor ? "needs-improvement" : "poor";
}

export const LAB_VS_FIELD =
  "Lab results (Lighthouse/PageSpeed) are a single simulated load and vary between runs. " +
  "Field data (CrUX) reflects real Chrome users at the 75th percentile over 28 days and is " +
  "unavailable for pages or sites without enough traffic. Google's Core Web Vitals assessment uses field data.";
