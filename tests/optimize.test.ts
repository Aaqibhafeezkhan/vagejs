import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import sharp from "sharp";
import { JSDOM } from "jsdom";
import { build } from "../src/core/build.js";
import { imageVariants, sharpResize, type Resize } from "../src/content/optimize.js";
import { startDevServer } from "../src/dev/server.js";
import { copyFixture, write } from "./helpers.js";

const REPO = path.resolve(".");
const CONFIG = 'export default { site: "https://fixture.example", title: "Fixture Site", images: { optimize: true, widths: [400, 800, 1600] } };';
const jpeg = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#4060a0" } }).jpeg().toBuffer();

/** A fixture project that can resolve sharp (linked to this repo's node_modules). */
async function site() {
  const root = copyFixture();
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "dir");
  write(root, "vage.config.ts", CONFIG);
  fs.writeFileSync(path.join(root, "public/images/photo.jpg"), await jpeg(1200, 600));
  write(root, "src/pages/gallery.md", "---\ntitle: Gallery\ndescription: Photos.\n---\n# Gallery\n\n![A blue photo](/images/photo.jpg)\n\n![Logo](/images/logo.png)\n\n![Remote](https://cdn.example/x.jpg)\n");
  return root;
}

describe("image pipeline (images.optimize)", () => {
  it("writes resized WebP files and offers them with srcset, never upscaling", async () => {
    const root = await site();
    await build(root);
    const doc = new JSDOM(fs.readFileSync(path.join(root, "dist/gallery/index.html"), "utf8")).window.document;
    const photo = doc.querySelector('img[alt="A blue photo"]')!;
    const srcset = photo.getAttribute("srcset")!;
    // 400 and 800 from the settings, plus the original 1200 (1600 would be an upscale).
    expect(srcset).toMatch(/^\/_vage\/img\/photo-[0-9a-f]{10}-400\.webp 400w, \/_vage\/img\/photo-[0-9a-f]{10}-800\.webp 800w, \/_vage\/img\/photo-[0-9a-f]{10}-1200\.webp 1200w$/);
    expect(photo.getAttribute("sizes")).toBe("(max-width: 48rem) 100vw, 48rem");
    expect(photo.getAttribute("src")).toBe("/images/photo.jpg"); // the original stays as the fallback
    for (const entry of srcset.split(", ")) {
      const [url, w] = entry.split(" ");
      const meta = await sharp(path.join(root, "dist", url!)).metadata();
      expect([meta.format, `${meta.width}w`]).toEqual(["webp", w]);
    }
    expect(doc.querySelector('img[alt="Remote"]')!.hasAttribute("srcset")).toBe(false);
  });

  it("includes the original width when it's smaller than every configured width", async () => {
    const root = await site();
    fs.writeFileSync(path.join(root, "public/images/small.jpg"), await jpeg(300, 200));
    write(root, "src/pages/small.md", "---\ntitle: Small\ndescription: Small.\n---\n# Small\n\n![Small](/images/small.jpg)\n");
    await build(root);
    expect(fs.readFileSync(path.join(root, "dist/small/index.html"), "utf8")).toMatch(/small-[0-9a-f]{10}-300\.webp 300w"/);
  });

  it("reuses cached files on the next build", async () => {
    const root = await site();
    await build(root);
    let calls = 0;
    const counting: Resize = async (input, w, q) => (calls++, (await sharpResize(root))(input, w, q));
    const v = await imageVariants("/images/photo.jpg", root, { optimize: true, widths: [400, 800, 1600], quality: 75, sizes: "100vw" }, counting);
    expect(v?.files.size).toBe(3);
    expect(calls).toBe(0);
  });

  it("skips SVG, missing files and paths outside public/", async () => {
    const root = await site();
    const resize: Resize = async () => {
      throw new Error("should not be called");
    };
    const opts = { optimize: true, widths: [400], quality: 75, sizes: "100vw" };
    for (const src of ["/images/logo.svg", "/images/missing.jpg", "/../package.json", "//cdn.example/x.jpg", "/100%.jpg"]) {
      expect(await imageVariants(src, root, opts, resize), src).toBeUndefined();
    }
  });

  it("explains how to install sharp when it's missing", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG);
    await expect(build(root)).rejects.toThrow(/npm install --save-dev sharp/);
  });
});

describe("optimized images in the dev server", () => {
  let server: ViteDevServer | undefined;
  afterEach(async () => server?.close());
  it("serves the generated WebP files", async () => {
    const root = await site();
    server = await startDevServer(root, { port: 0 });
    const url = `http://localhost:${(server.httpServer!.address() as { port: number }).port}`;
    const html = await (await fetch(`${url}/gallery/`)).text();
    const first = /srcset="([^ ]+) /.exec(html)![1]!;
    const res = await fetch(url + first);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect((await fetch(`${url}/_vage/img/nope-0000000000-1.webp`)).status).toBe(404);
  });
});
