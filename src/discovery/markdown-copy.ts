/** "/" -> "index.md", "/docs/cli/" -> "docs/cli.md". */
export function markdownCopyPath(route: string): string {
  return route === "/" ? "index.md" : `${route.slice(1, -1)}.md`;
}

/** The page as plain Markdown: title, summary, then the body as written (frontmatter removed). */
export function markdownCopy(title: string, description: string | undefined, body: string): string {
  return `# ${title}\n\n${description ? `> ${description}\n\n` : ""}${body.replace(/^\s*#\s+.*\n+/, "").trim()}\n`;
}
