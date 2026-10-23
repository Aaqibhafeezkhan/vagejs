import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { findConfigFile, loadConfig } from "../core/config.js";
import { VageError } from "../core/errors.js";
import { escapeHtml } from "../core/html.js";
import { baseViteConfig, viteLoader } from "../core/loader.js";
import { renderPage } from "../core/render.js";
import { discoverRoutes, findNotFoundPage, normalizeRequestPath } from "../core/routes.js";
import { listenOrExplain, type ServeOptions } from "./listen.js";
import { redirect } from "./preview.js";

/**
 * Starts the dev server. Pages are rendered on every request, so new and
 * edited pages show up without a restart; any change under src/ or to the
 * config triggers a full browser reload.
 */
export async function startDevServer(root: string, options: ServeOptions = {}): Promise<ViteDevServer> {
  // Vite reports watcher paths with symlinks resolved, so compare against the real path.
  root = path.resolve(root);
  if (!fs.existsSync(root)) throw new VageError(`Project directory not found: ${root}`);
  root = fs.realpathSync(root);
  const pagesDir = path.join(root, "src", "pages");
  const srcDir = path.join(root, "src") + path.sep;

  const server = await createServer({
    ...baseViteConfig(root),
    server: { port: options.port, strictPort: options.port !== undefined, host: options.host },
  });
  const load = viteLoader(server);

  server.watcher.on("all", (_event, file) => {
    if (file.startsWith(srcDir) || file === findConfigFile(root)) {
      server.ws.send({ type: "full-reload", path: "*" });
    }
  });

  server.middlewares.use(async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const urlPath = req.url ?? "/";
    // Leave asset requests (any extension other than .html) to Vite.
    const pathname = urlPath.split(/[?#]/)[0]!;
    if (/\.[a-z0-9]+$/i.test(pathname) && !pathname.endsWith(".html")) return next();
    try {
      const site = await loadConfig(root, load);
      const route = normalizeRequestPath(urlPath);
      const entry = discoverRoutes(pagesDir).find((r) => r.route === route);
      // Match production preview: "/about" -> "/about/".
      if (entry && !pathname.endsWith("/") && !pathname.endsWith(".html")) {
        return redirect(res, entry.route + urlPath.slice(pathname.length));
      }
      const notFound = findNotFoundPage(pagesDir);
      if (!entry && !notFound) {
        return send(res, 404, await server.transformIndexHtml(urlPath, plainPage("404 — Not found", `No page for ${route}`)));
      }
      const file = entry?.file ?? notFound!;
      const page = await renderPage({ root, file, route: entry ? route : "/404/", site, load });
      send(res, entry ? 200 : 404, await server.transformIndexHtml(urlPath, page.html));
    } catch (err) {
      const message = (err as Error).message;
      server.config.logger.error(message);
      send(res, 500, await server.transformIndexHtml(urlPath, plainPage("Render error", message)));
    }
  });

  await listenOrExplain(() => server.listen(), options.port);
  return server;
}

function send(res: ServerResponse, status: number, html: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function plainPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(message)}</pre></body></html>`;
}

