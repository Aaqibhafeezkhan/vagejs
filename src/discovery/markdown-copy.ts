import TurndownService from "turndown";

/** "/" -> "index.md", "/docs/cli/" -> "docs/cli.md". */
export function markdownCopyPath(route: string): string {
  return route === "/" ? "index.md" : `${route.slice(1, -1)}.md`;
}

let jsdom: typeof import("jsdom") | undefined;
let service: TurndownService | undefined;

function converter(): TurndownService {
  if (service) return service;
  service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
  // Never carry executable or embedded content into the copy, even from trusted HTML.
  service.remove(["script", "style", "noscript", "template", "iframe", "object", "embed", "form", "button", "input", "select", "textarea"]);
  // Simple GFM tables (one header row, plain cells).
  const cell = (s: string) => s.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
  service.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const rows = [...(node as HTMLTableElement).querySelectorAll("tr")].map((tr) =>
        [...tr.querySelectorAll("th, td")].map((c) => cell(service!.turndown((c as HTMLElement).innerHTML))),
      );
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return `\n\n${[line(rows[0]!), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n\n`;
    },
  });
  return service;
}

/**
 * The page as Markdown, converted from its rendered, sanitized HTML: the copy contains
 * exactly what the page shows (no comments, no raw HTML the sanitizer removed, the same
 * links the link lock checked), with links and images made absolute.
 */
export async function htmlToMarkdown(html: string, options: { route: string; origin?: string }): Promise<string> {
  jsdom ??= await import("jsdom");
  const doc = new jsdom.JSDOM("").window.document;
  const template = doc.createElement("template");
  template.innerHTML = html;
  const base = `https://site.invalid${options.route}`;
  const absolute = (value: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return value;
    try {
      const u = new URL(value, base);
      return `${options.origin ?? ""}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return value;
    }
  };
  for (const a of template.content.querySelectorAll("a[href]")) a.setAttribute("href", absolute(a.getAttribute("href")!));
  for (const img of template.content.querySelectorAll("img[src]")) {
    img.setAttribute("src", absolute(img.getAttribute("src")!));
    img.removeAttribute("srcset");
  }
  const wrapper = doc.createElement("div");
  wrapper.append(template.content);
  return converter().turndown(wrapper).trim();
}

/** The copy: the page's own H1 (or the title), the summary, then the content. */
export function markdownCopy(title: string, description: string | undefined, markdown: string): string {
  const own = /^#\s+(.+?)\s*(?:\n+|$)/.exec(markdown);
  const heading = `# ${own ? own[1] : title}`;
  const rest = own ? markdown.slice(own[0].length) : markdown;
  return `${heading}\n\n${description ? `> ${description}\n\n` : ""}${rest.trim()}\n`;
}
