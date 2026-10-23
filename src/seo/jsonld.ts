/**
 * Typed JSON-LD helpers. Only describe what is visible on the page; search
 * engines treat structured data that contradicts page content as spam, and
 * valid markup does not guarantee rich results.
 * Vocabulary: https://schema.org — Google's rules: https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data
 */
export interface Thing {
  "@type": string;
  [key: string]: unknown;
}

export function organization(o: { name: string; url?: string; logo?: string; sameAs?: string[] }): Thing {
  return compact({ "@type": "Organization", ...o });
}

export function website(o: { name: string; url: string }): Thing {
  return { "@type": "WebSite", ...o };
}

export function article(o: {
  headline: string;
  description?: string;
  url?: string;
  image?: string;
  datePublished?: string;
  dateModified?: string;
  author?: string;
}): Thing {
  const { author, url, ...rest } = o;
  return compact({
    "@type": "Article",
    ...rest,
    mainEntityOfPage: url,
    author: author ? { "@type": "Person", name: author } : undefined,
  });
}

export function breadcrumbList(items: { name: string; url: string }[]): Thing {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({ "@type": "ListItem", position: i + 1, name: item.name, item: item.url })),
  };
}

/** Serializes JSON-LD into a <script> tag, escaping "<" so content cannot close the tag. */
export function jsonLdScript(data: Thing | Thing[]): string {
  const withContext = Array.isArray(data)
    ? { "@context": "https://schema.org", "@graph": data }
    : { "@context": "https://schema.org", ...data };
  return `<script type="application/ld+json">${JSON.stringify(withContext).replace(/</g, "\\u003c")}</script>`;
}

function compact(o: Record<string, unknown>): Thing {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Thing;
}
