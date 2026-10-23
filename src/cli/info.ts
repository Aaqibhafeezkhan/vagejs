import type { CAC } from "cac";
import { z } from "zod";
import { frontmatterSchema } from "../content/markdown.js";
import { CONFIG_FILES, configSchema } from "../core/config.js";

/**
 * Machine-readable description of the framework for coding agents. Commands
 * and schemas are read from the live CLI and Zod definitions, so they cannot
 * drift from the implementation.
 */
export function frameworkInfo(cli: CAC, version: string) {
  const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
  return {
    name: "vagejs",
    version,
    commands: cli.commands.map((c) => ({
      usage: `vage ${c.rawName}`,
      description: c.description,
      options: c.options
        .filter((o) => o.name !== "help")
        .map((o) => ({ flags: o.rawName, description: o.description, default: o.config.default })),
    })),
    exitCodes: { 0: "success", 1: "failure (build error, check errors, or check warnings with --strict)" },
    config: { files: CONFIG_FILES, schema: schema(configSchema) },
    frontmatter: { schema: schema(frontmatterSchema) },
    routing: {
      pagesDir: "src/pages",
      rules: [
        "src/pages/index.md -> /",
        "src/pages/about.md -> /about/",
        "src/pages/blog/index.md -> /blog/",
        "src/pages/blog/post.md -> /blog/post/",
        "src/pages/404.md -> dist/404.html (not a route)",
        "files or folders starting with _ are ignored",
        "two files mapping to one route is an error",
      ],
      layouts: "src/layouts/<name>.ts default-exports ({ content, page, site }) => string and must contain </head>",
    },
    generatedFiles: ["robots.txt", "sitemap.xml", "llms.txt", "llms-full.txt (opt-in)", "404.html", "redirect pages"],
    environment: {
      PAGESPEED_API_KEY: "optional; PageSpeed Insights quota for `vage audit --url`",
      CRUX_API_KEY: "optional; CrUX field data for `vage audit --url` (falls back to PAGESPEED_API_KEY)",
      GOOGLE_OAUTH_CLIENT_ID: "required for `vage connect`; Google Cloud OAuth client of type Desktop app",
      GOOGLE_OAUTH_CLIENT_SECRET: "optional; the Desktop client's secret",
      VAGE_CONFIG_DIR: "optional; where the Google token is stored (default: OS user config dir)",
    },
    notImplemented: [
      "Bing Webmaster Tools, IndexNow, Clarity, Plausible",
      "hosting providers other than GitHub Pages",
      "per-PR preview deployments",
      "MCP server",
    ],
  };
}
