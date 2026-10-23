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

export function llmsTxt(title: string, description: string | undefined, pages: LlmsPage[]): string {
  const lines = [`# ${title}`, ""];
  if (description) lines.push(`> ${description}`, "");
  lines.push("## Pages", "");
  for (const p of pages) lines.push(`- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ""}`);
  return `${lines.join("\n")}\n`;
}

export function llmsFullTxt(title: string, description: string | undefined, pages: LlmsPage[]): string {
  const parts = [`# ${title}`];
  if (description) parts.push(`> ${description}`);
  for (const p of pages) parts.push(`---\n\nSource: ${p.url}\n\n${p.body.trim()}`);
  return `${parts.join("\n\n")}\n`;
}
