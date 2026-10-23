import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check } from "../checks/check.js";
import { build } from "../core/build.js";
import { VageError } from "../core/errors.js";
import { assertBranchName, assertGitRemote } from "../core/validate.js";
import { changedFiles, git, gitRaw, type ChangedFile } from "./git.js";
import { findSecrets } from "./secrets.js";

export interface PublishPlan {
  root: string;
  /** True when `git init` will run (the folder is not a repository yet). */
  initRepo: boolean;
  branch: string;
  /** Remote URL that will be pushed to, if any. */
  remote?: string;
  /** True when `--remote` will be added as "origin". */
  addRemote: boolean;
  files: ChangedFile[];
  /** Files VAGE JS will create (they do not exist yet). */
  extraFiles: Record<string, string>;
  message: string;
  /** Local commits not yet on the remote (before this commit). */
  unpushedCommits: number;
  warnings: string[];
}

export interface PublishResult {
  plan: PublishPlan;
  status: "published" | "committed" | "aborted" | "up-to-date";
  commit?: string;
  /** Set only after `git ls-remote` shows the remote branch at our commit. */
  confirmedRemote?: { url: string; branch: string; sha: string };
}

export interface PublishOptions {
  remote?: string;
  branch?: string;
  message?: string;
  /** Receives the full plan; nothing is changed unless it resolves true. */
  confirm: (plan: PublishPlan) => Promise<boolean>;
  /** Files to create if missing, before committing (e.g. a deploy workflow): relative path -> content, given the branch. */
  extraFiles?: (branch: string) => Record<string, string>;
}

const BLOCKED_DIRS = ["node_modules/", "dist/"];

/**
 * Safe commit-and-push: runs check and build, refuses secrets and build
 * output, shows the plan, asks for confirmation, never force-pushes, and
 * reports success only after the remote confirms the commit.
 */
