import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Last commit date (ISO) of every file under src/pages, from one `git log` call.
 * Returns undefined with a reason when dates would be wrong or unavailable: not a git
 * repository, or a shallow clone (CI's default), where every file seems to change in
 * the latest commit.
 */
export function gitPageDates(root: string): { dates?: Map<string, string>; problem?: string } {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return { problem: "the project isn't a git repository" };
    if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
      return { problem: "this is a shallow git clone, so every page would get the latest commit's date (in GitHub Actions, use actions/checkout with fetch-depth: 0)" };
    }
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    // git prints real paths; compare against the project's real path (e.g. /var -> /private/var on macOS).
    const real = fs.realpathSync(root);
    const out = git(["log", "--format=@@%cI", "--name-only", "--no-renames", "--", path.join(root, "src", "pages")]);
    const dates = new Map<string, string>();
    let current = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("@@")) current = line.slice(2).trim();
      else if (line.trim() && current) {
        const rel = path.relative(real, path.join(top, line.trim()));
        if (!dates.has(rel)) dates.set(rel, current); // newest first: keep the first date seen
      }
    }
    return { dates };
  } catch {
    return { problem: "git isn't available" };
  }
}
