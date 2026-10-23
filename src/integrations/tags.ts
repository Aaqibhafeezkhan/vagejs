import type { SiteConfig } from "../core/config.js";
import { VageError } from "../core/errors.js";
import { ruleData } from "../guidelines/pack.js";

const CONSENT_TYPES = ruleData<{ types: string[] }>("consent.default-order").types;
const LOCAL_HOST = String.raw`/^(localhost|127\.0\.0\.1|\[::1\])$/`;

/**
 * Analytics tags for production builds.
 *
 * - Google (GA4 or GTM): consent defaults are set before any measurement command
 *   (https://developers.google.com/tag-platform/security/guides/consent), and nothing
 *   loads on localhost, so `vage preview` sends no hits.
 * - Plausible / Clarity: the owner's dashboard snippet, inserted verbatim (vagejs
 *   can't suppress those on localhost).
 * - window.vageConsent.update({ analytics_storage, ad_storage }) forwards consent to
 *   Google (consent update) and Clarity (consentv2). Sites provide their own consent UI.
 * - One click listener sends data-vage-event / data-vage-param-* to every configured provider.
 */
export function analyticsTags(site: SiteConfig): { head: string; bodyStart?: string } | undefined {
  const { ga4, gtm, plausible, clarity } = site.integrations;
  const google = ga4?.measurementId ? { kind: "ga4" as const, id: ga4.measurementId, consent: ga4.consentDefault } : gtm?.containerId ? { kind: "gtm" as const, id: gtm.containerId, consent: gtm.consentDefault } : undefined;
  if (!google && !plausible && !clarity) return undefined;

  const parts: string[] = [];
  let bodyStart: string | undefined;
  const send: string[] = [];

  if (google) {
    const id = JSON.stringify(google.id);
    let body =
      `window.dataLayer=window.dataLayer||[];window.gtag=function(){dataLayer.push(arguments)};` +
      `gtag("consent","default",${JSON.stringify(Object.fromEntries(CONSENT_TYPES.map((t) => [t, google.consent])))});`;
    if (google.kind === "ga4") {
      body += `gtag("js",new Date());gtag("config",${id});` + loadScript(`"https://www.googletagmanager.com/gtag/js?id="+${id}`);
      send.push(`if(window.gtag)gtag("event",n,p);`);
    } else {
      body += `dataLayer.push({"gtm.start":new Date().getTime(),event:"gtm.js"});` + loadScript(`"https://www.googletagmanager.com/gtm.js?id="+${id}`);
      send.push(`if(window.dataLayer){var d={event:n};for(var k in p)d[k]=p[k];dataLayer.push(d)}`);
      bodyStart = `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(google.id)}" height="0" width="0" style="display:none;visibility:hidden" title="Google Tag Manager"></iframe></noscript>`;
    }
    parts.push(`<script>if(!${LOCAL_HOST}.test(location.hostname)){${body}}</script>`);
  }
  if (plausible) {
    parts.push(plausible.snippet.trim());
    send.push(`if(window.plausible)plausible(n,{props:p});`);
  }
  if (clarity) parts.push(clarity.snippet.trim());

  // Consent bridge and event listener; safe when a provider failed to load.
  parts.push(
    `<script>(function(){var s={};window.vageConsent={update:function(c){for(var k in c)s[k]=c[k];` +
      `if(window.gtag)gtag("consent","update",c);` +
      `if(window.clarity)clarity("consentv2",{ad_Storage:s.ad_storage||"denied",analytics_Storage:s.analytics_storage||"denied"})}};` +
      `document.addEventListener("click",function(e){var el=e.target&&e.target.closest&&e.target.closest("[data-vage-event]");if(!el)return;` +
      `var n=el.getAttribute("data-vage-event"),p={};for(var i=0;i<el.attributes.length;i++){var a=el.attributes[i];` +
      `if(a.name.indexOf("data-vage-param-")===0)p[a.name.slice(16).replace(/-/g,"_")]=a.value}${send.join("")}})})();</script>`,
  );
  return { head: parts.join("\n    "), bodyStart };
}

function loadScript(src: string): string {
  return `var s=document.createElement("script");s.async=true;s.src=${src};document.head.appendChild(s);`;
}

/** Puts the tags first in <head> (before other scripts) and the GTM noscript right after <body>. */
export function injectAnalytics(html: string, tags: { head: string; bodyStart?: string }, file: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) throw new VageError("Layout output has no <head>; it is needed for analytics tags.", file);
  let out = html.slice(0, head.index + head[0].length) + `\n    ${tags.head}` + html.slice(head.index + head[0].length);
  if (tags.bodyStart) out = out.replace(/<body[^>]*>/i, (m) => `${m}\n    ${tags.bodyStart}`);
  return out;
}
