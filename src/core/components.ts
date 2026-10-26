import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { VageError } from "./errors.js";

/**
 * React, Vue and MDX support. Components render to HTML at build time: nothing runs in
 * the browser. The packages are optional and come from the project, so sites that
 * don't use them install nothing extra.
 */

const INSTALL = {
  react: "npm install react react-dom",
  vue: "npm install vue && npm install --save-dev @vitejs/plugin-vue",
  mdx: "npm install react react-dom && npm install --save-dev @mdx-js/mdx",
};

function resolveFrom(root: string, spec: string): string | undefined {
  try {
    return createRequire(path.join(root, "package.json")).resolve(spec);
  } catch {
    return undefined;
  }
}

/** Imports a package installed in the project, or explains how to install it. */
async function projectImport<T>(root: string, spec: string, needed: string, install: string): Promise<T> {
  const resolved = resolveFrom(root, spec);
  if (!resolved) throw new VageError(`${needed} needs the "${spec}" package. Install it with: ${install}`);
  return (await import(pathToFileURL(resolved).href)) as T;
}

/** A component file's kind, from its extension. */
export function componentKind(file: string): "react" | "vue" | undefined {
  if (/\.[jt]sx$/.test(file)) return "react";
  if (file.endsWith(".vue")) return "vue";
  return undefined;
}

type ReactModule = { createElement: (type: unknown, props?: unknown) => unknown };
type ReactDomServer = { renderToStaticMarkup: (element: unknown) => string };

/** Renders a React component (a layout or an MDX page) to static HTML. */
export async function renderReact(root: string, component: unknown, props: object, needed: string): Promise<string> {
  const react = await projectImport<ReactModule>(root, "react", needed, INSTALL.react);
  const server = await projectImport<ReactDomServer>(root, "react-dom/server", needed, INSTALL.react);
  return server.renderToStaticMarkup(react.createElement(component, props));
}

type VueModule = { createSSRApp: (root: object) => unknown; h: (type: unknown, props?: unknown) => unknown };
type VueServer = { renderToString: (app: unknown) => Promise<string> };

/** Renders a Vue component to static HTML. Props it doesn't declare are dropped, not written as attributes. */
export async function renderVue(root: string, component: object, props: object, needed: string): Promise<string> {
  const vue = await projectImport<VueModule>(root, "vue", needed, INSTALL.vue);
  const server = await projectImport<VueServer>(root, "vue/server-renderer", needed, INSTALL.vue);
  const app = vue.createSSRApp({ render: () => vue.h({ ...component, inheritAttrs: false }, props) });
  // Vue marks fragments with <!--[--> comments for hydration; static pages don't need them.
  return (await server.renderToString(app)).replace(/<!--[[\]]-->/g, "");
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Vite plugins for .mdx pages and .vue files. When a package is missing, loading such a
 * file fails with the install command instead of a parse error.
 */
export async function componentPlugins(root: string): Promise<Plugin[]> {
  const mdx: Plugin = {
    name: "vage:mdx",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0]!;
      if (!file.endsWith(".mdx")) return null;
      const { compile } = await projectImport<{ compile: (source: string, options: object) => Promise<{ toString(): string }> }>(root, "@mdx-js/mdx", `MDX page ${path.relative(root, file)}`, INSTALL.mdx);
      // Frontmatter is vagejs's, not MDX's: blank it out, keeping line numbers for errors.
      const body = code.replace(FRONTMATTER, (m) => m.replace(/[^\n]/g, ""));
      return { code: String(await compile(body, { jsxImportSource: "react", development: false })), map: null };
    },
  };
  const vuePlugin = resolveFrom(root, "@vitejs/plugin-vue");
  if (vuePlugin) {
    const { default: vue } = (await import(pathToFileURL(vuePlugin).href)) as { default: () => Plugin };
    return [mdx, vue()];
  }
  const missingVue: Plugin = {
    name: "vage:vue-missing",
    enforce: "pre",
    load(id) {
      const file = id.split("?")[0]!;
      if (file.endsWith(".vue")) throw new VageError(`${path.relative(root, file)} needs the "@vitejs/plugin-vue" package. Install it with: ${INSTALL.vue}`);
      return null;
    },
  };
  return [mdx, missingVue];
}
