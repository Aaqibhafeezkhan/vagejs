import { describe, expect, it } from "vitest";
import { installAndStart, nextSteps, packageManager, type StartOptions } from "../src/cli/start.js";

/** installAndStart with a fake runner and question; returns what happened. */
async function scenario(o: Partial<StartOptions> & { answer?: boolean; installCode?: number }) {
  const calls: string[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const code = await installAndStart({
    dir: "/abs/my-site",
    rel: "my-site",
    pm: "npm",
    interactive: false,
    ask: async (q) => (asked.push(q), o.answer ?? true),
    run: (cmd, args, cwd) => (calls.push(`${cmd} ${args.join(" ")} @ ${cwd}`), args[0] === "install" ? (o.installCode ?? 0) : 0),
    log: (l) => lines.push(l),
    ...o,
  });
  return { code, calls, asked, out: lines.join("\n") };
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
});
