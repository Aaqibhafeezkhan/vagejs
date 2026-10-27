import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VageError } from "../core/errors.js";

const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/starter", import.meta.url));

/** npm strips .gitignore from published packages, so templates store it under this name. */
const RENAMES: Record<string, string> = { _gitignore: ".gitignore" };

export interface CreateResult {
  dir: string;
  files: string[];
}

/**
 * Copies the starter template into `dir`. Refuses to write into a non-empty
 * directory. `vageSpec` is the dependency spec written to package.json
 * (a version range, or e.g. "file:../vagejs-0.1.0.tgz" while unpublished).
 */
export function createProject(dir: string, vageSpec: string): CreateResult {
  dir = path.resolve(dir);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new VageError(`${dir} already exists and is not empty. Choose a new directory name.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(TEMPLATE_DIR, dir, { recursive: true });
  for (const [from, to] of Object.entries(RENAMES)) {
    if (fs.existsSync(path.join(dir, from))) fs.renameSync(path.join(dir, from), path.join(dir, to));
  }

  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.name = toPackageName(path.basename(dir));
  pkg.devDependencies.vagejs = vageSpec;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  // The sample post is published today, so its date is real.
  const post = path.join(dir, "src", "pages", "blog", "first-post.md");
  if (fs.existsSync(post)) {
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(post, fs.readFileSync(post, "utf8").replace(/^datePublished: .*$/m, `datePublished: ${today}`));
  }

  return { dir, files: listFiles(dir) };
}

function toPackageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-~._]+/g, "-").replace(/^[-._]+/, "") || "my-website";
}

function listFiles(dir: string, prefix = ""): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}
