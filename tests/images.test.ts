import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { imageSize } from "../src/content/images.js";
import { enhanceTrustedHtml, sanitizeHtml } from "../src/content/sanitize.js";
import { JSDOM } from "jsdom";
import { copyFixture, write } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vage-img-"));
const save = (dir: string, name: string, data: Buffer | string) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), data);
  return path.join(dir, name);
};

function png(w: number, h: number) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number) {
  // SOI, an APP0 segment to skip, then SOF0 with height/width.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(11, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}
function gif(w: number, h: number) {
  const b = Buffer.alloc(10);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function webpX(w: number, h: number) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

describe("imageSize", () => {
  it("reads PNG, JPEG, GIF, WebP and SVG sizes", () => {
    const d = tmp();
    expect(imageSize(save(d, "a.png", png(640, 360)))).toEqual({ width: 640, height: 360 });
    expect(imageSize(save(d, "a.jpg", jpeg(1200, 800)))).toEqual({ width: 1200, height: 800 });
    expect(imageSize(save(d, "a.gif", gif(32, 16)))).toEqual({ width: 32, height: 16 });
    expect(imageSize(save(d, "a.webp", webpX(1920, 1080)))).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(save(d, "a.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"></svg>'))).toEqual({ width: 120, height: 60 });
    expect(imageSize(save(d, "b.svg", '<svg width="24px" height="24" viewBox="0 0 48 48"></svg>'))).toEqual({ width: 24, height: 24 });
  });

  it("returns undefined for unknown or missing files", () => {
    const d = tmp();
    expect(imageSize(save(d, "x.png", "not an image"))).toBeUndefined();
    expect(imageSize(path.join(d, "missing.png"))).toBeUndefined();
  });
});

describe("image hints", () => {
  const enhance = (html: string, pub: string) => sanitizeHtml(html, { publicDir: pub });
  const imgs = (html: string) => [...new JSDOM(html).window.document.querySelectorAll("img")];

  it("adds sizes from public/, async decoding, and lazy loading after the first image", async () => {
    const pub = tmp();
    save(pub, "img/hero.png", png(800, 400));
    save(pub, "img/b.jpg", jpeg(300, 200));
    const [a, b] = imgs(await enhance('<p><img src="/img/hero.png" alt="Hero"></p><p><img src="/img/b.jpg" alt="B"></p>', pub));
    expect([a!.getAttribute("width"), a!.getAttribute("height"), a!.getAttribute("decoding"), a!.hasAttribute("loading")]).toEqual(["800", "400", "async", false]);
    expect([b!.getAttribute("width"), b!.getAttribute("height"), b!.getAttribute("loading")]).toEqual(["300", "200", "lazy"]);
  });

  it("keeps author attributes, skips remote images and never reads outside public/", async () => {
    const root = tmp();
    const pub = path.join(root, "public");
    save(root, "secret.png", png(1, 1));
    save(pub, "a.png", png(10, 10));
    const [own, remote, outside, proto] = imgs(
      await enhance('<img src="/a.png" width="5" height="5" loading="eager"><img src="https://cdn.example/x.png"><img src="/../secret.png"><img src="//evil.example/a.png">', pub),
    );
    expect([own!.getAttribute("width"), own!.getAttribute("loading")]).toEqual(["5", "eager"]);
    expect(remote!.hasAttribute("width")).toBe(false);
    expect(outside!.hasAttribute("width")).toBe(false);
    expect(proto!.hasAttribute("width")).toBe(false);
  });

  it("can't be used to smuggle markup out of alt or title text (review finding)", async () => {
    const pub = tmp();
    save(pub, "y.png", png(4, 4));
    for (const html of [
      '<p><img src="/y.png" alt="&lt;img src=/x.png&gt;&lt;img src=q onerror=alert(1)&gt;"></p>',
      '<p><a href="/x" title="&lt;img src=/x.png&gt;&lt;img src=q onerror=alert(1)&gt;">t</a></p>',
    ]) {
      const out = await enhance(html, pub);
      const doc = new JSDOM(out).window.document;
      expect(doc.querySelectorAll("[onerror]").length).toBe(0);
      expect(doc.querySelectorAll("img").length).toBeLessThanOrEqual(1);
    }
  });

  it("ignores paths that aren't valid percent-encoding instead of crashing (review finding)", async () => {
    const pub = tmp();
    const [img] = imgs(await enhance('<img src="/100%.png" alt="x">', pub));
    expect(img!.getAttribute("decoding")).toBe("async");
    expect(img!.hasAttribute("width")).toBe(false);
  });

  it("applies the same hints to trusted HTML (markdown.html: allow)", async () => {
    const pub = tmp();
    save(pub, "a.png", png(20, 10));
    const out = await enhanceTrustedHtml('<figure><img src="/a.png" alt="A"><img src="/a.png" alt="B"></figure>', pub);
    const [a, b] = imgs(out);
    expect([a!.getAttribute("width"), b!.getAttribute("loading")]).toEqual(["20", "lazy"]);
  });

  it("is applied to Markdown images in a build", async () => {
    const root = copyFixture();
    write(root, "public/images/wide.png", "");
    fs.writeFileSync(path.join(root, "public/images/wide.png"), png(1600, 900));
    write(root, "src/pages/gallery.md", `---\ntitle: Gallery\ndescription: Pictures.\n---\n# Gallery\n\n![A wide picture](/images/wide.png)\n`);
    await build(root);
    expect(fs.readFileSync(path.join(root, "dist/gallery/index.html"), "utf8")).toContain('alt="A wide picture" width="1600" height="900" decoding="async"');
  });
});
