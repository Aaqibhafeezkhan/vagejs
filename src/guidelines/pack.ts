import { createHash } from "node:crypto";
import raw from "./rule-pack.json" with { type: "json" };

/**
 * The rule pack: provider facts the framework relies on, each tied to official
 * sources. Changing it is a reviewed release (see docs/GUIDELINES.md); the
 * monitor only reports source changes and never edits it.
 */
export interface Source {
  id: string;
  provider: string;
  title: string;
  url: string;
  category: string;
  cadence: "daily" | "weekly";
  /** "manual": the page can't be read automatically (e.g. client-rendered). */
  monitor?: "manual";
}

export interface Rule {
  id: string;
  summary: string;
  behaviorChanging: boolean;
  sources: string[];
  implementedIn: string[];
  data?: Record<string, unknown>;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  summary: string;
  reviewedBy: string;
  contentHash: string;
}

export interface RulePack {
  version: string;
  released: string;
  sources: Source[];
  rules: Rule[];
  changelog: ChangelogEntry[];
}

export const rulePack = raw as RulePack;

export function ruleData<T>(id: string): T {
  const rule = rulePack.rules.find((r) => r.id === id);
  if (!rule?.data) throw new Error(`Rule pack ${rulePack.version} has no data for rule "${id}".`);
  return rule.data as T;
}

/** Hash of sources + rules (not the changelog), recorded in each changelog entry. */
export function packContentHash(pack: RulePack = rulePack): string {
  return createHash("sha256").update(JSON.stringify({ sources: pack.sources, rules: pack.rules })).digest("hex");
}
