import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

/**
 * After `npm create vagejs@latest my-site`: offer to install and start the site, so a person
 * goes from one command to a running site. Only when a person is at an interactive terminal:
 * AI assistants and CI run create too, and a dev server would never let their command finish,
 * so for them (and with --no-install) the next steps are printed as before.
 */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** The package manager that ran `create` ("pnpm create vagejs" sets npm_config_user_agent to "pnpm/9.x ..."). */
export function packageManager(userAgent = process.env.npm_config_user_agent): PackageManager {
  const name = userAgent?.split("/")[0];
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

export function nextSteps(rel: string, pm: PackageManager): string {
  return `Next steps:\n  cd ${rel}\n  ${pm} install\n  ${pm} start\n\n${pm} start opens the site in your browser. ${pm} run dev starts it without opening one.`;
}

export interface StartOptions {
  /** The new site's folder, and how to name it in messages (relative to where create ran). */
  dir: string;
  rel: string;
  pm: PackageManager;
  /** A person at a terminal (stdin and stdout are TTYs, not CI). */
  interactive: boolean;
  /** --yes: install and start without asking. */
  yes?: boolean;
  /** --no-install sets this to false. */
  install?: boolean;
  ask?: (question: string) => Promise<boolean>;
  /** Runs a command in `cwd` with the terminal attached; returns its exit code. */
  run?: (cmd: string, args: string[], cwd: string) => number;
  log?: (line: string) => void;
}

/** Installs and starts the new site when asked to; returns the exit code for create. */
export async function installAndStart(o: StartOptions): Promise<number> {
  const log = o.log ?? console.log;
  const run = o.run ?? runAttached;
  const go = o.install === false ? false : o.yes ? true : o.interactive ? await (o.ask ?? askYesNo)("Install and start the site now? (Y/n) ") : false;
  if (!go) {
    log(nextSteps(o.rel, o.pm));
    return 0;
  }
  log(`\nInstalling with ${o.pm}…`);
  if (run(o.pm, ["install"], o.dir) !== 0) {
    log(`\nThe install didn't finish (see the message above). Your site's files are ready; to try again:\n  cd ${o.rel}\n  ${o.pm} install\n  ${o.pm} start`);
    return 1;
  }
  // Said before starting: once the dev server runs, Ctrl+C ends this command too.
  log(`\nStarting the site. Ctrl+C stops it. To start it again later:\n  cd ${o.rel}\n  ${o.pm} start\n`);
  return run(o.pm, ["start"], o.dir);
}

function runAttached(cmd: string, args: string[], cwd: string): number {
  // npm, pnpm, yarn and bun are .cmd files on Windows, which need a shell; the arguments are fixed words.
  return spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" }).status ?? 1;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^\s*n/i.test(await rl.question(question));
  } catch {
    return false; // Ctrl+C or Ctrl+D at the question: just show the next steps
  } finally {
    rl.close();
  }
}
