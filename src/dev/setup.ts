import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteConfig } from "../core/config.js";

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/starter", import.meta.url));

export interface SetupStep {
  id: string;
  label: string;
  /** What to do, in a sentence. */
  help: string;
  done: boolean;
  /** The page to open in the editor for this step (a source path with "/"), if it is a page. */
  page?: string;
}

/** Same file content as the starter's copy, ignoring line endings. False when either file is missing. */
function unchanged(root: string, rel: string): boolean {
  const mine = path.join(root, rel);
  const starter = path.join(TEMPLATE_DIR, rel);
  if (!fs.existsSync(mine) || !fs.existsSync(starter)) return false;
  const norm = (f: string) => fs.readFileSync(f).toString("utf8").replace(/\r\n/g, "\n");
  return norm(mine) === norm(starter);
}

/**
 * The editor's "next steps" for a new site: what still has the starter's placeholder content.
 * Each step is worked out from the project, so it ticks itself off when the owner (or an AI
 * assistant) does it, wherever they made the change. Pages that were deleted count as done.
 */
export function setupSteps(root: string, site: SiteConfig): SetupStep[] {
  const post = "src/pages/blog/first-post.md";
  const postFile = path.join(root, post);
  const postAuthorMissing = fs.existsSync(postFile) && !/^author:\s*\S/m.test(fs.readFileSync(postFile, "utf8").split(/^---\s*$/m)[1] ?? "");
  return [
    {
      id: "site",
      label: "Set your site's address",
      help: 'Change site in vage.config.ts to the address the site will live at, e.g. "https://www.yourname.com". Search engines and share previews use it.',
      done: !!site.site && !/^https?:\/\/(www\.)?example\.(com|org|net)$/.test(site.site),
    },
    {
      id: "title",
      label: "Name your site",
      help: "Change title (and description) in vage.config.ts. They appear in browser tabs, search results and llms.txt.",
      done: !!site.title && site.title !== "My Website",
    },
    { id: "home", label: "Write your home page", help: "Say who you are and what you offer, in your own words.", done: !unchanged(root, "src/pages/index.md"), page: "src/pages/index.md" },
    { id: "about", label: "Write your About page", help: "Who is behind the site. Search engines and AI assistants look for this.", done: !unchanged(root, "src/pages/about.md"), page: "src/pages/about.md" },
    {
      id: "author",
      label: "Put your name on the first post",
      help: "Add author (and authorUrl, a page about you) to the post, or delete the sample post. vagejs never fills in an author for you.",
      done: !postAuthorMissing,
      page: postAuthorMissing ? post : undefined,
    },
    {
      id: "icon",
      label: "Use your own icon",
      help: "Replace favicon.svg, favicon.ico and apple-touch-icon.png in public/ with your icon, keeping the names.",
      done: !unchanged(root, "public/favicon.svg"),
    },
    {
      id: "share-image",
      label: "Add a share image",
      help: 'Put a 1200x630 image in public/images/ and set seo: { defaultImage: "/images/og.png" } in vage.config.ts, so shared links show a picture.',
      done: !!site.seo.defaultImage,
    },
  ];
}

/** How to give an AI assistant vagejs's tools (`vage mcp`), as documented in the starter's AGENTS.md. */
export function connectInstructions(root: string) {
  return {
    install: "npm install --save-dev @modelcontextprotocol/sdk",
    claudeCode: "claude mcp add --transport stdio --scope project vagejs -- npx -p vagejs vage mcp",
    mcpJson: JSON.stringify({ mcpServers: { vagejs: { command: "npx", args: ["-p", "vagejs", "vage", "mcp", "--root", path.resolve(root)] } } }, null, 2),
  };
}
