import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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
  return (
    `Next steps:\n  cd ${rel}\n  ${pm} install\n  ${pm} start\n\n${pm} start opens the site in your browser. ${pm} run dev starts it without opening one.\n\n` +
    `AI assistants setting this site up for someone: install, read ${rel}/AGENTS.md ("New site? Start here"), run ${pm} run dev, ` +
    `then go through \`npx vage next-steps\` with the site owner. Ask them for the real details (name, address, who they are); never invent them.`
  );
}

/**
 * What a person can build the new site with. Terminal assistants run in this terminal with a
 * first prompt (the site keeps running in the background); editors open the folder. Each
 * starts with the same first prompt, which points it at AGENTS.md and `vage next-steps`.
 * Only tools found on PATH are offered.
 */
export const FIRST_PROMPT =
  "Read AGENTS.md, then help me set up this new website. Ask me about my business and work through npx vage next-steps with me. Use only details I give you.";

export type ToolId = "claude" | "codex" | "gemini" | "vscode" | "cursor" | "editor" | "site";

interface Tool {
  id: ToolId;
  label: string;
  /** The command on PATH; none for the browser editor and the plain site. */
  command?: string;
  kind: "terminal" | "app" | "browser";
  /** Arguments that start it in the site's folder (the cwd) with the first prompt. */
  args?: (dir: string) => string[];
}

const TOOLS: Tool[] = [
  { id: "claude", label: "Claude Code", command: "claude", kind: "terminal", args: () => [FIRST_PROMPT] },
  { id: "codex", label: "Codex", command: "codex", kind: "terminal", args: () => [FIRST_PROMPT] },
  { id: "gemini", label: "Gemini CLI", command: "gemini", kind: "terminal", args: () => ["-i", FIRST_PROMPT] },
  { id: "vscode", label: "VS Code (Copilot chat)", command: "code", kind: "app", args: () => ["chat", FIRST_PROMPT] },
  { id: "cursor", label: "Cursor", command: "cursor", kind: "app", args: (dir) => [dir] },
  { id: "editor", label: "The browser editor (no coding tool needed)", kind: "browser" },
  { id: "site", label: "Just open the site", kind: "browser" },
];

/** Whether `command` is on PATH (with PATHEXT on Windows). Looks at files only; runs nothing. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  return dirs.some((dir) =>
    exts.some((ext) => {
      try {
        return fs.statSync(path.join(dir, command + ext.toLowerCase())).isFile() || fs.statSync(path.join(dir, command + ext)).isFile();
      } catch {
        return false;
      }
    }),
  );
}

/** The tools to offer: those found on PATH, then the browser editor and the plain site. */
export function toolChoices(found: (command: string) => boolean = (c) => onPath(c)): Tool[] {
  return TOOLS.filter((t) => !t.command || found(t.command));
}

/** A running background process (the dev server while a terminal assistant has the terminal). */
export interface Background {
  /** What it printed before it was ready (the site's addresses). */
  lines: string[];
  stop: () => void;
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
  /** Picks a tool from the list (a person at the terminal); the default asks with numbers. */
  choose?: (tools: Tool[]) => Promise<ToolId>;
  /** Which commands are on PATH (tests replace it). */
  found?: (command: string) => boolean;
  /** Opens an app without waiting for it; resolves false if it couldn't be started. */
  launch?: (cmd: string, args: string[], cwd: string) => Promise<boolean>;
  /** Starts the dev server in the background and resolves once it prints its address. */
  background?: (cmd: string, args: string[], cwd: string) => Promise<Background>;
  /** The project's own vage CLI (node_modules/vagejs), run with this Node. */
  cli?: (dir: string) => string;
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
  // Only a person picks a tool; --yes keeps the plain start (no question).
  const tools = toolChoices(o.found);
  const choice = o.interactive && !o.yes ? await (o.choose ?? askChoice)(tools) : "site";
  const tool = tools.find((t) => t.id === choice) ?? tools.find((t) => t.id === "site")!;
  const again = `To start it again later:\n  cd ${o.rel}\n  ${o.pm} start`;
  const paste = `\nIf it doesn't start, open ${tool.label} in ${o.rel} yourself and give it this first prompt:\n  ${FIRST_PROMPT}\n`;

