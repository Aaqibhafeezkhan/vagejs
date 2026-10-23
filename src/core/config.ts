import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { VageError } from "./errors.js";

export const CONFIG_FILES = ["vage.config.ts", "vage.config.js", "vage.config.mjs"];

/** `true` -> defaults, `false` -> disabled, object -> options. */
function toggle<T extends z.ZodType>(options: T) {
  return z
    .union([z.boolean(), options])
    .default(true)
    .transform((v): z.output<T> | false => (v === true ? options.parse({}) : v === false ? false : (v as z.output<T>)));
}

const userAgents = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const urlPath = z.string().regex(/^\//, 'must start with "/"');

const robotsSchema = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        userAgent: userAgents,
        allow: z.array(urlPath).default([]),
        disallow: z.array(urlPath).default([]),
      }),
    )
    .default([])
    .describe("Explicit robots.txt groups, written in order."),
  aiTraining: z
    .enum(["allow", "disallow"])
    .optional()
    .describe("Groups for documented AI training crawlers (GPTBot, ClaudeBot, Google-Extended). Unset: the * group applies."),
  aiSearch: z
    .enum(["allow", "disallow"])
    .optional()
    .describe("Groups for documented AI search crawlers (OAI-SearchBot, Claude-SearchBot). Unset: the * group applies."),
});

const seoSchema = z.strictObject({
  robots: toggle(robotsSchema).describe("Generate robots.txt (true/false or options)."),
  sitemap: z.boolean().default(true).describe("Generate sitemap.xml (needs `site`)."),
  llmsTxt: toggle(
    z.strictObject({
      full: z.boolean().default(false).describe("Also emit llms-full.txt with the Markdown of every listed page."),
    }),
  ).describe("Generate llms.txt (needs `title`)."),
  structuredData: toggle(
    z.strictObject({
      organization: z
        .strictObject({
          name: z.string().min(1),
          url: z.url().optional(),
          logo: z.string().min(1).optional(),
          sameAs: z.array(z.url()).optional(),
        })
        .optional()
        .describe("Organization JSON-LD on the home page. Only true, visible facts."),
    }),
  ).describe("Automatic JSON-LD (WebSite, Organization, Article)."),
});

const score = z.number().int().min(0).max(100);
const kb = z.number().positive();

const budgetsSchema = z.strictObject({
  performance: score.default(90).describe("Minimum Lighthouse performance score (lab)."),
  accessibility: score.default(95).describe("Minimum Lighthouse accessibility score (lab)."),
  seo: score.default(95).describe("Minimum Lighthouse SEO score (lab)."),
  bestPractices: score.default(90).describe("Minimum Lighthouse best-practices score (lab)."),
  javascriptKb: kb.default(100).describe("Max uncompressed JavaScript per page, KB."),
  cssKb: kb.default(50).describe("Max uncompressed CSS per page, KB."),
  imageKb: kb.default(500).describe("Max image bytes per page, KB."),
  fontKb: kb.default(150).describe("Max font bytes per page, KB."),
  totalKb: kb.default(1000).describe("Max total local bytes per page, KB."),
  requests: z.number().int().positive().default(30).describe("Max resource requests per page (incl. the HTML)."),
});

