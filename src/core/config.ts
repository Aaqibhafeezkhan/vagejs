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
  /** Explicit groups, written to robots.txt in order. */
  rules: z
    .array(
      z.strictObject({
        userAgent: userAgents,
        allow: z.array(urlPath).default([]),
        disallow: z.array(urlPath).default([]),
      }),
    )
    .default([]),
  /**
   * Adds groups for documented AI *training* crawler tokens (see src/discovery/crawlers.ts).
   * Unset: no AI-specific groups; the `*` group applies.
   */
  aiTraining: z.enum(["allow", "disallow"]).optional(),
  /** Same, for documented AI *search* crawler tokens. */
  aiSearch: z.enum(["allow", "disallow"]).optional(),
});

const seoSchema = z.strictObject({
  robots: toggle(robotsSchema),
  sitemap: z.boolean().default(true),
  llmsTxt: toggle(
    z.strictObject({
      /** Also emit /llms-full.txt with the Markdown of every listed page. */
      full: z.boolean().default(false),
    }),
  ),
  structuredData: toggle(
    z.strictObject({
      /** Emitted as Organization JSON-LD on the home page. Only use facts that are true and visible. */
      organization: z
        .strictObject({
          name: z.string().min(1),
          url: z.url().optional(),
          logo: z.string().min(1).optional(),
          sameAs: z.array(z.url()).optional(),
        })
        .optional(),
    }),
  ),
});

const configSchema = z.strictObject({
  /** Production origin, e.g. https://example.com. Required for canonical URLs, sitemap.xml and absolute links. */
  site: z
    .url({ protocol: /^https?$/ })
    .refine((s) => new URL(s).pathname === "/", "must be an origin without a path (base paths are not supported yet)")
    .transform((s) => new URL(s).origin)
    .optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  lang: z.string().min(1).default("en"),
  seo: seoSchema.default(() => seoSchema.parse({})),
  /** Old path -> new path or absolute URL. Built as noindex meta-refresh pages; the dev server answers 301. */
  redirects: z.record(urlPath, z.string().min(1)).default({}),
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
