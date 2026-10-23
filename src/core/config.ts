import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { VageError } from "./errors.js";

export const CONFIG_FILES = ["vage.config.ts", "vage.config.js", "vage.config.mjs"];

const configSchema = z.strictObject({
  /** Absolute production URL, e.g. https://example.com. Used for canonical URLs in later phases. */
  site: z.url({ protocol: /^https?$/ }).optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  lang: z.string().min(1).default("en"),
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
  const raw = file ? (await load(file)).default : {};
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new VageError(`Invalid config:\n${z.prettifyError(result.error)}`, file);
  }
  return result.data;
}
