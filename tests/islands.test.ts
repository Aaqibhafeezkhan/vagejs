import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { measurePages } from "../src/audit/budgets.js";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { allowed } from "../src/dev/guard.js";
import { copyFixture, write } from "./helpers.js";

/** The fixture with this repo's node_modules (react, react-dom, @mdx-js/mdx) and a Counter component. */
function siteWithCounter(): string {
  const root = copyFixture();
  fs.symlinkSync(path.join(import.meta.dirname, "..", "node_modules"), path.join(root, "node_modules"), "junction");
  write(
    root,
    "src/components/Counter.tsx",
    `import { useState } from "react";
export default function Counter({ start }: { start: number }) {
  const [n, setN] = useState(start);
  return <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>;
}
export function Greeting({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}
`,
  );
  return root;
}

const page = (body: string, imports = 'import Counter, { Greeting } from "../components/Counter.tsx";') =>
  `---\ntitle: Demo\ndescription: A page with islands.\n---\n${imports}\n\n# Demo\n\n${body}\n`;

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");
const islandFiles = (root: string) => fs.readdirSync(path.join(root, "dist", "_vage", "islands")).sort();

describe("interactive islands (client:load / client:visible / client:idle)", () => {
  it("renders islands to HTML and bundles their browser code", async () => {
    const root = siteWithCounter();
    write(root, "src/pages/demo.mdx", page('<Counter client:load start={3} />\n\n<Greeting name="static" />\n\n<Greeting client:visible name="later" />'));
    await build(root);
    const html = read(root, "demo/index.html");
    expect(html).toMatch(/<vage-island data-island="counter-[0-9a-f]{8}-default" data-when="load" data-props="\{&quot;start&quot;:3\}"><button type="button">Clicked <!-- -->3<\/button><\/vage-island>/);
    expect(html).toMatch(/<vage-island data-island="counter-[0-9a-f]{8}-Greeting" data-when="visible"/);
    expect(html).toContain("<p>Hello static</p>");
    expect(html).toContain('<script type="module" src="/_vage/islands/runtime.js"></script>');
    const findings = (await check(root)).findings.filter((f) => f.source === "src/pages/demo.mdx");
    expect(findings).toEqual([]);
    // Pages without islands send nothing.
    expect(read(root, "about/index.html")).not.toContain("<script type=\"module\"");

    const files = islandFiles(root);
    expect(files).toEqual(expect.arrayContaining(["runtime.js", expect.stringMatching(/^counter-[0-9a-f]{8}-default\.js$/), expect.stringMatching(/^counter-[0-9a-f]{8}-Greeting\.js$/)]));
    const shared = files.filter((f) => f.startsWith("chunk-")).map((f) => read(root, `_vage/islands/${f}`)).join("");
    expect(shared).toContain("hydrateRoot");
    // React's production build: no development warnings, no jsxDEV.
    expect(shared).not.toContain("jsxDEV");
    expect(shared).not.toContain("is deprecated in plain JavaScript React classes");
  });

  it("works in React layouts too", async () => {
    const root = siteWithCounter();
    write(
      root,
      "src/layouts/default.tsx",
      `import Counter from "../components/Counter.tsx";
export default function Layout({ content, page }) {
  return <html lang="en"><head><title>{page.title}</title></head><body><main dangerouslySetInnerHTML={{ __html: content }} /><Counter client:idle start={0} /></body></html>;
}
`,
    );
    await build(root);
    expect(read(root, "about/index.html")).toMatch(/<vage-island data-island="counter-[0-9a-f]{8}-default" data-when="idle"/);
  });

  it("explains islands it can't make", async () => {
    const root = siteWithCounter();
    write(root, "src/components/Inline.tsx", "export const notAFunction = { a: 1 };\n");
    const cases: [string, RegExp][] = [
      ["<Counter client:hover start={1} />", /client:hover on <Counter> isn't a vagejs directive\. Use client:load, client:visible or client:idle\./],
      ["<Counter client:load client:idle start={1} />", /use one client: directive/],
      ["<Counter client:load start={() => 1} />", /Props of <Counter client:load> must be plain data .* "start" isn't/],
      ["<Counter client:load start={1}>text</Counter>", /can't have content between its tags/],
    ];
    for (const [body, message] of cases) {
      write(root, "src/pages/demo.mdx", page(body));
      const result = await check(root);
      expect(result.findings.find((f) => f.source === "src/pages/demo.mdx")?.message, body).toMatch(message);
    }
    write(root, "src/pages/demo.mdx", page("export function Local() { return <p>local</p>; }\n\n<Local client:load />", ""));
    expect((await check(root)).findings.find((f) => f.source === "src/pages/demo.mdx")?.message).toMatch(/<Local client:load> must be a function component exported from a file in src\/components\//);
  });

  it("counts island code in the page's JavaScript budget", async () => {
    const root = siteWithCounter();
    write(root, "src/pages/demo.mdx", page("<Counter client:load start={1} />"));
    await build(root);
    const [demo, about] = measurePages(path.join(root, "dist"), [
      { route: "/demo/", outFile: "demo/index.html" },
      { route: "/about/", outFile: "about/index.html" },
    ]);
    // runtime.js + the island's entry + React's shared chunk.
    expect(demo!.bytes.javascript).toBeGreaterThan(100_000);
    expect(about!.bytes.javascript).toBe(0);
  });

  it("serves island code from the dev server", () => {
    const publicDir = path.join(copyFixture(), "public");
    expect(allowed("/_vage/islands/runtime.js", publicDir, new Set())).toBe(true);
    expect(allowed("/_vage/islands/counter-1a2b3c4d-default.js", publicDir, new Set())).toBe(true);
    expect(allowed("/_vage/islands/../../vage.config.ts", publicDir, new Set())).toBe(false);
  });
});
