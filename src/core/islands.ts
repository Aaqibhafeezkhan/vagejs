import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { VageError } from "./errors.js";

/**
 * Interactive islands: a React component marked `client:load`, `client:visible` or
 * `client:idle` is rendered to HTML like any other, then made interactive in the browser.
 * Pages without islands still send no JavaScript.
 *
 * - On the server, JSX goes through a small runtime ("vage:jsx") that turns a component
 *   with a client: directive into <vage-island data-island=KEY data-props=JSON>…</vage-island>.
 * - Components in src/components/ are tagged with their file and export name, so the
 *   island's KEY says which code to send.
 * - The build bundles one entry per island plus runtime.js into /_vage/islands/.
 */

export const ISLANDS_DIR = "_vage/islands";
export const JSX_SOURCE = "vage:jsx";
const RUNTIME_ID = "\0vage:jsx-runtime";
const DEV_RUNTIME_ID = "\0vage:jsx-dev-runtime";

export interface IslandSource {
  key: string;
  /** Absolute path of the component's file. */
  file: string;
  /** The export the component comes from ("default" or a name). */
  name: string;
}

/** Islands seen while rendering, by key. Shared through globalThis because layouts run inside Vite's module runner. */
export function islandRegistry(): Map<string, IslandSource> {
  const g = globalThis as { __vageIslands?: Map<string, IslandSource> };
  return (g.__vageIslands ??= new Map());
}

/** Keys of the islands on a rendered page. */
export function islandKeys(html: string): string[] {
  return [...new Set([...html.matchAll(/<vage-island\b[^>]*\bdata-island="([\w-]+)"/g)].map((m) => m[1]!))];
}

/** Adds the island loader to a page that has islands. */
export function injectIslandRuntime(html: string): string {
  if (!islandKeys(html).length) return html;
  const tag = `<script type="module" src="/${ISLANDS_DIR}/runtime.js"></script>`;
  return html.replace(/<\/head>/i, `    ${tag}\n  </head>`);
}

const directives = (create: string) => `
const WHEN = ["load", "visible", "idle"];
function island(create, type, props, rest) {
  const label = (type && (type.displayName || type.name)) || "Component";
  const found = Object.keys(props).filter((k) => k.startsWith("client:"));
  if (found.length > 1) throw new Error("<" + label + "> has " + found.join(" and ") + ": use one client: directive.");
  const when = found[0].slice("client:".length);
  if (!WHEN.includes(when)) throw new Error("client:" + when + " on <" + label + "> isn't a vagejs directive. Use client:load, client:visible or client:idle.");
  const source = type && type.__vageIsland;
  if (!source) throw new Error("<" + label + " client:" + when + "> must be a function component exported from a file in src/components/, so vagejs knows which code to send to the browser.");
  const own = {};
  for (const k of Object.keys(props)) if (!k.startsWith("client:")) own[k] = props[k];
  if (own.children !== undefined) throw new Error("<" + label + " client:" + when + "> can't have content between its tags yet. Pass text as a prop instead.");
  let json;
  try {
    json = JSON.stringify(own, (k, v) => {
      if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new Error(k);
      return v;
    });
  } catch (err) {
    throw new Error("Props of <" + label + " client:" + when + "> must be plain data (text, numbers, true/false, lists and objects). \\"" + err.message + "\\" isn't.");
  }
  const render = globalThis.__vageRenderIsland;
  if (!render) throw new Error("client: directives work in React layouts and MDX pages.");
  (globalThis.__vageIslands ??= new Map()).set(source.key, source);
  return ${create}("vage-island", { "data-island": source.key, "data-when": when, "data-props": json, dangerouslySetInnerHTML: { __html: render(type, own) } }, ...rest);
}
const hasDirective = (type, props) => typeof type !== "string" && props != null && Object.keys(props).some((k) => k.startsWith("client:"));
`;

const RUNTIME_CODE = `import { jsx as reactJsx, jsxs as reactJsxs, Fragment } from "react/jsx-runtime";
${directives("reactJsx")}
export { Fragment };
export const jsx = (type, props, ...rest) => (hasDirective(type, props) ? island(reactJsx, type, props, rest) : reactJsx(type, props, ...rest));
export const jsxs = (type, props, ...rest) => (hasDirective(type, props) ? island(reactJsx, type, props, rest) : reactJsxs(type, props, ...rest));
`;

const DEV_RUNTIME_CODE = `import { jsxDEV as reactJsxDEV, Fragment } from "react/jsx-dev-runtime";
${directives("reactJsxDEV")}
export { Fragment };
export const jsxDEV = (type, props, ...rest) => (hasDirective(type, props) ? island(reactJsxDEV, type, props, rest) : reactJsxDEV(type, props, ...rest));
`;

/** A short, stable key for one export of one file: "counter-1a2b3c4d-default". */
function keyBase(root: string, file: string): string {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const stem = path.basename(file).replace(/\.[^.]+$/, "").replace(/[^\w-]/g, "_").toLowerCase();
  return `${stem}-${createHash("sha256").update(rel).digest("hex").slice(0, 8)}`;
}

/**
 * Server-side plugins: the "vage:jsx" runtime that React layouts, components and MDX
 * pages compile to, and tags on every function exported from src/components/.
 */
