#!/usr/bin/env node
// Renders favicon.ico (16/32/48 px) and apple-touch-icon.png (180 px) from an SVG
// with headless Chrome, so the bitmaps match the vector exactly. Maintainer tool (not shipped).
//   node scripts/brand/favicons.mjs <icon.svg> <out-dir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [svgPath, outDir] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const svg = fs.readFileSync(svgPath, "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vage-favicon-"));

/** Renders the SVG at size×size. background: CSS color or "transparent"; scale: share of the canvas the icon fills. */
function render(size, { background = "transparent", scale = 1 } = {}) {
  const html = path.join(tmp, `${size}.html`);
  const png = path.join(tmp, `${size}-${background.replace(/\W/g, "")}.png`);
  const inner = Math.round(size * scale);
  fs.writeFileSync(
    html,
    `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;overflow:hidden;background:${background};display:flex;align-items:center;justify-content:center">` +
      `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${inner}" height="${inner}"></body></html>`,
  );
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--default-background-color=00000000", `--window-size=${size},${size}`, `--screenshot=${png}`, `file://${html}`], { stdio: "ignore" });
  const data = fs.readFileSync(png);
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== size || height !== size) throw new Error(`Chrome rendered ${width}x${height}, expected ${size}x${size}`);
  return data;
}

/** ICO container with PNG-encoded entries (supported by all current browsers). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2); // palette
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); // color planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "favicon.ico"), ico([16, 32, 48].map((size) => ({ size, data: render(size) }))));
// iOS fills transparency with black and rounds the corners itself: opaque white with padding.
fs.writeFileSync(path.join(outDir, "apple-touch-icon.png"), render(180, { background: "#ffffff", scale: 0.8 }));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote favicon.ico (16/32/48) and apple-touch-icon.png (180) to ${outDir}`);
