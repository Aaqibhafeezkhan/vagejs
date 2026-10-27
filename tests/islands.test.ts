import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { measurePages } from "../src/audit/budgets.js";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { allowed } from "../src/dev/guard.js";
import { startDevServer } from "../src/dev/server.js";
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
    expect(html).toMatch(/<vage-island data-island="counter-[0-9a-f]{8}-default" data-when="load" data-props="\{&quot;start&quot;:3\}" data-id-prefix="vi0-"><button type="button">Clicked <!-- -->3<\/button><\/vage-island>/);
    expect(html).toMatch(/<vage-island data-island="counter-[0-9a-f]{8}-Greeting" data-when="visible"/);
    expect(html).toContain("<p>Hello static</p>");
    expect(html).toContain('<script type="module" src="/_vage/islands/runtime.js"></script>');
    const findings = (await check(root)).findings.filter((f) => f.source === path.join("src", "pages", "demo.mdx"));
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

  it("keeps existing React layouts working: spread props with a key, hooks after an island", async () => {
    const root = siteWithCounter();
    write(
      root,
      "src/layouts/default.tsx",
      `import { useState } from "react";
import Counter from "../components/Counter.tsx";
const Item = ({ label }) => <li>{label}</li>;
export default function Layout({ content, page }) {
  const island = <Counter client:load start={2} />;
  const [title] = useState(page.title);
  const items = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  return <html lang="en"><head><title>{title}</title></head><body><ul>{items.map((i) => <Item {...i} key={i.id} />)}</ul><main dangerouslySetInnerHTML={{ __html: content }} />{island}</body></html>;
}
`,
    );
    await build(root);
    const html = read(root, "about/index.html");
    expect(html).toContain("<ul><li>A</li><li>B</li></ul>");
    expect(html).toContain("<title>About</title>");
    expect(html).toMatch(/<vage-island [^>]*data-when="load"[^>]*><button type="button">Clicked <!-- -->2<\/button><\/vage-island>/);
  });

  it("gives each island its own useId prefix", async () => {
    const root = siteWithCounter();
    write(root, "src/components/Field.tsx", 'import { useId } from "react";\nexport default function Field() {\n  const id = useId();\n  return <p><label htmlFor={id}>Name</label><input id={id} /></p>;\n}\n');
    write(root, "src/pages/demo.mdx", page("<Field client:load />\n\n<Field client:load />", 'import Field from "../components/Field.tsx";'));
    await build(root);
    const ids = [...read(root, "demo/index.html").matchAll(/<input id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(read(root, "demo/index.html")).toContain('data-id-prefix="vi1-"');
  });

  it("refuses islands it can't hydrate and island markup it didn't make", async () => {
    const root = siteWithCounter();
    write(root, "src/components/Wrap.tsx", 'import Counter from "./Counter.tsx";\nexport default function Wrap() {\n  return <div><Counter client:load start={9} /></div>;\n}\n');
    write(root, "src/pages/demo.mdx", page("<Wrap client:visible />", 'import Wrap from "../components/Wrap.tsx";'));
    expect((await check(root)).findings.find((f) => f.source === path.join("src", "pages", "demo.mdx"))?.message).toMatch(/is inside another interactive component/);
    write(root, "src/pages/demo.mdx", page('<vage-island data-island="example">static</vage-island>', ""));
    await expect(build(root)).rejects.toThrow(/<vage-island data-island="example"> that vagejs didn't make/);
  });

  it("explains islands it can't make", async () => {
    const root = siteWithCounter();
    write(root, "src/components/Inline.tsx", "export const notAFunction = { a: 1 };\n");
    const cases: [string, RegExp][] = [
      ["<Counter client:hover start={1} />", /client:hover on <Counter> isn't a vagejs directive\. Use client:load, client:visible or client:idle\./],
      ["<Counter client:load client:idle start={1} />", /use one client: directive/],
      ["<Counter client:load start={() => 1} />", /Props of <Counter client:load> must be plain data .* "start" isn't/],
      ["<Counter client:load start={1}>text</Counter>", /can't have content between its tags/],
      ["<Counter client:load start={new Date(0)} />", /"start" isn't \(functions, dates, maps and NaN/],
      ["<Counter client:load start={NaN} />", /"start" isn't/],
    ];
    for (const [body, message] of cases) {
      write(root, "src/pages/demo.mdx", page(body));
      const result = await check(root);
      expect(result.findings.find((f) => f.source === path.join("src", "pages", "demo.mdx"))?.message, body).toMatch(message);
    }
    write(root, "src/pages/demo.mdx", page("export function Local() { return <p>local</p>; }\n\n<Local client:load />", ""));
    expect((await check(root)).findings.find((f) => f.source === path.join("src", "pages", "demo.mdx"))?.message).toMatch(/<Local client:load> must be a function component exported from a file in src\/components\//);
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

  it("dev server: bundles islands from pages viewed later, and forgets deleted components", async () => {
    const root = siteWithCounter();
    write(root, "src/components/Other.tsx", "export default function Other() {\n  return <p>other</p>;\n}\n");
    write(root, "src/pages/a.mdx", page("<Counter client:load start={1} />"));
    write(root, "src/pages/b.mdx", page("<Other client:load />", 'import Other from "../components/Other.tsx";'));
    const server = await startDevServer(root, {});
    try {
      const url = `http://localhost:${(server.httpServer!.address() as { port: number }).port}`;
      const keyOn = async (route: string) => /data-island="([\w-]+)"/.exec(await (await fetch(`${url}${route}`)).text())![1];
      const a = await keyOn("/a/");
      expect((await fetch(`${url}/_vage/islands/${a}.js`)).status).toBe(200);
      const b = await keyOn("/b/");
      expect((await fetch(`${url}/_vage/islands/${b}.js`)).status).toBe(200);
      // Delete Other and its page: the watcher forgets it, and /a/'s island still bundles.
      fs.rmSync(path.join(root, "src/pages/b.mdx"));
      fs.rmSync(path.join(root, "src/components/Other.tsx"));
      await expect.poll(async () => {
        await keyOn("/a/");
        return (await fetch(`${url}/_vage/islands/runtime.js`)).status;
      }, { timeout: 10_000 }).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("serves island code from the dev server", () => {
    const publicDir = path.join(copyFixture(), "public");
    expect(allowed("/_vage/islands/runtime.js", publicDir, new Set())).toBe(true);
    expect(allowed("/_vage/islands/counter-1a2b3c4d-default.js", publicDir, new Set())).toBe(true);
    expect(allowed("/_vage/islands/../../vage.config.ts", publicDir, new Set())).toBe(false);
  });
});
