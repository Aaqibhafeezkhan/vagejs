import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { VageError } from "../core/errors.js";
import { labReport, type LabReport, type Strategy } from "./remote.js";

type LighthouseResult = { lhr: Parameters<typeof labReport>[0] } | undefined;
type LighthouseFn = (url: string, flags: Record<string, unknown>, config?: unknown) => Promise<LighthouseResult>;
type Launcher = { launch(o: { chromeFlags: string[] }): Promise<{ port: number; kill(): void }> };

/**
 * Loads Lighthouse from the user's project. It is an optional peer dependency
 * (large, and needs Chrome), so it is never required for build or check.
 */
async function loadLighthouse(root: string): Promise<{ lighthouse: LighthouseFn; desktopConfig: unknown; launcher: Launcher }> {
  const require = createRequire(pathToFileURL(`${root}/package.json`));
  let entry: string;
  try {
    entry = require.resolve("lighthouse");
  } catch {
    throw new VageError('Lighthouse is not installed. Run "npm install --save-dev lighthouse" (requires Chrome), or audit without --lighthouse.');
  }
  const mod = await import(pathToFileURL(entry).href);
  // chrome-launcher is a Lighthouse dependency; resolve it from there.
  const launcher = await import(pathToFileURL(createRequire(entry).resolve("chrome-launcher")).href);
  return { lighthouse: mod.default, desktopConfig: mod.desktopConfig, launcher };
}

/** Runs Lighthouse (lab) against already-served URLs. */
export async function runLighthouse(root: string, urls: string[], strategies: Strategy[]): Promise<LabReport[]> {
  const { lighthouse, desktopConfig, launcher } = await loadLighthouse(root);
  let chrome: { port: number; kill(): void };
  try {
    chrome = await launcher.launch({ chromeFlags: ["--headless=new"] });
  } catch (err) {
    throw new VageError(`Could not start Chrome for Lighthouse: ${(err as Error).message}. Install Chrome or set CHROME_PATH.`);
  }
  try {
    const reports: LabReport[] = [];
    for (const url of urls) {
      for (const strategy of strategies) {
        const result = await lighthouse(
          url,
          { port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance", "accessibility", "seo", "best-practices"] },
          strategy === "desktop" ? desktopConfig : undefined,
        );
        if (!result) throw new VageError(`Lighthouse returned no result for ${url}.`);
        reports.push(labReport(result.lhr, "lighthouse", url, strategy));
      }
    }
    return reports;
  } finally {
    chrome.kill();
  }
}