const performanceSchema = z.strictObject({
  budgets: budgetsSchema.default(() => budgetsSchema.parse({})).describe("Starting points, not universal standards. Adjust per site."),
  lighthouse: z
    .strictObject({
      enabled: z.boolean().default(false).describe("Run Lighthouse in `vage audit` without --lighthouse. Needs the lighthouse package and Chrome."),
      pages: z.array(z.string().regex(/^\//)).min(1).default(["/"]).describe("Routes to audit with Lighthouse."),
    })
    .default({ enabled: false, pages: ["/"] }),
});

// GA4 naming rules: https://support.google.com/analytics/answer/13316687
// Length limits (40 chars): https://support.google.com/analytics/answer/9267744
const ga4Name = z
  .string()
  .max(40)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "must start with a letter and use only letters, numbers and underscores");
const ga4Param = ga4Name.refine((p) => !/^(_|firebase_|ga_|google_|gtag\.)/.test(p), "uses a reserved prefix");

/** Event map whose keys are validated with GA4 naming rules (record keys alone give unhelpful errors). */
const ga4Events = z.record(z.string(), z.strictObject({ params: z.array(ga4Param).default([]) })).superRefine((events, ctx) => {
  for (const name of Object.keys(events)) {
    const result = ga4Name.safeParse(name);
    if (!result.success) ctx.addIssue({ code: "custom", path: [name], message: `event name "${name}" ${result.error.issues[0]!.message}` });
  }
});

const consentDefault = z
  .enum(["denied", "granted"])
  .default("denied")
  .describe("Consent mode default for analytics/ads storage before the visitor chooses. Your site provides the consent UI.");

const integrationsSchema = z
  .strictObject({
    ga4: z
      .strictObject({
        measurementId: z
          .string()
          .regex(/^G-[A-Z0-9]+$/, 'must look like "G-XXXXXXX"')
          .optional()
          .describe("GA4 web stream measurement ID (public). Tags are added only when set, e.g. process.env.GA4_MEASUREMENT_ID."),
        propertyId: z.string().regex(/^\d+$/, "must be the numeric GA4 property ID").optional().describe("Numeric property ID for `vage report analytics`."),
        consentDefault,
        events: ga4Events
          .default({})
          .describe('Allowed custom events for data-vage-event attributes, e.g. { signup_click: { params: ["plan"] } }.'),
      })
      .optional(),
    gtm: z
      .strictObject({
        containerId: z.string().regex(/^GTM-[A-Z0-9]+$/, 'must look like "GTM-XXXXXX"').optional().describe("Google Tag Manager container ID."),
        consentDefault,
        events: ga4Events.default({}),
      })
      .optional(),
    searchConsole: z
      .strictObject({
        property: z
          .string()
          .regex(/^(sc-domain:[^/\s]+|https?:\/\/\S+\/)$/, 'must be "sc-domain:example.com" or a URL prefix ending in "/"')
          .optional()
          .describe("Search Console property for `vage report search`."),
      })
      .optional(),
  })
  .refine((i) => !(i.ga4?.measurementId && i.gtm?.containerId), {
    message: "Configure GA4 directly (ga4.measurementId) or through Tag Manager (gtm.containerId), not both: loading both double-counts.",
  });

export const configSchema = z.strictObject({
  site: z
    .url({ protocol: /^https?$/ })
    .refine((s) => new URL(s).pathname === "/", "must be an origin without a path (base paths are not supported yet)")
    .transform((s) => new URL(s).origin)
    .optional()
    .describe("Production origin, e.g. https://example.com. Needed for canonical URLs and sitemap.xml."),
  title: z.string().min(1).optional().describe("Site name: page titles, og:site_name, llms.txt heading."),
  description: z.string().min(1).optional().describe("Fallback meta description; llms.txt summary."),
  lang: z.string().min(1).default("en").describe("<html lang> value."),
  seo: seoSchema.default(() => seoSchema.parse({})),
  performance: performanceSchema.default(() => performanceSchema.parse({})),
  integrations: integrationsSchema.default({}).describe("Optional analytics and search integrations. All off unless configured."),
  redirects: z
    .record(urlPath, z.string().min(1))
    .default({})
    .describe("Old path -> new path or URL. Built as noindex meta-refresh pages; dev answers 301."),
});

export type UserConfig = z.input<typeof configSchema>;
export type SiteConfig = z.output<typeof configSchema>;

/** Identity helper that gives config files type checking. */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

export function findConfigFile(root: string): string | undefined {
  return CONFIG_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
}

export type ModuleLoader = (file: string) => Promise<Record<string, unknown>>;

export async function loadConfig(root: string, load: ModuleLoader): Promise<SiteConfig> {
  const file = findConfigFile(root);
  return parseConfig(file ? (await load(file)).default : {}, file);
}

/** Validates a raw config object and applies defaults. */
export function parseConfig(raw: unknown, file?: string): SiteConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new VageError(`Invalid config:\n${z.prettifyError(result.error)}`, file);
  }
  return result.data;
}