export function islandPlugins(root: string): Plugin[] {
  // Vite reports files by their real path (/private/var/… for /var/… on macOS).
  const realRoot = fs.existsSync(root) ? fs.realpathSync.native(root) : root;
  // Windows paths compare without case ("C:\" and "c:\").
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const componentsDirs = [root, realRoot].map((r) => norm(path.join(r, "src", "components") + path.sep));
  return [
    {
      name: "vage:jsx",
      enforce: "pre",
      config: () => ({ oxc: { jsx: { runtime: "automatic", importSource: JSX_SOURCE } } }),
      resolveId(id) {
        if (id === `${JSX_SOURCE}/jsx-runtime`) return RUNTIME_ID;
        if (id === `${JSX_SOURCE}/jsx-dev-runtime`) return DEV_RUNTIME_ID;
        return null;
      },
      load(id) {
        if (id === RUNTIME_ID) return RUNTIME_CODE;
        if (id === DEV_RUNTIME_ID) return DEV_RUNTIME_CODE;
        return null;
      },
    },
    {
      name: "vage:island-sources",
      enforce: "post",
      transform(code, id, options) {
        const file = path.normalize(id.split("?")[0]!);
        if (!options?.ssr || !componentsDirs.some((d) => norm(file).startsWith(d)) || !/\.[jt]sx?$/.test(file)) return null;
        const base = keyBase(norm(file).startsWith(componentsDirs[0]!) ? root : realRoot, file);
        // __vite_ssr_exports__ is the module's exports object in Vite's server module runner.
        const tag = `\n;for (const __vageName of Object.keys(__vite_ssr_exports__)) { const __vageValue = __vite_ssr_exports__[__vageName]; if (typeof __vageValue === "function" && !Object.prototype.hasOwnProperty.call(__vageValue, "__vageIsland")) { try { Object.defineProperty(__vageValue, "__vageIsland", { value: { key: ${JSON.stringify(base)} + "-" + __vageName.replace(/[^\\w-]/g, "_"), file: ${JSON.stringify(file)}, name: __vageName } }); } catch {} } }\n`;
        return { code: code + tag, map: null };
      },
    },
  ];
}

/** The browser loader: finds islands on the page and loads each one when its directive says. */
const LOADER_CODE = `const start = (el) =>
  import(new URL("./" + el.dataset.island + ".js", import.meta.url).href).then((m) => m.default(el, JSON.parse(el.dataset.props || "{}")));
for (const el of document.querySelectorAll("vage-island[data-island]")) {
  const when = el.dataset.when;
  if (when === "visible" && "IntersectionObserver" in window) {
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        seen.disconnect();
        start(el);
      }
    });
    seen.observe(el);
  } else if (when === "idle" && "requestIdleCallback" in window) requestIdleCallback(() => start(el));
  else start(el);
}
`;

/**
 * Bundles the browser code for these islands with Vite: runtime.js, one entry per island
 * (KEY.js) and shared chunks. Returns file name -> contents, for /_vage/islands/.
 */
export async function bundleIslands(root: string, islands: IslandSource[], options: { dev?: boolean } = {}): Promise<Map<string, string>> {
  const { build } = await import("vite");
  const entryId = (key: string) => `\0vage-island:${key}`;
  const byKey = new Map(islands.map((i) => [i.key, i]));
  const input: Record<string, string> = { runtime: "\0vage-island-runtime" };
  for (const key of byKey.keys()) input[key] = entryId(key);
  const out = await build({
    root,
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    mode: options.dev ? "development" : "production",
    // The build's own Vite server already set NODE_ENV=development for this process; React's production build needs it pinned.
    define: { "process.env.NODE_ENV": JSON.stringify(options.dev ? "development" : "production") },
    oxc: { jsx: { runtime: "automatic", importSource: "react", development: !!options.dev } },
    plugins: [
      {
        name: "vage:island-entries",
        resolveId: (id) => (id === "\0vage-island-runtime" || id.startsWith("\0vage-island:") ? id : null),
        load(id) {
          if (id === "\0vage-island-runtime") return LOADER_CODE;
          if (!id.startsWith("\0vage-island:")) return null;
          const island = byKey.get(id.slice("\0vage-island:".length))!;
          const importLine = island.name === "default" ? `import Component from ${JSON.stringify(island.file)};` : `import { ${island.name} as Component } from ${JSON.stringify(island.file)};`;
          return `import { createElement } from "react";\nimport { hydrateRoot } from "react-dom/client";\n${importLine}\nexport default (el, props) => hydrateRoot(el, createElement(Component, props));\n`;
        },
      },
    ],
    build: {
      write: false,
      minify: !options.dev,
      modulePreload: false,
      copyPublicDir: false,
      rollupOptions: { input, preserveEntrySignatures: "exports-only", output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "chunk-[hash].js" } },
    },
  }).catch((err: Error) => {
    throw new VageError(`Couldn't bundle the interactive components: ${err.message}`);
  });
  const files = new Map<string, string>();
  for (const result of Array.isArray(out) ? out : [out]) {
    if (!("output" in result)) continue;
    for (const item of result.output) if (item.type === "chunk") files.set(item.fileName, item.code);
  }
  return files;
}
