import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProject } from "../src/cli/create.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vage-create-"));

describe("createProject", () => {
  it("scaffolds the starter with a renamed .gitignore and package name", () => {
    const dir = path.join(tmp(), "My Site");
    const result = createProject(dir, "file:../vagejs.tgz");
    expect(result.files).toEqual(
      expect.arrayContaining([".gitignore", "AGENTS.md", "CLAUDE.md", "package.json", "vage.config.ts", "src/pages/index.md", "src/layouts/default.ts", "public/favicon.svg", ".github/workflows/ci.yml", ".env.example"]),
    );
    expect(result.files).not.toContain("_gitignore");
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-site");
    expect(pkg.devDependencies.vagejs).toBe("file:../vagejs.tgz");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(".env");
  });

  it("refuses to write into a non-empty directory", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
    expect(() => createProject(dir, "^0.1.0")).toThrow(/already exists and is not empty/);
    expect(fs.readdirSync(dir)).toEqual(["keep.txt"]);
  });

  it("allows an existing empty directory", () => {
    expect(() => createProject(tmp(), "^0.1.0")).not.toThrow();
  });
});
