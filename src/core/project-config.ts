import { findConfigFile, loadConfig, parseConfig, type SiteConfig } from "./config.js";
import { createBuildLoader } from "./loader.js";

/** Loads vage.config.* outside a build (defaults when there is none). */
export async function loadProjectConfig(root: string): Promise<SiteConfig> {
  if (!findConfigFile(root)) return parseConfig({});
  const loader = await createBuildLoader(root);
  try {
    return await loadConfig(root, loader.load);
  } finally {
    await loader.close();
  }
}
