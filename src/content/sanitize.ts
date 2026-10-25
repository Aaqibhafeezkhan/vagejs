import type { DOMPurify } from "dompurify";
import { enhanceImage } from "./images.js";

/** Optimized copies for one image source: WebP srcset and sizes, plus AVIF when images.avif is on. */
export interface ImageVariant {
  srcset: string;
  sizes: string;
  avifSrcset?: string;
}

let purifier: DOMPurify | undefined;
let jsdom: typeof import("jsdom") | undefined;

async function load() {
  if (!purifier) {
    const [mod, { default: createDOMPurify }] = await Promise.all([import("jsdom"), import("dompurify")]);
    jsdom = mod;
    purifier = createDOMPurify(new mod.JSDOM("").window as unknown as Window & typeof globalThis);
  }
  return { purifier, jsdom: jsdom! };
}

/**
 * Sanitizes rendered Markdown HTML. Page content may be written by AI agents,
 * contributors or (later) CMS sources, so scripts, event handlers, javascript:
 * URLs, iframes, forms and <meta>/<base>/<style> tricks are removed. data-*
 * attributes (used by analytics events) are kept. style="" is removed unless
 * `markdown.inlineStyles` is on. Loaded lazily: jsdom is heavy.
 *
 * With `publicDir`, images get their size and loading hints inside the sanitizer
 * (a DOMPurify hook), so DOMPurify's serialization is the final output.
 */
export async function sanitizeHtml(
  html: string,
  options: { publicDir?: string; inlineStyles?: boolean; variants?: Map<string, ImageVariant>; headingIds?: boolean } = {},
): Promise<string> {
  const { purifier } = await load();
  let first = true;
  const publicDir = options.publicDir;
  const hook = (node: Element) => {
    if (publicDir && node.nodeName === "IMG") {
      enhanceImage(node, publicDir, first, options.variants?.get(node.getAttribute("src") ?? ""));
      first = false;
    }
  };
  // A heading's own id is kept even when DOMPurify's clobbering filter would drop it ("title",
  // "images"), so it behaves like the ids vagejs adds and links to it keep working.
  const keepHeadingId = (node: Element, data: { attrName: string; forceKeepAttr?: boolean }) => {
    if (data.attrName === "id" && /^H[23]$/.test(node.nodeName)) data.forceKeepAttr = true;
  };
  if (publicDir) {
    purifier.addHook("afterSanitizeAttributes", hook);
  }
  if (options.headingIds) purifier.addHook("uponSanitizeAttribute", keepHeadingId);
  const config = {
    // font/marquee/center: legacy ways to hide or disguise text (white-on-white, 1px scrollers).
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "option", "base", "link", "meta", "object", "embed", "font", "marquee", "center"],
    ALLOW_DATA_ATTR: true,
    // Inline styles are the usual way to hide injected links (display:none, off-screen); layouts style pages.
    // xlink:href: SVG links, which would slip past link checks.
    FORBID_ATTR: options.inlineStyles ? ["xlink:href"] : ["style", "xlink:href"],
  };
  try {
    const avif = [...(options.variants?.values() ?? [])].some((v) => v.avifSrcset);
    if (!avif && !options.headingIds) return purifier.sanitize(html, config);
    // Heading ids and AVIF <picture> wrappers are added on DOMPurify's own output tree, then serialized once.
    // (Editing sanitized HTML as a string and parsing it again could change its meaning.)
    const fragment = purifier.sanitize(html, { ...config, RETURN_DOM_FRAGMENT: true });
    if (options.headingIds) addHeadingIds(fragment);
    if (avif) addAvifSources(fragment, options.variants!);
    const container = fragment.ownerDocument!.createElement("div");
    container.appendChild(fragment);
    return container.innerHTML;
  } finally {
    if (publicDir) purifier.removeHook("afterSanitizeAttributes", hook);
    if (options.headingIds) purifier.removeHook("uponSanitizeAttribute", keepHeadingId);
  }
}

/** For trusted content (`markdown.html: "allow"`): the same image hints and heading ids, applied through the DOM. */
export async function enhanceTrustedHtml(html: string, publicDir: string, variants?: Map<string, ImageVariant>, headingIds = false): Promise<string> {
  const { jsdom } = await load();
  const template = new jsdom.JSDOM("").window.document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("img").forEach((img, i) => enhanceImage(img, publicDir, i === 0, variants?.get(img.getAttribute("src") ?? "")));
  if (headingIds) addHeadingIds(template.content);
  if (variants) addAvifSources(template.content, variants);
  return template.innerHTML;
}

/** "Quick start: 2 steps!" -> "quick-start-2-steps". Letters in any script are kept; accents are dropped. */
export function headingSlug(text: string): string {
  return text
    .normalize("NFKD")
    // Only Latin accents are dropped; marks are part of other scripts (Hindi vowel signs, kana voicing).
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Gives each h2 and h3 without an id one made from its text, so sections can be linked
 * (/docs/setup/#quick-start). Ids already on the page are kept and never reused; repeats
 * get -2, -3.
 */
function addHeadingIds(root: ParentNode): void {
  const used = new Set([...root.querySelectorAll("[id]")].map((el) => el.id));
  for (const heading of root.querySelectorAll("h2, h3")) {
    if (heading.id) continue;
    const base = headingSlug(heading.textContent ?? "") || "section";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    heading.id = id;
  }
}

/**
 * Offers AVIF first: <picture><source type="image/avif" srcset sizes><img …></picture>.
 * Browsers without AVIF use the <img> and its WebP srcset. Only images vagejs gave a
 * srcset are wrapped (an author's own srcset or <picture> is left alone).
 */
function addAvifSources(root: ParentNode, variants: Map<string, ImageVariant>): void {
  for (const img of [...root.querySelectorAll("img")]) {
    const v = variants.get(img.getAttribute("src") ?? "");
    if (!v?.avifSrcset || img.getAttribute("srcset") !== v.srcset || img.parentElement?.nodeName === "PICTURE") continue;
    const doc = img.ownerDocument;
    const picture = doc.createElement("picture");
    const source = doc.createElement("source");
    source.setAttribute("type", "image/avif");
    source.setAttribute("srcset", v.avifSrcset);
    source.setAttribute("sizes", img.getAttribute("sizes") ?? v.sizes);
    img.replaceWith(picture);
    picture.append(source, img);
  }
}