  if (tool.kind === "terminal") {
    // The assistant gets this terminal; the site runs in the background until it exits.
    const cli = (o.cli ?? projectCli)(o.dir);
    const background = o.background ?? startBackground;
    let server: Background;
    try {
      server = await background(process.execPath, [cli, "dev", "--open"], o.dir);
    } catch (err) {
      log(`\nThe site didn't start in the background (${(err as Error).message}). Starting it here instead.${paste}`);
      return run(o.pm, ["start"], o.dir);
    }
    log(server.lines.join("\n"));
    log(`\nStarting ${tool.label} in ${o.rel}. The site keeps running while it's open; quitting it stops the site too.`);
    // Assistants ask before working in a folder they haven't seen; Claude Code's default answer is "No, exit".
    log(`If ${tool.label} asks whether you trust this folder, choose yes: it's the site you just created.\n`);
    const code = run(tool.command!, tool.args!(o.dir), o.dir);
    server.stop();
    if (code !== 0) log(paste);
    log(`\n${again}`);
    return 0;
  }
  if (tool.kind === "app") {
    const opened = await (o.launch ?? launchApp)(tool.command!, tool.args!(o.dir), o.dir);
    log(
      opened
        ? tool.id === "cursor"
          ? `\nOpened ${o.rel} in Cursor. In its chat, start with:\n  ${FIRST_PROMPT}\n`
          : `\nOpened ${tool.label} with a first prompt for your assistant.\n`
        : paste,
    );
  }
  // Said before starting: once the dev server runs, Ctrl+C ends this command too.
  log(`\nStarting the site. Ctrl+C stops it. ${again}\n`);
  if (tool.id === "editor") {
    log("The editor opens too, with the next steps for your site.\n");
    return run(process.execPath, [(o.cli ?? projectCli)(o.dir), "dev", "--open", "--open-editor"], o.dir);
  }
  return run(o.pm, ["start"], o.dir);
}

/** The new site's own vage CLI, as installed in its node_modules. */
function projectCli(dir: string): string {
  return createRequire(path.join(dir, "package.json")).resolve("vagejs/cli");
}

/** Windows: commands installed by npm are .cmd files, which need a shell; quote arguments with spaces. */
function shellArgs(args: string[]): string[] {
  return process.platform === "win32" ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
}

async function launchApp(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, shellArgs(args), { cwd, stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => resolve(false));
    child.on("spawn", () => (child.unref(), resolve(true)));
  });
}

/** Starts the dev server without the terminal, waits for its "running at" line, and keeps it quiet afterwards. */
function startBackground(cmd: string, args: string[], cwd: string): Promise<Background> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let ready = false;
    const done = () => {
      if (ready) return;
      ready = true;
      resolve({ lines, stop: () => child.kill() });
    };
    const read = (chunk: Buffer) => {
      if (ready) return; // keep draining, so the server never blocks on a full pipe
      lines.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
      if (lines.some((l) => l.includes("editor:"))) done();
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", reject);
    child.on("exit", (code) => (ready ? undefined : reject(new Error(`The dev server stopped (exit code ${code}):\n${lines.join("\n")}`))));
    // The editor line is printed last; if it never comes (editor off), go on after a short wait.
    setTimeout(() => lines.length && done(), 15_000).unref();
  });
}

async function askChoice(tools: Tool[]): Promise<ToolId> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const list = tools.map((t, i) => `  ${i + 1}. ${t.label}`).join("\n");
    const answer = await rl.question(`\nBuild your site with:\n${list}\nChoose a number (Enter for 1): `);
    const n = answer.trim() === "" ? 1 : Number(answer.trim());
    return tools[n - 1]?.id ?? "site";
  } catch {
    return "site"; // Ctrl+C or Ctrl+D: just start the site
  } finally {
    rl.close();
  }
}

function runAttached(cmd: string, args: string[], cwd: string): number {
  // npm, pnpm, yarn, bun and npm-installed assistants are .cmd files on Windows, which need a shell.
  // Node itself doesn't, and runs without one.
  const shell = process.platform === "win32" && cmd !== process.execPath;
  return spawnSync(cmd, shell ? shellArgs(args) : args, { cwd, stdio: "inherit", shell }).status ?? 1;
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
