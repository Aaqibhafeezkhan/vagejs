import { Marked, type Token, type Tokens } from "marked";

const marked = new Marked({ gfm: true });

/** "/" -> "index.md", "/docs/cli/" -> "docs/cli.md". */
export function markdownCopyPath(route: string): string {
  return route === "/" ? "index.md" : `${route.slice(1, -1)}.md`;
}

/**
 * Page Markdown that is safe to publish as-is (Markdown copies, llms-full.txt):
 * - HTML comments are always removed: authors keep private notes in them, and the
 *   HTML page never shows them.
 * - Other raw HTML is removed unless every author is trusted (markdown.html "allow"),
 *   matching what the sanitizer strips from the HTML page (scripts, iframes, forms…).
 * - Relative link and image targets become absolute, so they work from the copy's own URL.
 * Code blocks and inline code are kept verbatim: they're text, not markup.
 */
export function publishableMarkdown(body: string, options: { route: string; origin?: string; keepHtml: boolean }): string {
  const base = `https://site.invalid${options.route}`;
  const absolute = (href: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(href)) return href;
    try {
      const u = new URL(href, base);
      return `${options.origin ?? ""}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return href;
    }
  };
  const drop = (t: Tokens.HTML | Tokens.Tag) => /^\s*<!--/.test(t.raw) || !options.keepHtml;

  let out = "";
  for (const token of marked.lexer(body)) {
    if (token.type === "html" && drop(token as Tokens.HTML)) continue;
    let raw = token.raw;
    marked.walkTokens([token], (t: Token) => {
      if (t.type === "html" && t !== token && drop(t as Tokens.Tag)) raw = raw.replace(t.raw, "");
      if ((t.type === "link" || t.type === "image") && t.href) {
        const abs = absolute(t.href);
        if (abs !== t.href) raw = raw.replace(`](${t.href}`, `](${abs}`);
      }
    });
    out += raw;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** The page as plain Markdown: the author's own H1 (or the title), the summary, then the body. */
export function markdownCopy(title: string, description: string | undefined, body: string): string {
  const own = /^#\s+(.+)\n+/.exec(body);
  const heading = own ? `# ${own[1]!.trim()}` : `# ${title}`;
  const rest = own ? body.slice(own[0].length) : body;
  return `${heading}\n\n${description ? `> ${description}\n\n` : ""}${rest.trim()}\n`;
}
