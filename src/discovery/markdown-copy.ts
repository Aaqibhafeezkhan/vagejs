import TurndownService from "turndown";

/** "/" -> "index.md", "/docs/cli/" -> "docs/cli.md". */
export function markdownCopyPath(route: string): string {
  return route === "/" ? "index.md" : `${route.slice(1, -1)}.md`;
}

let jsdom: typeof import("jsdom") | undefined;
let service: TurndownService | undefined;

function converter(): TurndownService {
  if (service) return service;
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
  // Never carry executable or embedded content into the copy, even from trusted HTML.
  td.remove(["script", "style", "noscript", "template", "iframe", "object", "embed", "form", "button", "select", "textarea"]); // svg and math are removed from the DOM first
  // "<" in text must stay text: a Markdown viewer that renders HTML would otherwise run it.
  const baseEscape = td.escape.bind(td);
  td.escape = (text: string) => baseEscape(text).replace(/</g, "\\<");
  td.addRule("checkbox", {
    filter: (node) => node.nodeName === "INPUT",
    replacement: (_c, node) => ((node as HTMLInputElement).type === "checkbox" ? ((node as HTMLInputElement).checked || (node as HTMLInputElement).hasAttribute("checked") ? "[x] " : "[ ] ") : ""),
  });
  td.addRule("strikethrough", { filter: ["del", "s"], replacement: (content) => (content.trim() ? `~~${content}~~` : "") });
  td.addRule("preformatted", {
    filter: (node) => node.nodeName === "PRE" && !node.querySelector("code"),
    replacement: (_c, node) => `\n\n\`\`\`\n${(node.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`,
  });
  // A link nobody can see or click on the page shouldn't appear in the copy.
  td.addRule("emptyLink", {
    filter: (node) => node.nodeName === "A" && !(node.textContent ?? "").trim() && !node.querySelector("img[alt]:not([alt=''])"),
    replacement: () => "",
  });
  // Simple GFM tables. Only this table's own rows (a nested table is converted inside its cell).
  const cell = (s: string) => s.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
  td.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const table = node as HTMLTableElement;
      const rows = Array.from(table.rows ?? []).map((tr) => Array.from(tr.cells ?? []).map((c) => cell(td.turndown(c as HTMLElement))));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return `\n\n${[line(rows[0]!), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n\n`;
    },
  });
  service = td;
  return td;
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
  // Hidden content isn't on the page for visitors, so it isn't in the copy either.
  for (const el of template.content.querySelectorAll("[hidden], svg, math")) el.remove();
  for (const a of template.content.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")!.trim();
    // Script and data URLs never become links in the copy (trusted HTML can contain them).
    if (/^(javascript|vbscript|data):/i.test(href.replace(/[\s\u0000-\u001f]/g, ""))) a.removeAttribute("href");
    else a.setAttribute("href", absolute(href));
  }
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
