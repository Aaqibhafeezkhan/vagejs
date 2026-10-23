import { ruleData } from "../guidelines/pack.js";

type Thresholds = Record<"lcp" | "inp" | "cls", { good: number; poor: number }>;
const T = ruleData<Thresholds>("vitals.thresholds");

/**
 * Core Web Vitals thresholds, assessed at the 75th percentile of real-user
 * page loads (rule pack "vitals.thresholds", source: https://web.dev/articles/vitals).
 */
export const VITALS = {
  lcp: { label: "LCP", unit: "ms", ...T.lcp },
  inp: { label: "INP", unit: "ms", ...T.inp },
  cls: { label: "CLS", unit: "", ...T.cls },
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
