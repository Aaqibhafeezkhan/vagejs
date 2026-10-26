import type { Frontmatter } from "../content/markdown.js";
import type { SiteConfig } from "./config.js";
import { routeKey } from "./routes.js";

/** One language version of a page, as layouts see it in `page.translations`. */
export interface Translation {
  /** Language code: `lang` for the main language, or one of `i18n.locales`. */
  lang: string;
  /** The page's address in that language. */
  route: string;
  /** Absolute canonical URL, when `site` is set and the page is indexable. */
  url?: string;
  /** True for the page being rendered. */
  current: boolean;
}

/** The page's language: its locale folder (/fr/about/ -> "fr"), otherwise the main `lang`. */
export function pageLang(site: SiteConfig, route: string): string {
  const first = routeKey(route).split("/")[1] ?? "";
  return site.i18n?.locales.includes(first) ? first : site.lang;
}

/**
 * What ties translations together: the main-language route. fr/about.md -> "/about/";
 * a page with a translated address names it with `translationOf: /about/`.
 */
export function translationKey(site: SiteConfig, route: string, frontmatter: Frontmatter): string {
  const lang = pageLang(site, route);
  if (lang === site.lang) return routeKey(route);
  if (typeof frontmatter.translationOf === "string") return routeKey(frontmatter.translationOf);
  return routeKey(route).slice(lang.length + 1);
}

/** Every language version of a page (itself included), main language first, then i18n.locales order. Empty without i18n. */
export function pageTranslations(
  site: SiteConfig,
  self: Omit<Translation, "current" | "lang">,
  frontmatter: Frontmatter,
  pages: readonly { route: string; url?: string; frontmatter: Frontmatter }[],
): Translation[] {
  if (!site.i18n) return [];
  const key = translationKey(site, self.route, frontmatter);
  const others = pages
    .filter((p) => routeKey(p.route) !== routeKey(self.route) && translationKey(site, p.route, p.frontmatter) === key)
    .map((p) => ({ lang: pageLang(site, p.route), route: p.route, url: p.url, current: false }));
  const order = [site.lang, ...site.i18n.locales];
  return [{ lang: pageLang(site, self.route), ...self, current: true }, ...others].sort((a, b) => order.indexOf(a.lang) - order.indexOf(b.lang));
}
