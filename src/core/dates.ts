/**
 * The publish date of a page that isn't due yet, else undefined. A date ("2026-11-01")
 * is due from that day on the build machine's calendar (UTC on most CI); a datetime
 * with an offset ("2026-11-01T09:00:00+05:30") from that moment.
 */
export function scheduledFor(datePublished: string | undefined, now = new Date()): string | undefined {
  if (!datePublished) return undefined;
  if (datePublished.length === 10) return datePublished > localDate(now) ? datePublished : undefined;
  return Date.parse(datePublished) > now.getTime() ? datePublished : undefined;
}

/** The machine's local calendar date, YYYY-MM-DD: the day scheduledFor() treats as today. */
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** A frontmatter date as a point in time ("2026-10-24" = midnight UTC); NaN when missing. */
export function instant(date: string | undefined): number {
  return date ? Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date) : NaN;
}
