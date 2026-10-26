#!/usr/bin/env node
// `npm create vagejs@latest <dir>` runs this. It delegates to `vage create`, so
// there is one scaffolding implementation; the new site depends on the same
// vagejs version this package was released with.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (!args.length || args[0].startsWith("-")) {
  console.error("Usage: npm create vagejs@latest <directory> [-- --yes | --no-install]");
  process.exit(1);
}
const cli = require.resolve("vagejs/cli");
const { version } = require("vagejs/package.json");
const result = spawnSync(process.execPath, [cli, "create", ...args, "--vage-spec", `^${version}`], { stdio: "inherit" });
process.exit(result.status ?? 1);
