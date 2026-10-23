import type { DOMPurify } from "dompurify";
import { enhanceImage } from "./images.js";

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
export async function sanitizeHtml(html: string, options: { publicDir?: string; inlineStyles?: boolean } = {}): Promise<string> {
  const { purifier } = await load();
  let first = true;
  const publicDir = options.publicDir;
  const hook = (node: Element) => {
    if (publicDir && node.nodeName === "IMG") {
      enhanceImage(node, publicDir, first);
      first = false;
    }
  };
  if (publicDir) {
    purifier.addHook("afterSanitizeAttributes", hook);
  }
  try {
    return purifier.sanitize(html, {
      // font/marquee/center: legacy ways to hide or disguise text (white-on-white, 1px scrollers).
      FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "option", "base", "link", "meta", "object", "embed", "font", "marquee", "center"],
      ALLOW_DATA_ATTR: true,
      // Inline styles are the usual way to hide injected links (display:none, off-screen); layouts style pages.
      // xlink:href: SVG links, which would slip past link checks.
      FORBID_ATTR: options.inlineStyles ? ["xlink:href"] : ["style", "xlink:href"],
    });
  } finally {
    if (publicDir) purifier.removeHook("afterSanitizeAttributes", hook);
  }
}

/** For trusted content (`markdown.html: "allow"`): the same image hints, applied through the DOM. */
export async function enhanceTrustedHtml(html: string, publicDir: string): Promise<string> {
  const { jsdom } = await load();
  const template = new jsdom.JSDOM("").window.document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("img").forEach((img, i) => enhanceImage(img, publicDir, i === 0));
  return template.innerHTML;
}
