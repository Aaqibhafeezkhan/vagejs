import type { SiteConfig } from "../core/config.js";
import { VageError } from "../core/errors.js";
import { html, type SafeHtml } from "../core/html.js";
import { LIMITS } from "../worker/contact-mail.js";

export interface ContactFormLabels {
  name?: string;
  email?: string;
  message?: string;
  send?: string;
}

/**
 * The contact form for a layout: plain HTML that posts to `contact.path`, where the
 * contact Worker emails it. Works without JavaScript. The hidden "website" field is a
 * honeypot: people never see it, bots fill it in. Style it with the `vage-contact` class.
 * Forms can't go in Markdown (page content is sanitized), so this belongs in a layout.
 */
export function contactForm(site: Pick<SiteConfig, "contact">, labels: ContactFormLabels = {}): SafeHtml {
  if (!site.contact) throw new VageError("contactForm(): add contact: { to, from } to vage.config.ts first.");
  const l = { name: "Your name", email: "Your email", message: "Message", send: "Send message", ...labels };
  return html`<form class="vage-contact" method="post" action="${site.contact.path}" data-vage-copy="skip">
  <label for="vage-contact-name">${l.name}</label>
  <input id="vage-contact-name" name="name" type="text" autocomplete="name" maxlength="${LIMITS.name}" required />
  <label for="vage-contact-email">${l.email}</label>
  <input id="vage-contact-email" name="email" type="email" autocomplete="email" maxlength="${LIMITS.email}" required />
  <label for="vage-contact-message">${l.message}</label>
  <textarea id="vage-contact-message" name="message" rows="8" maxlength="${LIMITS.message}" required></textarea>
  <div aria-hidden="true" style="position:absolute;left:-100vw"><label for="vage-contact-website">Leave this empty</label><input id="vage-contact-website" name="website" type="text" tabindex="-1" autocomplete="off" /></div>
  <button type="submit">${l.send}</button>
</form>`;
}
