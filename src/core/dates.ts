/** A frontmatter date as a point in time ("2026-10-24" = midnight UTC); NaN when missing. */
export function instant(date: string | undefined): number {
  return date ? Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date) : NaN;
}
