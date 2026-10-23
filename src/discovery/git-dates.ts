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
  // core.quotepath=off: print non-ASCII file names as-is (default would quote "caf\303\251.md").
  const git = (args: string[]) => execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  try {
    git(["--version"]);
  } catch {
    return { problem: "git isn't available" };
  }
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return { problem: "the project isn't a git repository" };
  } catch {
    return { problem: "the project isn't a git repository" };
  }
  try {
    if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
      return { problem: "this is a shallow git clone, so every page would get the latest commit's date (in GitHub Actions, use actions/checkout with fetch-depth: 0)" };
    }
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    // git prints real paths; compare against the project's real path (e.g. /var -> /private/var on macOS).
    const real = fs.realpathSync(root);
    // -z: NUL-separated, so file names with quotes, spaces or newlines come through exactly.
    const out = git(["log", "-z", "--format=@@%cI", "--name-only", "--no-renames", "--", path.join(root, "src", "pages")]);
    const dates = new Map<string, string>();
    let current = "";
    for (const raw of out.split("\0")) {
      const field = raw.replace(/^\n+/, "");
      if (!field) continue;
      const header = /^@@(\S+)\n?([\s\S]*)$/.exec(field);
      const name = header ? header[2]! : field;
      if (header) current = header[1]!;
      if (name && current) {
        const rel = path.relative(real, path.join(top, name));
        if (!dates.has(rel)) dates.set(rel, current); // newest first: keep the first date seen
      }
    }
    return { dates };
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim().split("\n")[0];
    return { problem: `reading the git history failed (${stderr || (err as Error).message.split("\n")[0]})` };
  }
}
