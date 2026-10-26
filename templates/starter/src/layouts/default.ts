import { html, raw, type Layout } from "vagejs";

// `html` escapes every ${value}; `raw(content)` inserts the page's already-sanitized HTML.
const layout: Layout = ({ content, page, site, menus }) => {
  const title = site.title && site.title !== page.title ? `${page.title} | ${site.title}` : page.title;
  return html`<!doctype html>
<html lang="${site.lang}">
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
    </style>
  </head>
  <body>
    <header>
      <nav aria-label="Main">
        ${(menus.main ?? []).map((item) => html`<a href="${item.href}"${item.current ? raw(' aria-current="page"') : ""}>${item.label}</a>`)}
      </nav>
    </header>
    <main>
${raw(content)}
    </main>
  </body>
</html>
`;
};

// vagejs adds description, canonical, Open Graph and JSON-LD tags before </head>
// unless this layout already writes them.
export default layout;
