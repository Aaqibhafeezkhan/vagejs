const ABSOLUTE = /^https?:\/\//i;

/** Resolves a site path against the configured origin. Absolute URLs pass through. */
export function absoluteUrl(site: string | undefined, pathOrUrl: string): string | undefined {
  if (ABSOLUTE.test(pathOrUrl)) return pathOrUrl;
  return site ? new URL(pathOrUrl, site).href : undefined;
}

export function isAbsoluteUrl(value: string): boolean {
  return ABSOLUTE.test(value);
}