export async function publish(root: string, options: PublishOptions): Promise<PublishResult> {
  const plan = await planPublish(root, options);
  const nothingToCommit = plan.files.length === 0;
  if (nothingToCommit && plan.unpushedCommits === 0 && !plan.initRepo) return { plan, status: "up-to-date" };
  if (!(await options.confirm(plan))) return { plan, status: "aborted" };

  const cwd = plan.root;
  if (plan.initRepo) await git(cwd, ["init", "-b", plan.branch]);
  if (plan.addRemote) await git(cwd, ["remote", "add", "--", "origin", plan.remote!]);
  for (const [rel, content] of Object.entries(plan.extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content);
  }

  let commit: string | undefined;
  if (!nothingToCommit) {
    await git(cwd, ["add", "-A"]);
    // Re-check what is actually staged: the tree may have changed since the plan was shown.
    const staged = (await git(cwd, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
    const planned = new Set(plan.files.map((f) => f.path));
    const unexpected = staged.filter((f) => !planned.has(f));
    if (unexpected.length) {
      await git(cwd, ["reset", "-q"]);
      throw new VageError(`Files changed after the plan was shown and were not committed: ${unexpected.join(", ")}. Re-run to review.`);
    }
    await git(cwd, ["commit", "-q", "-m", plan.message]);
    commit = await git(cwd, ["rev-parse", "HEAD"]);
  }
  commit ??= await git(cwd, ["rev-parse", "HEAD"]);
  if (!plan.remote) return { plan, status: "committed", commit };

  const push = await gitRaw(cwd, ["push", "-u", "origin", "--", plan.branch]);
  if (push.code !== 0) {
    const out = push.stderr + push.stdout;
    if (/rejected|non-fast-forward|fetch first/i.test(out)) {
      throw new VageError(
        `Push rejected: origin/${plan.branch} has commits you don't have. Your commit is saved locally. ` +
          `Run "git pull --rebase origin ${plan.branch}", resolve any conflicts, then publish again. VAGE JS never force-pushes.`,
      );
    }
    throw new VageError(`Push failed (your commit is saved locally): ${out.trim()}`);
  }
  const remoteSha = (await git(cwd, ["ls-remote", "origin", `refs/heads/${plan.branch}`])).split(/\s/)[0];
  if (remoteSha !== commit) {
    throw new VageError(`Push finished but origin/${plan.branch} is at ${remoteSha || "nothing"}, not ${commit}. Check the remote before retrying.`);
  }
  return { plan, status: "published", commit, confirmedRemote: { url: plan.remote, branch: plan.branch, sha: remoteSha } };
}

export async function planPublish(root: string, options: Omit<PublishOptions, "confirm">): Promise<PublishPlan> {
  root = path.resolve(root);
  if (options.branch) assertBranchName(options.branch);
  if (options.remote) assertGitRemote(options.remote);
  const checked = await check(root);
  if (checked.errors > 0) throw new VageError(`vage check found ${checked.errors} error(s). Fix them (run "vage check") before publishing.`);
  await build(root);

  const top = await gitRaw(root, ["rev-parse", "--show-toplevel"]);
  const initRepo = top.code !== 0;
  const cwd = initRepo ? root : fs.realpathSync(top.stdout.trim());
  const warnings: string[] = [];

  let branch: string;
  if (initRepo) {
    branch = options.branch ?? "main";
  } else {
    branch = await git(cwd, ["branch", "--show-current"]);
    if (!branch) throw new VageError("HEAD is detached. Check out a branch before publishing.");
    if (options.branch && options.branch !== branch) {
      throw new VageError(`You are on "${branch}", not "${options.branch}". Switch branches yourself first; VAGE JS won't do it for you.`);
    }
  }

  const origin = initRepo ? undefined : await gitRaw(cwd, ["remote", "get-url", "origin"]);
  const existingRemote = origin?.code === 0 ? origin.stdout.trim() : undefined;
  if (options.remote && existingRemote && options.remote !== existingRemote) {
    throw new VageError(`origin is already ${existingRemote}. Change it yourself with "git remote set-url" if that is intended.`);
  }
  const remote = existingRemote ?? options.remote;
  if (!remote) warnings.push('No remote: changes will be committed locally only. Pass --remote <git-url> to push (e.g. a repo created with "gh repo create").');

  const files = initRepo ? await filesForNewRepo(root) : await changedFiles(cwd);
  const blocked = files.filter((f) => BLOCKED_DIRS.some((d) => f.path.startsWith(d) || f.path.includes(`/${d}`)));
  if (blocked.length) {
    throw new VageError(`Refusing to commit build output or dependencies (${blocked[0]!.path}, …). Add node_modules/ and dist/ to .gitignore.`);
  }
  const secrets = findSecrets(cwd, files.filter((f) => !f.status.includes("D")).map((f) => f.path));
  if (secrets.length) {
    throw new VageError(
      `Refusing to commit possible secrets:\n${secrets.map((s) => `  ${s.path}: ${s.reason}`).join("\n")}\n` +
        "Add them to .gitignore (and rotate any real credential that was exposed). False positive? Commit manually with git.",
    );
  }

  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const local = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, v]) => String(v).startsWith("file:"));
    if (local.length) warnings.push(`package.json uses local "file:" dependencies (${local.map(([k]) => k).join(", ")}); CI and other machines cannot install them.`);
  }

  let unpushedCommits = 0;
  if (!initRepo && remote && (await gitRaw(cwd, ["rev-parse", "HEAD"])).code === 0) {
    const tracking = await gitRaw(cwd, ["rev-list", "--count", `origin/${branch}..HEAD`]);
    unpushedCommits = tracking.code === 0 ? Number(tracking.stdout.trim()) : Number(await git(cwd, ["rev-list", "--count", "HEAD"]));
  }

  // Generated files are only created when missing, never overwritten; they are part of the commit.
  const extraFiles = Object.fromEntries(Object.entries(options.extraFiles?.(branch) ?? {}).filter(([rel]) => !fs.existsSync(path.join(cwd, rel))));
  for (const rel of Object.keys(extraFiles)) files.push({ status: "??", path: rel });

  return {
    root: cwd,
    initRepo,
    branch,
    remote,
    addRemote: Boolean(options.remote && !existingRemote),
    files,
    extraFiles,
    message: options.message ?? "Publish site with VAGE JS",
    unpushedCommits,
    warnings,
  };
}

/** Lists what `git add -A` would stage in a folder that is not a repo yet, honoring .gitignore, without touching it. */
async function filesForNewRepo(root: string): Promise<ChangedFile[]> {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "vage-plan-"));
  try {
    await git(root, ["--git-dir", gitDir, "--work-tree", root, "init", "-q"]);
    const out = await git(root, ["--git-dir", gitDir, "--work-tree", root, "ls-files", "--others", "--exclude-standard", "-z"]);
    return out.split("\0").filter(Boolean).sort().map((p) => ({ status: "??", path: p }));
  } finally {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
}
