import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIRST_PROMPT, installAndStart, nextSteps, onPath, packageManager, toolChoices, type StartOptions, type ToolId } from "../src/cli/start.js";

/** installAndStart with a fake runner and question; returns what happened. */
async function scenario(o: Partial<StartOptions> & { answer?: boolean; installCode?: number; pick?: ToolId; tools?: string[]; toolCode?: number; launched?: boolean }) {
  const calls: string[] = [];
  const offered: string[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const code = await installAndStart({
    dir: "/abs/my-site",
    rel: "my-site",
    pm: "npm",
    interactive: false,
    ask: async (q) => (asked.push(q), o.answer ?? true),
    run: (cmd, args, cwd) => (calls.push(`${cmd} ${args.join(" ")} @ ${cwd}`), args[0] === "install" ? (o.installCode ?? 0) : cmd === "npm" || cmd === "node" ? 0 : (o.toolCode ?? 0)),
    choose: async (tools) => (offered.push(...tools.map((t) => t.id)), o.pick ?? "site"),
    found: (c) => (o.tools ?? []).includes(c),
    launch: async (cmd, args, cwd) => (calls.push(`launch ${cmd} ${args.join(" ")} @ ${cwd}`), o.launched ?? true),
    background: async (cmd, args, cwd) => (calls.push(`background ${args.slice(1).join(" ")} @ ${cwd}`), { lines: ["vagejs dev server running at http://localhost:5173/"], stop: () => calls.push("stop site") }),
    cli: () => "/abs/my-site/node_modules/vagejs/dist/cli/index.js",
    log: (l) => lines.push(l),
    ...o,
  });
  return { code, calls, asked, offered, out: lines.join("\n") };
}

describe("install and start after create", () => {
  it("asks a person at a terminal, then installs and starts the site", async () => {
    const r = await scenario({ interactive: true });
    expect(r.asked).toEqual(["Install and start the site now? (Y/n) "]);
    expect(r.calls).toEqual(["npm install @ /abs/my-site", "npm start @ /abs/my-site"]);
    expect(r.out).toContain("To start it again later:\n  cd my-site\n  npm start");
    expect(r.code).toBe(0);
  });

  it("prints the next steps when the person says no", async () => {
    const r = await scenario({ interactive: true, answer: false });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("Next steps:\n  cd my-site\n  npm install\n  npm start");
  });

  it("never asks or starts anything for AI assistants and CI (no terminal)", async () => {
    const r = await scenario({ interactive: false });
    expect(r.asked).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("Next steps:");
  });

  it("--yes skips the question; --no-install only creates the files", async () => {
    expect((await scenario({ yes: true })).calls).toHaveLength(2);
    const none = await scenario({ interactive: true, install: false });
    expect([none.asked, none.calls]).toEqual([[], []]);
  });

  it("stops after a failed install and says how to retry", async () => {
    const r = await scenario({ yes: true, installCode: 1 });
    expect(r.calls).toEqual(["npm install @ /abs/my-site"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Your site's files are ready; to try again:\n  cd my-site\n  npm install");
  });

  it("uses the package manager that ran create", async () => {
    expect(packageManager("pnpm/9.12.0 npm/? node/v22.12.0 darwin arm64")).toBe("pnpm");
    expect(packageManager("yarn/4.5.0 npm/? node/v22.12.0")).toBe("yarn");
    expect(packageManager("bun/1.1.0 npm/? node/v22.12.0")).toBe("bun");
    expect(packageManager("npm/11.0.0 node/v22.12.0")).toBe("npm");
    expect(packageManager(undefined)).toBe("npm");
    expect((await scenario({ yes: true, pm: "pnpm" })).calls[0]).toBe("pnpm install @ /abs/my-site");
    expect(nextSteps("my-site", "yarn")).toContain("  yarn install\n  yarn start");
  });

  it("tells AI assistants how to set the site up with its owner", () => {
    const text = nextSteps("my-site", "npm");
    expect(text).toContain("read my-site/AGENTS.md");
    expect(text).toContain("npx vage next-steps");
    expect(text).toContain("never invent them");
  });
});

describe("choosing what to build the site with", () => {
  const P = FIRST_PROMPT;

  it("offers only the tools found on this computer, then the browser editor and the plain site", async () => {
    const r = await scenario({ interactive: true, tools: ["claude", "code"] });
    expect(r.offered).toEqual(["claude", "vscode", "editor", "site"]);
    expect(toolChoices(() => false).map((t) => t.id)).toEqual(["editor", "site"]);
  });

  it("gives the terminal to a terminal assistant, with the site running in the background until it quits", async () => {
    const r = await scenario({ interactive: true, tools: ["claude"], pick: "claude" });
    expect(r.calls).toEqual(["npm install @ /abs/my-site", "background dev --open @ /abs/my-site", `claude ${P} @ /abs/my-site`, "stop site"]);
    expect(r.out).toContain("running at http://localhost:5173/");
    expect(r.out).toContain("quitting it stops the site too");
  });

  it("starts Gemini CLI interactively with the prompt (-i)", async () => {
    expect((await scenario({ interactive: true, tools: ["gemini"], pick: "gemini" })).calls[2]).toBe(`gemini -i ${P} @ /abs/my-site`);
  });

  it("prints the first prompt when an assistant doesn't start", async () => {
    const r = await scenario({ interactive: true, tools: ["codex"], pick: "codex", toolCode: 1 });
    expect(r.out).toContain(`open Codex in my-site yourself and give it this first prompt:\n  ${P}`);
  });

  it("opens VS Code chat with the prompt, or Cursor on the folder, then runs the site here", async () => {
    const code = await scenario({ interactive: true, tools: ["code"], pick: "vscode" });
    expect(code.calls).toEqual(["npm install @ /abs/my-site", `launch code chat ${P} @ /abs/my-site`, "npm start @ /abs/my-site"]);
    const cursor = await scenario({ interactive: true, tools: ["cursor"], pick: "cursor" });
    expect(cursor.calls[1]).toBe("launch cursor /abs/my-site @ /abs/my-site");
    expect(cursor.out).toContain(`In its chat, start with:\n  ${P}`);
    expect((await scenario({ interactive: true, tools: ["cursor"], pick: "cursor", launched: false })).out).toContain("open Cursor in my-site yourself");
  });

  it("opens the browser editor next to the site", async () => {
    const r = await scenario({ interactive: true, pick: "editor" });
    expect(r.calls[1]).toBe(`${process.execPath} /abs/my-site/node_modules/vagejs/dist/cli/index.js dev --open --open-editor @ /abs/my-site`);
  });

  it("asks nothing with --yes, and never without a terminal", async () => {
    expect((await scenario({ yes: true, interactive: true, tools: ["claude"] })).offered).toEqual([]);
    expect((await scenario({ interactive: false, tools: ["claude"] })).offered).toEqual([]);
  });

  it("finds commands on PATH by file, with PATHEXT on Windows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vage-path-"));
    fs.writeFileSync(path.join(dir, "claude"), "");
    fs.writeFileSync(path.join(dir, "code.cmd"), "");
    // Each platform's PATH separator only works with its own paths ("C:\\..." has a colon), so test the real one.
    if (process.platform === "win32") {
      expect(onPath("code", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(true);
      expect(onPath("claude", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(false); // no extension: not runnable
    } else {
      expect(onPath("claude", { PATH: dir }, process.platform)).toBe(true);
      expect(onPath("codex", { PATH: dir }, process.platform)).toBe(false);
      expect(onPath("code.cmd", { PATH: `/nowhere:${dir}` }, process.platform)).toBe(true);
    }
  });
});
