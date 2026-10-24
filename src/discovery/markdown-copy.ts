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
    replacement: (_c, node) => {
      const text = (node.textContent ?? "").replace(/\n$/, "");
      // The fence must be longer than any backtick run inside, or the text could close it early.
      const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      return `\n\n${fence}\n${text}\n${fence}\n\n`;
    },
  });
  // A link nobody can see or click on the page shouldn't appear in the copy.
  td.addRule("emptyLink", {
    filter: (node) => node.nodeName === "A" && !(node.textContent ?? "").trim() && !node.querySelector("img[alt]:not([alt=''])"),
    replacement: () => "",
  });
  // Simple GFM tables, built in one pass: cells and rows leave separators that the table
  // rule turns into pipes, so each level of a nested table is converted only once.
  const CELL = "\u0001";
  const ROW = "\u0002";
  const cell = (s: string) => s.replace(/[\u0001\u0002]/g, "").replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
  td.addRule("tableCell", { filter: ["th", "td"], replacement: (content) => `${cell(content)}${CELL}` });
  td.addRule("tableRow", { filter: "tr", replacement: (content) => `${ROW}${content}` });
  td.addRule("table", {
    filter: "table",
    replacement: (content) => {
      const rows = content
        .split(ROW)
        .map((r) => r.split(CELL).slice(0, -1).map((c) => c.trim()))
        .filter((r) => r.length);
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
 * The part of a rendered page the copy is made from: the inside of its one `<main>`, so
 * content a layout builds from frontmatter (FAQ answers, post lists) is included. Pages
 * without exactly one `<main>` fall back to the Markdown body.
 */
export function copySource(pageHtml: string, content: string): string {
  const opens = pageHtml.match(/<main[\s>]/gi) ?? [];
  if (opens.length !== 1) return content;
  const m = /<main(?:\s[^>]*)?>([\s\S]*)<\/main>/i.exec(pageHtml);
  return m ? m[1]! : content;
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
  // Layouts mark repeated extras (share links, calls to action) with data-vage-copy="skip";
  // aria-hidden parts are decoration that screen readers skip too.
  for (const el of template.content.querySelectorAll('[hidden], svg, math, [aria-hidden="true"], [data-vage-copy="skip"]')) el.remove();
  // A heading split over two lines with <br> stays one Markdown heading.
  for (const br of template.content.querySelectorAll("h1 br, h2 br, h3 br, h4 br, h5 br, h6 br")) br.replaceWith(" ");
  for (const a of template.content.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")!.trim();
    // Script and data URLs never become links in the copy (trusted HTML can contain them).
    if (/^(javascript|vbscript|data):/i.test(href.replace(/[\s\u0000-\u001f]/g, ""))) a.removeAttribute("href");
    else a.setAttribute("href", absolute(href));
  }
  for (const img of template.content.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src")!.trim();
    if (/^(javascript|vbscript|data):/i.test(src.replace(/[\s\u0000-\u001f]/g, ""))) img.remove();
    else img.setAttribute("src", absolute(src));
    img.removeAttribute("srcset");
  }
  const wrapper = doc.createElement("div");
  wrapper.append(template.content);
  return converter().turndown(wrapper).trim();
}

/**
 * The copy: the page's own H1 (or the title), the summary, then the content. The H1 is
 * moved to the top even when a layout puts something before it, but never taken from
 * inside a code block.
 */
export function markdownCopy(title: string, description: string | undefined, markdown: string): string {
  const own = /^#[ \t]+(.+?)[ \t]*(?:\n+|$)/m.exec(markdown);
  const usable = own && !/^(```|~~~)/m.test(markdown.slice(0, own.index));
  const heading = `# ${usable ? own[1] : title}`;
  const rest = usable ? markdown.slice(0, own.index) + markdown.slice(own.index + own[0].length) : markdown;
  return `${heading}\n\n${description ? `> ${description}\n\n` : ""}${rest.trim()}\n`;
}
