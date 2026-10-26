import fs from "node:fs";
import path from "node:path";
import { VageError } from "./errors.js";
import { createBuildLoader } from "./loader.js";
import { renderSite, type SiteModel } from "./site.js";
import { publicPath } from "./routes.js";
import { basePath, cssWithBase, withBase } from "./base.js";
import { bundleIslands, islandKeys, islandRegistry, ISLANDS_DIR } from "./islands.js";
import { planAssets, withAssetNames } from "./assets.js";

export const OUT_DIR = "dist";

export interface BuildResult {
  outDir: string;
  pages: { route: string; source: string; output: string }[];
  redirects: { from: string; to: string; output: string }[];
  files: string[];
  skippedDrafts: string[];
  /** Pages with a later datePublished, and the date they go live (on a build from that day). */
  skippedScheduled: { source: string; date: string }[];
  warnings: string[];
  durationMs: number;
}

export async function build(root: string): Promise<BuildResult> {
  return (await buildSite(root)).result;
}

/** Builds and also returns the rendered site model (for audits). */
export async function buildSite(root: string): Promise<{ result: BuildResult; model: SiteModel }> {
  const start = performance.now();
  root = path.resolve(root);
  const outDir = path.join(root, OUT_DIR);
  const loader = await createBuildLoader(root);

  try {
    // Render everything before touching dist/ so a failed build leaves the previous output intact.
    const model = await renderSite(root, loader.load);
    const outputs = new Map<string, string | Buffer>();
    // A site in a subfolder (site: https://owner.github.io/repo): root-relative URLs get the prefix.
    const base = basePath(model.site.site);
    // Minified stylesheets, and fingerprinted copies of stylesheets, scripts and fonts (assets.*).
    const assetPlan = planAssets(root, { ...model.site.assets, base });
    for (const page of model.pages) outputs.set(page.outFile, withBase(withAssetNames(page.html, assetPlan.rename), base));
    if (model.notFound) outputs.set(model.notFound.outFile, withBase(withAssetNames(model.notFound.html, assetPlan.rename), base));
    for (const [name, data] of assetPlan.files) outputs.set(name, data);
    for (const r of model.redirects) outputs.set(r.outFile, withBase(r.html, base));
    for (const [name, content] of model.files) outputs.set(name, content);
    // Interactive islands (client:load/visible/idle): their browser code, bundled once for the site.
    const keys = new Set([...model.pages, ...(model.notFound ? [model.notFound] : [])].flatMap((p) => islandKeys(p.html)));
    if (keys.size) {
      const registry = islandRegistry();
      const unknown = [...keys].find((k) => !registry.has(k));
      if (unknown) throw new VageError(`A page contains <vage-island data-island="${unknown}"> that vagejs didn't make. Islands come from client:load, client:visible or client:idle on a component; remove the hand-written element.`);
      for (const [name, code] of await bundleIslands(root, [...keys].map((k) => registry.get(k)!))) outputs.set(`${ISLANDS_DIR}/${name}`, code);
    }
    const assets = new Map<string, string>();
    for (const p of [...model.pages, ...(model.notFound ? [model.notFound] : [])]) for (const [k, f] of p.assets) assets.set(k, f);

    fs.rmSync(outDir, { recursive: true, force: true });
    const publicDir = path.join(root, "public");
    if (fs.existsSync(publicDir)) {
      fs.cpSync(publicDir, outDir, { recursive: true });
      if (base) for (const css of cssFiles(publicDir)) {
        const target = path.join(outDir, path.relative(publicDir, css));
        fs.writeFileSync(target, cssWithBase(fs.readFileSync(target, "utf8"), base));
      }
    }
    for (const [output, content] of outputs) {
      const target = path.resolve(outDir, output);
      // Defense in depth: config is validated, but never write outside dist/.
      if (!target.startsWith(outDir + path.sep)) throw new VageError(`Refusing to write outside ${OUT_DIR}/: ${output}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    for (const [output, file] of assets) {
      const target = path.resolve(outDir, output);
      if (!target.startsWith(outDir + path.sep)) throw new VageError(`Refusing to write outside ${OUT_DIR}/: ${output}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
    }

    const result: BuildResult = {
      outDir,
      pages: model.pages.map((p) => ({ route: publicPath(p.route, model.site.trailingSlash), source: p.source, output: p.outFile })),
      redirects: model.redirects.map((r) => ({ from: r.from, to: r.to, output: r.outFile })),
      files: [...model.files.keys()],
      skippedDrafts: model.skippedDrafts,
      skippedScheduled: model.skippedScheduled.map(({ source, date }) => ({ source, date })),
      warnings: model.warnings,
      durationMs: Math.round(performance.now() - start),
    };
    return { result, model };
  } finally {
    await loader.close();
  }
}

/** Stylesheets in public/ (their url(/...) references need a subfolder site's prefix). */
function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return cssFiles(file);
    return e.isFile() && e.name.endsWith(".css") ? [file] : [];
  });
}
