import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VageError } from "../core/errors.js";

const exec = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs git without a shell. Non-zero exits are returned, not thrown, so callers can explain them. */
export async function gitRaw(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (e.code === "ENOENT") throw new VageError("git is not installed or not on PATH. Install git and retry.");
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const res = await gitRaw(cwd, args);
  if (res.code !== 0) throw new VageError(`git ${args[0]} failed: ${(res.stderr || res.stdout).trim()}`);
  return res.stdout.trim();
}

export interface ChangedFile {
  /** Two-letter porcelain status, e.g. "??", " M", "D ". */
  status: string;
  path: string;
}

/** Changes git would commit with `git add -A`, honoring .gitignore. */
export async function changedFiles(cwd: string): Promise<ChangedFile[]> {
  const out = (await gitRaw(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  const entries = out.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const status = entry.slice(0, 2);
    files.push({ status, path: entry.slice(3) });
    if (status.startsWith("R") || status.startsWith("C")) i++; // skip the rename source
  }
  return files;
}
