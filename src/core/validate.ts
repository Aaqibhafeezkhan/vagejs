import { VageError } from "./errors.js";

/**
 * Validators for values that reach other programs (git, wrangler, npm) as
 * arguments. A leading "-" would be read as an option, so it is always refused.
 */
export function assertBranchName(value: string, flag = "--branch"): string {
  if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/.test(value) || value.endsWith("/") || value.endsWith(".lock")) {
    throw new VageError(`Invalid ${flag} "${value}". Use letters, digits, ".", "_", "-" and "/" (not starting with "-").`);
  }
  return value;
}

export function assertCloudflareProject(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(value)) throw new VageError(`Invalid --project "${value}". Use lowercase letters, digits and "-".`);
  return value;
}

/** Cloudflare Worker names: lowercase letters, digits and "-", up to 63 characters. */
export function assertWorkerName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new VageError(`Invalid Worker name "${value}". Use lowercase letters, digits and "-" (up to 63).`);
  return value;
}

/** https://, ssh://, git@host:path, or a local path. Refuses options and git's command-running transports. */
export function assertGitRemote(value: string): string {
  if (value.startsWith("-") || /^(ext|fd)::/i.test(value) || /[\s\u0000-\u001f]/.test(value)) {
    throw new VageError(`Invalid --remote "${value}". Use an https://, ssh:// or git@host:owner/repo.git URL.`);
  }
  return value;
}

/** npm dependency spec for new projects: a version/range, "latest", or a local file: tarball. */
export function assertVageSpec(value: string): string {
  if (!/^(latest|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|file:[^\s]+)$/.test(value)) {
    throw new VageError(`Invalid --vage-spec "${value}". Use a version like ^0.1.0, "latest", or file:<path-to-tarball>.`);
  }
  return value;
}
