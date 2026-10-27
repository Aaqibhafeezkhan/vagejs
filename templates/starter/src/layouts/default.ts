import { breadcrumbs, html, raw, type Layout } from "vagejs";

// `html` escapes every ${value}; `raw(content)` inserts the page's already-sanitized HTML.
const layout: Layout = ({ content, page, site, pages, menus }) => {
  const title = site.title && site.title !== page.title ? `${page.title} | ${site.title}` : page.title;
  const fm = page.frontmatter;
  // The same trail vagejs describes in BreadcrumbList JSON-LD (seo.structuredData.breadcrumbs).
  const trail = page.route === "/" ? [] : breadcrumbs(pages, page.route);
  // Articles show who wrote them and when: the same facts as their Article JSON-LD.
  const byline =
    fm.type === "article" && (fm.datePublished || fm.author)
      ? html`<p class="byline">${fm.author ? html`By ${fm.author}` : ""}${fm.author && fm.datePublished ? " · " : ""}${fm.datePublished ? html`<time datetime="${fm.datePublished}">${fm.datePublished.slice(0, 10)}</time>` : ""}</p>`
      : "";
  const body = fm.type === "article" ? html`<article>
${raw(content)}
${byline}
</article>` : raw(content);
  return html`<!doctype html>
<html lang="${page.lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <style>
      body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 0 auto; padding: 2rem 1rem; line-height: 1.6; }
      nav a { margin-right: 1rem; }
      .breadcrumbs ol { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.5rem; font-size: 0.9rem; }
      .breadcrumbs li + li::before { content: "/"; margin-right: 0.5rem; }
      .byline, footer { color: #555; font-size: 0.9rem; }
      footer { margin-top: 3rem; border-top: 1px solid #ddd; padding-top: 1rem; }
    </style>
  </head>
  <body>
    <header>
      <nav aria-label="Main">
        ${(menus.main ?? []).map((item) => html`<a href="${item.href}"${item.current ? raw(' aria-current="page"') : ""}>${item.label}</a>`)}
      </nav>
    </header>
    <main>
${trail.length > 1 ? html`<nav class="breadcrumbs" aria-label="Breadcrumb" data-vage-copy="skip"><ol>${trail.map((p, i) => html`<li>${i === trail.length - 1 ? html`<span aria-current="page">${p.label}</span>` : html`<a href="${p.route}">${p.label}</a>`}</li>`)}</ol></nav>
` : ""}${body}
    </main>
    <footer>
      <p>${site.title ?? ""}</p>
    </footer>
  </body>
</html>
`;
};

// vagejs adds description, canonical, Open Graph and JSON-LD tags before </head>
// unless this layout already writes them.
export default layout;
