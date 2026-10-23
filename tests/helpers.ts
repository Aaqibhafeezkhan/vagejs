import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURE = path.join(import.meta.dirname, "fixtures", "basic");

/** Copies the fixture into a fresh temp dir so tests can mutate it. */
export function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vage-test-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

export function write(root: string, rel: string, content: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
