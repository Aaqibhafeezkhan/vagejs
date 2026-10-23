/**
 * llms.txt (https://llmstxt.org) is an emerging convention. Publishing it does
 * not guarantee that any AI system reads, indexes or cites the site.
 */
export interface LlmsPage {
  title: string;
  url: string;
  description?: string;
  body: string;
}

/** Keeps a value on one line and stops it from forming Markdown links. */
const inline = (s: string) => s.replace(/\s+/g, " ").replace(/[[\]()<>]/g, (c) => `\\${c}`).trim();

export function llmsTxt(title: string, description: string | undefined, pages: LlmsPage[]): string {
  const lines = [`# ${inline(title)}`, ""];
  if (description) lines.push(`> ${inline(description)}`, "");
  lines.push("## Pages", "");
  for (const p of pages) lines.push(`- [${inline(p.title)}](${p.url.replace(/[()\s<>]/g, encodeURIComponent)})${p.description ? `: ${inline(p.description)}` : ""}`);
  return `${lines.join("\n")}\n`;
}

export function llmsFullTxt(title: string, description: string | undefined, pages: LlmsPage[]): string {
  const parts = [`# ${inline(title)}`];
  if (description) parts.push(`> ${inline(description)}`);
  for (const p of pages) parts.push(`---\n\nSource: ${p.url}\n\n${p.body.trim()}`);
  return `${parts.join("\n\n")}\n`;
}
