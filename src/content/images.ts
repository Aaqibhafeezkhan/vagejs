import fs from "node:fs";
import path from "node:path";

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Reads pixel dimensions from an image file's header (PNG, JPEG, GIF, WebP, SVG),
 * without decoding it or adding a dependency. Undefined when the format isn't recognized.
 */
export function imageSize(file: string): ImageSize | undefined {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return undefined;
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === ".svg") return svgSize(buf.toString("utf8"));
  // PNG: width and height in the IHDR chunk.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  // GIF: little-endian logical screen size.
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return undefined;
      const marker = buf[i + 1]!;
      const length = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + length;
    }
  }
  return undefined;
}

function svgSize(svg: string): ImageSize | undefined {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!tag) return undefined;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(tag)?.[1];
  const w = attr("width");
  const h = attr("height");
  if (w && h) return { width: Math.round(Number(w)), height: Math.round(Number(h)) };
  const box = /\sviewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(tag);
  return box ? { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) } : undefined;
}

/**
 * Fills in what Markdown images can't say: width and height from the file in public/
 * (prevents layout shift), decoding="async", and loading="lazy" on every image after
 * the first (the first is often the main image, which shouldn't wait). Attributes
 * already present are kept; remote images only get the loading hints.
 */
export function enhanceImages(content: string, publicDir: string): string {
  let index = 0;
  return content.replace(/<img\b([^>]*?)\s*(\/?)>/gi, (_tag, attrs: string, slash: string) => {
    const has = (name: string) => new RegExp(`\\s${name}\\s*=`, "i").test(attrs);
    let extra = "";
    const src = /\ssrc\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (src && !has("width") && !has("height") && /^\/(?!\/)/.test(src)) {
      const rel = decodeURIComponent(src.split(/[?#]/)[0]!);
      const file = path.join(publicDir, rel);
      // Only files inside public/.
      if (file.startsWith(publicDir + path.sep)) {
        const size = imageSize(file);
        if (size) extra += ` width="${size.width}" height="${size.height}"`;
      }
    }
    if (!has("decoding")) extra += ' decoding="async"';
    if (index++ > 0 && !has("loading")) extra += ' loading="lazy"';
    return `<img${attrs}${extra}${slash ? " /" : ""}>`;
  });
}
