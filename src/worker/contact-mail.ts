/**
 * The contact form Worker's logic, kept free of Cloudflare-only imports so it can be
 * tested in Node. contact.ts wires it to the runtime's EmailMessage.
 *
 * POST <CONTACT_PATH> emails the message to CONTACT_TO from CONTACT_FROM, with Reply-To
 * set to the sender, then redirects (303) to CONTACT_SENT or CONTACT_FAILED. A filled-in
 * honeypot field ("vage_trap") looks sent but sends nothing. Everything else is served from
 * the site's files by the ASSETS binding. `vage deploy` sets the variables from
 * vage.config.ts (contact).
 */
export interface ContactEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  EMAIL?: { send(message: unknown): Promise<void> };
  CONTACT_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  CONTACT_TO?: string;
  CONTACT_FROM?: string;
  CONTACT_PATH?: string;
  CONTACT_SENT?: string;
  CONTACT_FAILED?: string;
  /** The site's name, used in the sender name and subject. */
  CONTACT_SITE?: string;
}

export type EmailMessageClass = new (from: string, to: string, raw: string) => unknown;

const EMAIL = /^[^\s@<>"(),;:\\]+@[^\s@<>"(),;:\\]+\.[^\s@<>"(),;:\\]+$/;
export const LIMITS = { name: 100, email: 200, message: 5000 };

export interface ContactMessage {
  name: string;
  email: string;
  message: string;
}

/** The form's fields, or undefined when something required is missing or invalid. Line breaks can't reach headers. */
export function readContactForm(form: FormData): ContactMessage | "spam" | undefined {
  // The hidden spam trap, named so password managers don't fill it in (they do fill "website").
  if (form.get("vage_trap")) return "spam";
  const oneLine = (key: string, max: number) => String(form.get(key) ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
  const name = oneLine("name", LIMITS.name);
  const email = oneLine("email", LIMITS.email);
  const message = String(form.get("message") ?? "").trim().slice(0, LIMITS.message);
  if (!name || !EMAIL.test(email) || !message) return undefined;
  return { name, email, message };
}

/** The raw email (RFC 5322): any character in names and text, base64 body. */
export function contactEmail(m: ContactMessage, options: { to: string; from: string; site: string; date?: Date; id?: string }): string {
  const domain = options.from.split("@")[1] ?? "localhost";
  return [
    `From: ${encodeWord(`${options.site} contact form`)} <${options.from}>`,
    `To: <${options.to}>`,
    `Reply-To: ${encodeWord(m.name)} <${m.email}>`,
    `Subject: ${encodeWord(`Contact form: ${m.name}`)}`,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${options.id ?? crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64(`From: ${m.name} <${m.email}>\n\n${m.message}\n`).replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
}

export function contactWorker(EmailMessage: EmailMessageClass) {
  return {
    async fetch(request: Request, env: ContactEnv): Promise<Response> {
      const url = new URL(request.url);
      const path = env.CONTACT_PATH ?? "/contact/";
      if (request.method !== "POST" || url.pathname !== path) return env.ASSETS.fetch(request);
      const back = (to: string | undefined, fallback: string) => Response.redirect(`${url.origin}${to ?? fallback}`, 303);
      const sent = () => back(env.CONTACT_SENT, "/contact/sent/");
      const failed = () => back(env.CONTACT_FAILED, "/contact/not-sent/");

      if (!env.EMAIL || !env.CONTACT_TO || !env.CONTACT_FROM) {
        console.error("contact form: the EMAIL binding, CONTACT_TO or CONTACT_FROM is missing");
        return failed();
      }
      const form = await request.formData().catch(() => undefined);
      const fields = form ? readContactForm(form) : undefined;
      if (fields === "spam") return sent();
      if (!fields) return failed();
      if (env.CONTACT_LIMIT) {
        const { success } = await env.CONTACT_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
        if (!success) return failed();
      }
      try {
        const raw = contactEmail(fields, { to: env.CONTACT_TO, from: env.CONTACT_FROM, site: env.CONTACT_SITE ?? url.hostname });
        await env.EMAIL.send(new EmailMessage(env.CONTACT_FROM, env.CONTACT_TO, raw));
      } catch (err) {
        console.error("contact form: sending failed", err);
        return failed();
      }
      return sent();
    },
  };
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A header value that may hold any character (RFC 2047). */
function encodeWord(text: string): string {
  return `=?UTF-8?B?${base64(text)}?=`;
}
