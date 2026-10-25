import fs from "node:fs";
import path from "node:path";
import { VageError } from "./errors.js";
import { createBuildLoader } from "./loader.js";
import { renderSite, type SiteModel } from "./site.js";

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
    const outputs = new Map<string, string>();
    for (const page of model.pages) outputs.set(page.outFile, page.html);
    if (model.notFound) outputs.set(model.notFound.outFile, model.notFound.html);
    for (const r of model.redirects) outputs.set(r.outFile, r.html);
    for (const [name, content] of model.files) outputs.set(name, content);
    const assets = new Map<string, string>();
    for (const p of [...model.pages, ...(model.notFound ? [model.notFound] : [])]) for (const [k, f] of p.assets) assets.set(k, f);

    fs.rmSync(outDir, { recursive: true, force: true });
    const publicDir = path.join(root, "public");
    if (fs.existsSync(publicDir)) fs.cpSync(publicDir, outDir, { recursive: true });
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
      pages: model.pages.map((p) => ({ route: p.route, source: p.source, output: p.outFile })),
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
