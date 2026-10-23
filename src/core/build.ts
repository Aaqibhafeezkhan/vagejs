import fs from "node:fs";
import path from "node:path";
import { createBuildLoader } from "./loader.js";
import { renderSite } from "./site.js";

export const OUT_DIR = "dist";

export interface BuildResult {
  outDir: string;
  pages: { route: string; source: string; output: string }[];
  redirects: { from: string; to: string; output: string }[];
  files: string[];
  skippedDrafts: string[];
  warnings: string[];
  durationMs: number;
}

export async function build(root: string): Promise<BuildResult> {
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

    fs.rmSync(outDir, { recursive: true, force: true });
    const publicDir = path.join(root, "public");
    if (fs.existsSync(publicDir)) fs.cpSync(publicDir, outDir, { recursive: true });
    for (const [output, content] of outputs) {
      const target = path.join(outDir, output);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }

    return {
      outDir,
      pages: model.pages.map((p) => ({ route: p.route, source: p.source, output: p.outFile })),
      redirects: model.redirects.map((r) => ({ from: r.from, to: r.to, output: r.outFile })),
      files: [...model.files.keys()],
      skippedDrafts: model.skippedDrafts,
      warnings: model.warnings,
      durationMs: Math.round(performance.now() - start),
    };
  } finally {
    await loader.close();
  }
}
