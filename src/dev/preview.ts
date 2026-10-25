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
        const [rawPath = "/", query] = (req.url ?? "/").split("?");
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
        if (!decoded.endsWith("/") && !path.extname(decoded) && isFile(path.join(file, "index.html"))) {
          // Built from the normalized path, so "//evil.example" can't become a protocol-relative redirect.
          return redirect(res, `/${rel ? `${encodeURI(rel)}/` : ""}${query ? `?${query}` : ""}`);
        }
        if (isFile(decoded.endsWith("/") ? path.join(file, "index.html") : file)) return next();
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
