import type { SiteConfig } from "./config.js";
import type { PageSummary } from "./pages.js";
import { publicPath, routeKey } from "./routes.js";

/** One menu entry as layouts see it in `props.menus`. */
export interface MenuItem {
  label: string;
  /** Link target; absent on a group heading (an entry with `items` and no `href` or `page`). */
  href?: string;
  /** True on the entry for the page being rendered (use aria-current="page"). */
  current: boolean;
  /** True when the page being rendered is this entry's page, below it, or in its `items`: for highlighting a section. */
  active: boolean;
  /** True for links that leave the site (http(s) URLs, mailto:). */
  external: boolean;
  /** Sub-entries: a dropdown or a footer column. */
  items: MenuItem[];
}

type ConfigItem = SiteConfig["menus"][string][number];

/**
 * The menus from `menus` in vage.config.ts, resolved for the page at `route`: `page`
 * entries take their address and label from `pages`, site paths follow `trailingSlash`,
 * and each entry knows whether it is the current page or section.
 */
export function resolveMenus(site: SiteConfig, route: string, pages: readonly PageSummary[]): Record<string, MenuItem[]> {
  const here = routeKey(route);
  const byRoute = new Map(pages.map((p) => [routeKey(p.route), p]));
  const resolve = (item: ConfigItem): MenuItem => {
    const items = ("items" in item ? (item.items ?? []) : []).map(resolve);
    const target = item.page ? byRoute.get(routeKey(item.page)) : undefined;
    // A missing page fails the build (menuPageProblems); the dev server still renders, with the address as label.
    let href = item.page ? (target?.route ?? item.page) : item.href;
    const label = item.label ?? target?.label ?? item.page!;
    const internal = href?.startsWith("/") ?? false;
    let current = false;
    let active = items.some((i) => i.active);
    if (href && internal) {
      const [, path = "/", rest = ""] = /^([^?#]*)(.*)$/.exec(href)!;
      href = publicPath(path, site.trailingSlash) + rest;
      const key = routeKey(path);
      current = key === here;
      active ||= current || (key !== "/" && here.startsWith(key));
    }
    return { label, ...(href ? { href } : {}), current, active, external: !!href && !internal, items };
  };
  return Object.fromEntries(Object.entries(site.menus).map(([name, list]) => [name, list.map(resolve)]));
}

/** Every menu entry with where it is in the config, e.g. "menus.footer[1].items[0]". */
export function menuEntries(site: SiteConfig): { at: string; href?: string; page?: string }[] {
  const out: { at: string; href?: string; page?: string }[] = [];
  for (const [name, list] of Object.entries(site.menus)) {
    list.forEach((item, i) => {
      out.push({ at: `menus.${name}[${i}]`, href: item.href, page: item.page });
      item.items?.forEach((sub, j) => out.push({ at: `menus.${name}[${i}].items[${j}]`, href: sub.href, page: sub.page }));
    });
  }
  return out;
}

/** `page` entries that aren't published pages (deleted, moved, a draft or scheduled). */
export function menuPageProblems(site: SiteConfig, pages: readonly PageSummary[]): string[] {
  const published = new Set(pages.map((p) => routeKey(p.route)));
  return menuEntries(site)
    .filter((e) => e.page && !published.has(routeKey(e.page)))
    .map((e) => `${e.at}: page "${e.page}" isn't a published page in src/pages (moved, deleted, a draft or scheduled?).`);
}
