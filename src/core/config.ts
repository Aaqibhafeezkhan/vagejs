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
