import { createServer, type InlineConfig, type ViteDevServer } from "vite";
import type { ModuleLoader } from "./config.js";

/** Shared Vite options. configFile: false keeps a project's own vite.config out of the picture. */
export function baseViteConfig(root: string): InlineConfig {
  return { root, configFile: false, logLevel: "warn", appType: "custom" };
}

export function viteLoader(server: ViteDevServer): ModuleLoader {
  return (file) => server.ssrLoadModule(file);
}

/** A headless Vite server used only to import TypeScript config and layout files during a build. */
export async function createBuildLoader(root: string): Promise<{ load: ModuleLoader; close: () => Promise<void> }> {
  const server = await createServer({
    ...baseViteConfig(root),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  return { load: viteLoader(server), close: () => server.close() };
}
