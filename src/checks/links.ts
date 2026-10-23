import path from "node:path";
import { VageError } from "../core/errors.js";
import { createBuildLoader } from "../core/loader.js";
import { renderSite } from "../core/site.js";
import { outboundHosts, readLinkLock, writeLinkLock } from "./integrity.js";

export interface LinkStatus {
  /** External domains the site links to now, with how many pages link there, and whether they're approved. */
  domains: { domain: string; pages: string[]; approved: boolean }[];
  /** Approved domains the site no longer links to. */
  unused: string[];
  hasLock: boolean;
}

export async function linkStatus(root: string): Promise<LinkStatus> {
  root = path.resolve(root);
  const loader = await createBuildLoader(root);
  try {
    const model = await renderSite(root, loader.load);
    const hosts = outboundHosts(model);
    const lock = readLinkLock(root);
    const approved = new Set(lock?.domains ?? []);
    return {
      domains: [...hosts].map(([domain, pages]) => ({ domain, pages: pages.map((p) => p.route), approved: approved.has(domain) })),
      unused: [...approved].filter((d) => !hosts.has(d)).sort(),
      hasLock: lock !== undefined,
    };
  } finally {
    await loader.close();
  }
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The lock file's domains after approving `add` (and, with `prune`, dropping unused ones). */
export function nextLock(status: LinkStatus, current: string[], add: string[], prune: boolean): string[] {
  for (const d of add) {
    if (!HOSTNAME.test(d)) throw new VageError(`"${d}" is not a domain name. Use a host like example.com (no https://, no path).`);
  }
  const keep = prune ? current.filter((d) => !status.unused.includes(d)) : current;
  return [...new Set([...keep, ...add])].sort();
}

export { readLinkLock, writeLinkLock };
