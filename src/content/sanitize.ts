import type { DOMPurify } from "dompurify";

let purifier: DOMPurify | undefined;

/**
 * Sanitizes rendered Markdown HTML. Page content may be written by AI agents,
 * contributors or (later) CMS sources, so scripts, event handlers, javascript:
 * URLs, iframes, forms and <meta>/<base>/<style> tricks are removed. data-*
 * attributes (used by analytics events) are kept. Loaded lazily: jsdom is heavy.
 */
export async function sanitizeHtml(html: string): Promise<string> {
  if (!purifier) {
    const [{ JSDOM }, { default: createDOMPurify }] = await Promise.all([import("jsdom"), import("dompurify")]);
    purifier = createDOMPurify(new JSDOM("").window as unknown as Window & typeof globalThis);
  }
  return purifier.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "option", "base", "link", "meta", "object", "embed"],
    ALLOW_DATA_ATTR: true,
  });
}
