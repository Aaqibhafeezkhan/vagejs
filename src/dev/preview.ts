import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { preview, type Plugin, type PreviewServer } from "vite";
import { OUT_DIR } from "../core/build.js";
import { VageError } from "../core/errors.js";
import { listenOrExplain, type ServeOptions } from "./listen.js";

/** Serves the production build output from dist/. */
export async function startPreviewServer(root: string, options: ServeOptions = {}): Promise<PreviewServer> {
  root = path.resolve(root);
  if (!fs.existsSync(path.join(root, OUT_DIR))) {
    throw new VageError(`No build output found in ${OUT_DIR}/. Run "vage build" first.`);
  }
  return listenOrExplain(
    () =>
      preview({
        root,
        configFile: false,
        logLevel: "warn",
        appType: "mpa",
        build: { outDir: OUT_DIR },
        plugins: [staticHostBehavior(path.join(root, OUT_DIR))],
        preview: { port: options.port, strictPort: options.port !== undefined, host: options.host },
      }),
    options.port,
  );
}

/**
 * Mimics common static hosts: "/about" redirects to "/about/" when
 * about/index.html exists, and unknown paths get 404.html with a 404 status.
 */
function staticHostBehavior(outDir: string): Plugin {
  return {
    name: "vage:static-host",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const [pathname = "/", query] = (req.url ?? "/").split("?");
        const file = path.join(outDir, decodeURIComponent(pathname));
        if (!pathname.endsWith("/") && !path.extname(pathname) && fs.existsSync(path.join(file, "index.html"))) {
          return redirect(res, `${pathname}/${query ? `?${query}` : ""}`);
        }
        if (fs.existsSync(pathname.endsWith("/") ? path.join(file, "index.html") : file)) return next();
        const notFound = path.join(outDir, "404.html");
        res.statusCode = 404;
        if (!fs.existsSync(notFound)) return res.end("Not found");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(fs.readFileSync(notFound));
      });
    },
  };
}

export function redirect(res: ServerResponse, location: string) {
  res.statusCode = 301;
  res.setHeader("Location", location);
  res.end();
}
