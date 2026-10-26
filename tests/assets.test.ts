import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { withAssetNames } from "../src/core/assets.js";
import { copyFixture, write } from "./helpers.js";

const LAYOUT = `export default ({ content, page }) => \`<!doctype html><html lang="en"><head><title>\${page.title}</title>
<link rel="preload" href="/fonts/a.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="/styles.css" />
<script src="/app.js?v=1" defer></script></head><body><a href="/styles.css">raw</a><img src="/images/logo.png" alt="Logo" /><main>\${content}</main></body></html>\`;
`;

/** A site whose layout loads a stylesheet (with a font and an @import), a script and a preloaded font. */
function siteWithAssets(config = ""): string {
  const root = copyFixture();
  write(root, "vage.config.ts", `export default { site: "https://fixture.example", title: "Fixture Site"${config} };\n`);
  write(root, "src/layouts/default.ts", LAYOUT);
  write(root, "public/fonts/a.woff2", "font-bytes-1");
  write(root, "public/extra.css", "p { color: #ff0000; }\n");
  write(root, "public/styles.css", '@import "/extra.css";\n@font-face { font-family: A; src: url("/fonts/a.woff2") format("woff2"); }\nbody { background: url(/images/logo.png); }\n');
  write(root, "public/app.js", "console.log('app');\n");
  return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");
const assetName = (html: string, re: RegExp) => re.exec(html)?.[1];

describe("assets: minified stylesheets and fingerprinted copies", () => {
  it("minifies stylesheets when asked, keeping fallbacks for older browsers", async () => {
    const root = siteWithAssets();
    await build(root);
    expect(read(root, "extra.css")).toBe("p { color: #ff0000; }\n");
    expect(read(root, "about/index.html")).toContain('href="/styles.css"');

    write(root, "public/fallbacks.css", "a { height: 100vh; height: 100dvh; color: #123456; color: oklch(60% 0.1 200); background: light-dark(#fff, #000); }\nb { *zoom: 1; color: red; }\n");
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", assets: { minifyCss: true } };\n');
    await build(root);
    expect(read(root, "extra.css")).toBe("p{color:red}");
    expect(fs.readFileSync(path.join(root, "public/extra.css"), "utf8")).toBe("p { color: #ff0000; }\n");
    const minified = read(root, "fallbacks.css");
    expect(minified).toContain("height:100vh");
    expect(minified).toContain("height:100dvh");
    expect(minified).toContain("color:#123456");
    expect(minified).toContain("light-dark(#fff,#000)");
    expect(minified).toContain("b{color:red}"); // an old hack doesn't stop the rest of the file
  });

  it("points pages at fingerprinted copies, follows fonts and @import, and keeps the originals", async () => {
    const root = siteWithAssets(", assets: { fingerprint: true }, deploy: { target: 'cloudflare-workers' }");
    await build(root);
    const html = read(root, "about/index.html");
    const css = assetName(html, /href="(\/_vage\/assets\/styles\.[0-9a-f]{10}\.css)"/);
    const js = assetName(html, /src="(\/_vage\/assets\/app\.[0-9a-f]{10}\.js)\?v=1"/);
    const font = assetName(html, /href="(\/_vage\/assets\/fonts\/a\.[0-9a-f]{10}\.woff2)"/);
    expect(css && js && font).toBeTruthy();
    // Links people follow and images keep their names.
    expect(html).toContain('<a href="/styles.css">raw</a>');
    expect(html).toContain('src="/images/logo.png"');

    const sheet = read(root, css!.slice(1));
    expect(sheet).toContain(`url("${font}")`);
    expect(sheet).toMatch(/@import "\/_vage\/assets\/extra\.[0-9a-f]{10}\.css"/);
    expect(sheet).toContain("url(/images/logo.png)");
    expect(read(root, font!.slice(1))).toBe("font-bytes-1");
    expect(read(root, "styles.css")).toContain('url("/fonts/a.woff2")'); // the original stays
    expect(read(root, "_headers")).toContain("/_vage/assets/*\n  Cache-Control: public, max-age=31536000, immutable");

    // Same files, same names; a changed font renames the font and the stylesheet that uses it.
    await build(root);
    expect(read(root, "about/index.html")).toContain(css!);
    write(root, "public/fonts/a.woff2", "font-bytes-2");
    await build(root);
    const after = read(root, "about/index.html");
    expect(after).not.toContain(css!);
    expect(after).not.toContain(font!);
    expect(after).toContain(js!);
  });

  it("adds the subfolder to fingerprinted paths for a site in a subfolder", async () => {
    const root = siteWithAssets("");
    write(root, "vage.config.ts", 'export default { site: "https://fixture.github.io/repo", title: "Fixture Site", assets: { fingerprint: true } };\n');
    await build(root);
    const html = read(root, "about/index.html");
    const css = assetName(html, /href="\/repo(\/_vage\/assets\/styles\.[0-9a-f]{10}\.css)"/);
    expect(css).toBeTruthy();
    expect(read(root, css!.slice(1))).toMatch(/url\("\/repo\/_vage\/assets\/fonts\/a\.[0-9a-f]{10}\.woff2"\)/);
  });

  it("writes no cache rule without fingerprinting", async () => {
    const root = siteWithAssets(", deploy: { target: 'cloudflare-workers' }");
    await build(root);
    expect(read(root, "_headers")).not.toContain("immutable");
  });

  it("makes relative references in fingerprinted stylesheets work from their new folder", async () => {
    const root = siteWithAssets(", assets: { fingerprint: true }");
    write(root, "public/css/site.css", '.hero { background: url(../images/logo.png); } .x { background: image-set("../images/logo.png" 1x); } .y { background: url("data:image/png;base64,AA=="); }\n');
    write(root, "src/layouts/default.ts", LAYOUT.replace('<link rel="stylesheet" href="/styles.css" />', '<link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/css/site.css" />'));
    await build(root);
    const name = assetName(read(root, "about/index.html"), /href="(\/_vage\/assets\/css\/site\.[0-9a-f]{10}\.css)"/);
    const sheet = read(root, name!.slice(1));
    expect(sheet).toContain("url(/images/logo.png)");
    expect(sheet).toContain('image-set("/images/logo.png" 1x)');
    expect(sheet).toContain('url("data:image/png;base64,AA==")');
  });

  it("leaves module scripts, modulepreload and script code alone", () => {
    const rename = new Map([
      ["/app.js", "/_vage/assets/app.0123456789.js"],
      ["/styles.css", "/_vage/assets/styles.0123456789.css"],
    ]);
    const html = '<script type="module" src="/app.js"></script><link rel="modulepreload" href="/app.js"><script>const tag = \'<link rel="stylesheet" href="/styles.css">\';</script><script src="/app.js" defer></script>';
    expect(withAssetNames(html, rename)).toBe(
      '<script type="module" src="/app.js"></script><link rel="modulepreload" href="/app.js"><script>const tag = \'<link rel="stylesheet" href="/styles.css">\';</script><script src="/_vage/assets/app.0123456789.js" defer></script>',
    );
  });

  it("only renames stylesheet, script and preload references", () => {
    const rename = new Map([["/styles.css", "/_vage/assets/styles.0123456789.css"]]);
    expect(withAssetNames('<link rel="stylesheet" href="/styles.css"><a href="/styles.css">x</a><link href="https://cdn.example/styles.css">', rename)).toBe(
      '<link rel="stylesheet" href="/_vage/assets/styles.0123456789.css"><a href="/styles.css">x</a><link href="https://cdn.example/styles.css">',
    );
  });
});
