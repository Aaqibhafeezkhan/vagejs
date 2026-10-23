const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for safe use in HTML content and attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const SAFE = Symbol.for("vagejs.safeHtml");

/** HTML that `html` inserts as-is. Create it with `html` or `raw()`; `String(x)` gives the markup. */
export interface SafeHtml {
  readonly [SAFE]: true;
  readonly value: string;
  toString(): string;
}

const safe = (value: string): SafeHtml => ({ [SAFE]: true, value, toString: () => value });
export const isSafeHtml = (v: unknown): v is SafeHtml => typeof v === "object" && v !== null && SAFE in v;

/**
 * Marks trusted markup so `html` won't escape it, such as `props.content` (already
 * sanitized) or a JSON-LD script from `jsonLdScript()`. Never pass user or frontmatter text.
 */
export function raw(markup: string): SafeHtml {
  return safe(String(markup));
}

function interpolate(v: unknown): string {
  if (isSafeHtml(v)) return v.value;
  if (Array.isArray(v)) return v.map(interpolate).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(v);
}

/**
 * Template tag for layouts: every `${value}` is escaped unless it is `html` itself or `raw()`.
 * Arrays are joined, and null, undefined and false render nothing, so lists and conditions read naturally:
 *
 *   html`<ul>${posts.map((p) => html`<li><a href="${p.route}">${p.title}</a></li>`)}</ul>`
 *   html`<main>${raw(content)}</main>`
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]!;
  values.forEach((v, i) => (out += interpolate(v) + strings[i + 1]!));
  return safe(out);
}
