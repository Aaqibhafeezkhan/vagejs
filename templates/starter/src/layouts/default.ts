import { escapeHtml, type Layout } from "vagejs";

const layout: Layout = ({ content, page, site }) => {
  const title = site.title && site.title !== page.title ? `${page.title} | ${site.title}` : page.title;
  const description = page.description ?? site.description;
  return `<!doctype html>
<html lang="${escapeHtml(site.lang)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${description ? `<meta name="description" content="${escapeHtml(description)}" />` : ""}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
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

export default layout;
