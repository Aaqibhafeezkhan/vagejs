import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { preview, type Plugin, type PreviewServer } from "vite";
import { basePath } from "../core/base.js";
import { OUT_DIR } from "../core/build.js";
import { loadConfig } from "../core/config.js";
import { createBuildLoader } from "../core/loader.js";
import { VageError } from "../core/errors.js";
import { listenOrExplain, type ServeOptions } from "./listen.js";

/** Serves the production build output from dist/. */
export async function startPreviewServer(root: string, options: ServeOptions = {}): Promise<PreviewServer> {
  root = path.resolve(root);
  if (!fs.existsSync(path.join(root, OUT_DIR))) {
    throw new VageError(`No build output found in ${OUT_DIR}/. Run "vage build" first.`);
  }
  // A site in a subfolder is previewed there, as its host serves it (https://owner.github.io/repo/).
  const loader = await createBuildLoader(root);
  const base = await loadConfig(root, loader.load)
    .then((site) => basePath(site.site))
    .finally(() => loader.close());
  return listenOrExplain(
    () =>
      preview({
        root,
        configFile: false,
        logLevel: "warn",
        appType: "mpa",
        build: { outDir: OUT_DIR },
        plugins: [staticHostBehavior(path.join(root, OUT_DIR), base)],
        preview: { port: options.port, strictPort: options.port !== undefined, host: options.host },
      }),
    options.port,
  );
}

/**
 * Mimics common static hosts: "/about" serves about.html when it exists (trailingSlash
 * "never" builds) and "/about/" then redirects to "/about"; otherwise "/about" redirects
 * to "/about/" when about/index.html exists. Unknown paths get 404.html with a 404 status.
 * With a `base` ("/repo"), the site is served under it and "/" leads there.
 */
function staticHostBehavior(outDir: string, base = ""): Plugin {
  const notFound = (res: ServerResponse) => {
    const page = path.join(outDir, "404.html");
    res.statusCode = 404;
    if (!fs.existsSync(page)) return res.end("Not found");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(fs.readFileSync(page));
  };
  return {
    name: "vage:static-host",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const [fullPath = "/", query] = (req.url ?? "/").split("?");
        let rawPath = fullPath;
        if (base) {
          if (fullPath === "/" || fullPath === base) return redirect(res, `${base}/${query ? `?${query}` : ""}`);
          if (!fullPath.startsWith(`${base}/`)) return notFound(res);
          rawPath = fullPath.slice(base.length);
        }
        let decoded: string;
        try {
          decoded = decodeURIComponent(rawPath);
        } catch {
          res.statusCode = 400;
          return res.end("Bad request");
        }
        // Resolve inside dist/ only: no traversal, no probing for files elsewhere.
        const file = path.resolve(outDir, `.${decoded}`);
        if (file !== outDir && !file.startsWith(outDir + path.sep)) return notFound(res);
        const rel = path.relative(outDir, file).split(path.sep).join("/");
        // Pages may have dots in their names ("/v1.2" -> v1.2.html), so only an existing file wins.
        if (rel && !isFile(file) && isFile(`${file}.html`)) {
          // Built from the normalized path, like the redirect below.
          if (decoded.endsWith("/")) return redirect(res, `${base}/${encodeURI(rel)}${query ? `?${query}` : ""}`);
          req.url = `/${encodeURI(rel)}.html${query ? `?${query}` : ""}`;
          return next();
        }
        if (!decoded.endsWith("/") && isFile(path.join(file, "index.html"))) {
          // Built from the normalized path, so "//evil.example" can't become a protocol-relative redirect.
          return redirect(res, `${base}/${rel ? `${encodeURI(rel)}/` : ""}${query ? `?${query}` : ""}`);
        }
        if (isFile(decoded.endsWith("/") ? path.join(file, "index.html") : file)) {
          req.url = `${rawPath}${query ? `?${query}` : ""}`; // the file's path in dist/, without the base
          return next();
        }
        notFound(res);
      });
    },
  };
}

function isFile(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

export function redirect(res: ServerResponse, location: string, status = 301) {
  res.statusCode = status;
  res.setHeader("Location", location);
  res.end();
}
