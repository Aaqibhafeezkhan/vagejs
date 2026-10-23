import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { VageError } from "./errors.js";
import { createBuildLoader } from "./loader.js";
import { renderPage } from "./render.js";
import { discoverRoutes, findNotFoundPage } from "./routes.js";

export const OUT_DIR = "dist";

export interface BuildResult {
  outDir: string;
  pages: { route: string; source: string; output: string }[];
  skippedDrafts: string[];
  durationMs: number;
}

export async function build(root: string): Promise<BuildResult> {
  const start = performance.now();
  root = path.resolve(root);
  const pagesDir = path.join(root, "src", "pages");
  if (!fs.existsSync(pagesDir)) {
    throw new VageError(`No src/pages directory found in ${root}. Is this a VAGE JS project?`);
  }
  const outDir = path.join(root, OUT_DIR);
  const loader = await createBuildLoader(root);

  try {
    const site = await loadConfig(root, loader.load);
    const routes = discoverRoutes(pagesDir);
    const rendered: { output: string; html: string }[] = [];
    const result: BuildResult = { outDir, pages: [], skippedDrafts: [], durationMs: 0 };

    // Render everything before touching dist/ so a failed build leaves the previous output intact.
    for (const entry of routes) {
      const page = await renderPage({ root, file: entry.file, route: entry.route, site, load: loader.load });
      const source = path.relative(root, entry.file);
      if (page.frontmatter.draft) {
        result.skippedDrafts.push(source);
        continue;
      }
      rendered.push({ output: entry.outFile, html: page.html });
      result.pages.push({ route: entry.route, source, output: entry.outFile });
    }
    const notFound = findNotFoundPage(pagesDir);
    if (notFound) {
      const page = await renderPage({ root, file: notFound, route: "/404/", site, load: loader.load });
      rendered.push({ output: "404.html", html: page.html });
    }

    fs.rmSync(outDir, { recursive: true, force: true });
    const publicDir = path.join(root, "public");
    if (fs.existsSync(publicDir)) fs.cpSync(publicDir, outDir, { recursive: true });
    for (const { output, html } of rendered) {
      const target = path.join(outDir, output);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, html);
    }

    result.durationMs = Math.round(performance.now() - start);
    return result;
  } finally {
    await loader.close();
  }
}
