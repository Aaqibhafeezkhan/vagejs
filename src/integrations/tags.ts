import type { SiteConfig } from "../core/config.js";
import { VageError } from "../core/errors.js";

const CONSENT_TYPES = ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"];
const LOCAL_HOST = String.raw`/^(localhost|127\.0\.0\.1|\[::1\])$/`;

/**
 * Inline script that sends events for elements with data-vage-event (on click).
 * data-vage-param-plan="pro" becomes the event parameter plan: "pro".
 */
const EVENT_LISTENER = (send: string) =>
  `document.addEventListener("click",function(e){var el=e.target&&e.target.closest&&e.target.closest("[data-vage-event]");if(!el)return;var p={};for(var i=0;i<el.attributes.length;i++){var a=el.attributes[i];if(a.name.indexOf("data-vage-param-")===0)p[a.name.slice(16).replace(/-/g,"_")]=a.value}${send}});`;

/**
 * Google tag snippets for production builds. Consent defaults are set before
 * any measurement command, as Google requires
 * (https://developers.google.com/tag-platform/security/guides/consent).
 * Nothing loads on localhost, so `vage preview` does not send hits.
 * Sites call window.vageConsent.update({ analytics_storage: "granted" }) from their own consent UI.
 */
export function analyticsTags(site: SiteConfig): { head: string; bodyStart?: string } | undefined {
  const { ga4, gtm } = site.integrations;
  const setup = (consent: string) =>
    `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
    `gtag("consent","default",${JSON.stringify(Object.fromEntries(CONSENT_TYPES.map((t) => [t, consent])))});` +
    `window.vageConsent={update:function(c){gtag("consent","update",c)}};`;

  if (ga4?.measurementId) {
    const id = JSON.stringify(ga4.measurementId);
    const body =
      setup(ga4.consentDefault) +
      `gtag("js",new Date());gtag("config",${id});` +
      `var s=document.createElement("script");s.async=true;s.src="https://www.googletagmanager.com/gtag/js?id="+${id};document.head.appendChild(s);` +
      EVENT_LISTENER(`gtag("event",el.getAttribute("data-vage-event"),p);`);
    return { head: `<script>if(!${LOCAL_HOST}.test(location.hostname)){${body}}</script>` };
  }
  if (gtm?.containerId) {
    const id = JSON.stringify(gtm.containerId);
    const body =
      setup(gtm.consentDefault) +
      `dataLayer.push({"gtm.start":new Date().getTime(),event:"gtm.js"});` +
      `var s=document.createElement("script");s.async=true;s.src="https://www.googletagmanager.com/gtm.js?id="+${id};document.head.appendChild(s);` +
      EVENT_LISTENER(`p.event=el.getAttribute("data-vage-event");dataLayer.push(p);`);
    return {
      head: `<script>if(!${LOCAL_HOST}.test(location.hostname)){${body}}</script>`,
      bodyStart: `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(gtm.containerId)}" height="0" width="0" style="display:none;visibility:hidden" title="Google Tag Manager"></iframe></noscript>`,
    };
  }
  return undefined;
}

/** Puts the tag first in <head> (before other scripts) and the GTM noscript right after <body>. */
export function injectAnalytics(html: string, tags: { head: string; bodyStart?: string }, file: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) throw new VageError("Layout output has no <head>; it is needed for analytics tags.", file);
  let out = html.slice(0, head.index + head[0].length) + `\n    ${tags.head}` + html.slice(head.index + head[0].length);
  if (tags.bodyStart) out = out.replace(/<body[^>]*>/i, (m) => `${m}\n    ${tags.bodyStart}`);
  return out;
}
