const ABSOLUTE = /^https?:\/\//i;

/** Resolves a site path against the configured origin. Absolute URLs pass through. */
export function absoluteUrl(site: string | undefined, pathOrUrl: string): string | undefined {
  if (ABSOLUTE.test(pathOrUrl)) return pathOrUrl;
  if (!site) return undefined;
  // A site in a subfolder keeps it: "/about/" on https://owner.github.io/repo -> .../repo/about/.
  return pathOrUrl.startsWith("/") && !pathOrUrl.startsWith("//") ? new URL(site + pathOrUrl).href : new URL(pathOrUrl, `${site}/`).href;
}

export function isAbsoluteUrl(value: string): boolean {
  return ABSOLUTE.test(value);
}
