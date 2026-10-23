import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { enhanceImages, imageSize } from "../src/content/images.js";
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

describe("enhanceImages", () => {
  it("adds sizes from public/, async decoding, and lazy loading after the first image", () => {
    const pub = tmp();
    save(pub, "img/hero.png", png(800, 400));
    save(pub, "img/b.jpg", jpeg(300, 200));
    const out = enhanceImages('<p><img src="/img/hero.png" alt="Hero"></p><p><img src="/img/b.jpg" alt="B"></p>', pub);
    expect(out).toContain('<img src="/img/hero.png" alt="Hero" width="800" height="400" decoding="async">');
    expect(out).toContain('<img src="/img/b.jpg" alt="B" width="300" height="200" decoding="async" loading="lazy">');
  });

  it("keeps author attributes, skips remote images and never reads outside public/", () => {
    const root = tmp();
    const pub = path.join(root, "public");
    save(root, "secret.png", png(1, 1));
    save(pub, "a.png", png(10, 10));
    const out = enhanceImages(
      '<img src="/a.png" width="5" height="5" loading="eager"><img src="https://cdn.example/x.png"><img src="/../secret.png"><img src="//evil.example/a.png">',
      pub,
    );
    expect(out).toContain('<img src="/a.png" width="5" height="5" loading="eager" decoding="async">');
    expect(out).toContain('<img src="https://cdn.example/x.png" decoding="async" loading="lazy">');
    expect(out).toContain('<img src="/../secret.png" decoding="async" loading="lazy">');
    expect(out).not.toContain('width="1"');
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
