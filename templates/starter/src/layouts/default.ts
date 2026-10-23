import { escapeHtml, type Layout } from "vagejs";

const layout: Layout = ({ content, page, site }) => {
  const title = site.title && site.title !== page.title ? `${page.title} | ${site.title}` : page.title;
  return `<!doctype html>
<html lang="${escapeHtml(site.lang)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
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
        <a href="/">Home</a>
        <a href="/about/">About</a>
        <a href="/blog/first-post/">Blog</a>
      </nav>
    </header>
    <main>
${content}
    </main>
  </body>
</html>
`;
};

// VAGE JS adds description, canonical, Open Graph and JSON-LD tags before </head>
// unless this layout already writes them.
export default layout;
