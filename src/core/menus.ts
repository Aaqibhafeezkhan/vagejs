import type { SiteConfig } from "./config.js";
import { publicPath, routeKey } from "./routes.js";

/** One menu entry as layouts see it in `props.menus`. */
export interface MenuItem {
  label: string;
  /** Link target; absent on a group heading (an entry with `items` and no `href`). */
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

type ConfigItem = { label: string; href?: string; items?: ConfigItem[] };

/**
 * The menus from `menus` in vage.config.ts, resolved for the page at `route`: site paths
 * follow `trailingSlash`, and each entry knows whether it is the current page or section.
 */
export function resolveMenus(site: SiteConfig, route: string): Record<string, MenuItem[]> {
  const here = routeKey(route);
  const resolve = (item: ConfigItem): MenuItem => {
    const items = (item.items ?? []).map(resolve);
    const internal = item.href?.startsWith("/") ?? false;
    let href = item.href;
    let current = false;
    let active = items.some((i) => i.active);
    if (href && internal) {
      const [, path = "/", rest = ""] = /^([^?#]*)(.*)$/.exec(href)!;
      href = publicPath(path, site.trailingSlash) + rest;
      const key = routeKey(path);
      current = key === here;
      active ||= current || (key !== "/" && here.startsWith(key));
    }
    return { label: item.label, ...(href ? { href } : {}), current, active, external: !!href && !internal, items };
  };
  return Object.fromEntries(Object.entries(site.menus).map(([name, list]) => [name, list.map(resolve)]));
}
