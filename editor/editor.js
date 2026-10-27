// The vagejs local editor (vage dev, /_vage/edit/). Plain JavaScript, no dependencies.
// It builds every element with DOM calls, never innerHTML, so page text can't inject markup.
"use strict";

const TOKEN = document.querySelector('meta[name="vage-token"]').content;
// The site's pages are on the dev server's port: the editor has its own, so those pages can't read it.
const SITE = document.querySelector('meta[name="vage-site"]').content;
const API = "/api/";
const app = document.getElementById("app");

/** h("p", { class: "x", onclick }, "text", child) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function call(action, { method = "GET", query, body, raw, type } = {}) {
  const url = API + action + (query ? `?${new URLSearchParams(query)}` : "");
  const headers = { "x-vage-token": TOKEN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (raw !== undefined) headers["content-type"] = type || "application/octet-stream";
  const res = await fetch(url, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const value = isJson ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(isJson ? value.error : value), { status: res.status });
  return value;
}

const STATUS = { published: "Published", draft: "Draft", scheduled: "Scheduled", error: "Needs fixing" };
const pill = (status, title) => h("span", { class: `pill pill-${status}`, title }, STATUS[status]);

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---------- Next steps (new sites) ---------- */

const HIDE_KEY = "vage-editor-next-steps-hidden";
function hiddenSteps() {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}
function setHiddenSteps(value) {
  try {
    if (value) localStorage.setItem(HIDE_KEY, "1");
    else localStorage.removeItem(HIDE_KEY);
  } catch {
    // Storage blocked: the panel just shows again next time.
  }
}

/** A copy button for a command or snippet, with the text visible beside it. */
function copyBlock(label, text) {
  const status = h("span", { class: "muted", role: "status" });
  return h(
    "div",
    { class: "copy-block" },
    h("p", { class: "help" }, label),
    h("pre", { class: "mono" }, text),
    h(
      "button",
      {
        type: "button",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            status.textContent = "Copied.";
          } catch {
            status.textContent = "Select the text above and copy it.";
          }
        },
      },
      "Copy",
    ),
    status,
  );
}

/** "Next steps": what still has the starter's placeholder content, and how to connect an AI assistant. */
async function nextSteps() {
  let data;
  try {
    data = await call("setup");
  } catch {
    return h("div"); // Optional help: never block the page list.
  }
  const done = data.steps.filter((s) => s.done).length;
  const total = data.steps.length;
  const box = h("section", { class: "next-steps", "aria-labelledby": "next-steps-title" });
  const render = () => {
    const hidden = hiddenSteps();
    const head = h(
      "div",
      { class: "next-head" },
      h("h2", { id: "next-steps-title" }, done === total ? "Your site is set up" : "Next steps for your site"),
      h("span", { class: "muted" }, `${done} of ${total} done`),
      h("button", { type: "button", "aria-expanded": String(!hidden), "aria-controls": "next-steps-list", onclick: () => (setHiddenSteps(!hidden), render()) }, hidden ? "Show" : "Hide"),
    );
    if (hidden) return box.replaceChildren(head);
    const items = data.steps.map((s) =>
      h(
        "li",
        { class: s.done ? "step done" : "step" },
        h("span", { class: "tick", "aria-hidden": "true" }, s.done ? "✓" : "○"),
        h(
          "div",
          {},
          h("strong", {}, s.label),
          h("span", { class: "visually-hidden" }, s.done ? " (done)" : " (to do)"),
          s.done ? "" : h("p", { class: "help" }, s.help),
          !s.done && s.page ? h("a", { href: `#/edit/${encodeURIComponent(s.page)}` }, "Open the page") : "",
        ),
      ),
    );
    const connect = h(
      "details",
      { class: "connect" },
      h("summary", {}, "Let an AI assistant work on your site"),
      h(
        "p",
        { class: "help" },
        "Open this folder in Claude Code, Cursor, Codex or Copilot: the AGENTS.md file tells them how vagejs works. To also give them vagejs's own tools (checks, page lists), install the connector once, then add it to your assistant. On any page, \"Copy prompt for AI\" makes a prompt for chat apps like ChatGPT or Claude.",
      ),
      copyBlock("1. In this folder, once:", data.connect.install),
      copyBlock("2. Claude Code, in this folder:", data.connect.claudeCode),
      copyBlock("Or for Cursor, Claude Desktop and other apps with an mcpServers setting:", data.connect.mcpJson),
    );
    box.replaceChildren(head, h("ol", { class: "steps", id: "next-steps-list" }, items), connect);
  };
  render();
  return box;
}

/* ---------- Pages list ---------- */

async function showList() {
  document.title = "Pages · vagejs editor";
  app.replaceChildren(h("p", { class: "muted" }, "Loading pages…"));
  let data;
  try {
    data = await call("pages");
  } catch (err) {
    return app.replaceChildren(h("p", { class: "error" }, err.message));
  }
  document.getElementById("site").textContent = data.site;

  const search = h("input", { type: "search", placeholder: "Find a page", "aria-label": "Find a page", class: "search" });
  const rows = h("tbody");
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const shown = data.pages.filter((p) => !q || `${p.title} ${p.route ?? ""} ${p.source}`.toLowerCase().includes(q));
    rows.replaceChildren(
      ...shown.map((p) =>
        h(
          "tr",
          {},
          h("td", {}, h("a", { href: `#/edit/${encodeURIComponent(p.source)}` }, p.title)),
          h("td", { class: "mono" }, p.route ?? "Not-found page"),
          h("td", {}, pill(p.status, p.error)),
        ),
      ),
    );
    if (!shown.length) rows.append(h("tr", {}, h("td", { colspan: 3, class: "muted" }, "No pages match.")));
  };
  search.addEventListener("input", render);
  render();

  const panel = h("div", { class: "new-panel", hidden: true });
  const openNew = (kind) => {
    panel.hidden = false;
    const name = h("input", { required: true, id: "new-name", autocomplete: "off" });
    const title = h("input", { id: "new-title", autocomplete: "off" });
    const error = h("p", { class: "error", role: "alert" });
    const form = h(
      "form",
      {
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = "";
          try {
            const created = await call("new", { method: "POST", body: { kind, name: name.value, title: title.value } });
            location.hash = `#/edit/${encodeURIComponent(created.source)}`;
          } catch (err) {
            error.textContent = err.message;
          }
        },
      },
      h("h2", {}, kind === "post" ? "New blog post" : "New page"),
      kind === "post"
        ? [h("label", { for: "new-name" }, "Title"), name]
        : [
            h("label", { for: "new-name" }, "Address"),
            h("p", { class: "help" }, "Lowercase words with hyphens, e.g. pricing or docs/setup."),
            name,
            h("label", { for: "new-title" }, "Title (optional)"),
            title,
          ],
      h("p", { class: "help" }, "New pages start as drafts, so nothing is published until you untick Draft."),
      error,
      h("div", { class: "actions" }, h("button", { class: "primary" }, "Create"), h("button", { type: "button", onclick: () => (panel.hidden = true) }, "Cancel")),
    );
    panel.replaceChildren(form);
    name.focus();
  };

  app.replaceChildren(
    await nextSteps(),
    h(
      "div",
      { class: "list-head" },
      h("h1", {}, "Pages"),
      search,
      h("button", { onclick: () => openNew("page") }, "New page"),
      h("button", { onclick: () => openNew("post") }, "New post"),
    ),
    panel,
    h("table", { class: "pages" }, h("thead", {}, h("tr", {}, h("th", {}, "Title"), h("th", {}, "Address"), h("th", {}, "Status"))), rows),
  );
  search.focus();
}

/* ---------- Page editor ---------- */

let dirty = false;
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

async function showEditor(source) {
  app.replaceChildren(h("p", { class: "muted" }, "Loading page…"));
  let page;
  try {
    page = await call("page", { query: { source } });
  } catch (err) {
    return app.replaceChildren(h("p", {}, h("a", { href: "#/" }, "← All pages")), h("p", { class: "error" }, err.message));
  }
  document.title = `${page.data.title ?? source} · vagejs editor`;
  dirty = false;

  const data = { ...page.data };
  let version = page.version;
  let fields = page.fields;
  const inputs = new Map();
  const badJson = new Set();
  const form = h("div", { class: "fields" });
  const statusSlot = h("span");
  const saveButton = h("button", { class: "primary", disabled: true, onclick: () => save() }, "Save");
  const promptButton = h("button", { type: "button", onclick: () => copyPrompt(), title: "Copies a prompt with this page and its check results, to paste into ChatGPT, Claude, Gemini or another AI chat" }, "Copy prompt for AI");
  let lastFindings = null;
  const saved = h("span", { class: "muted", role: "status" });
  const banner = h("div", { class: "error banner", role: "alert", hidden: true });
  const findings = h("section", { class: "findings", "aria-live": "polite" });
  const body = h("textarea", { class: "body", spellcheck: "true", "aria-label": "Page text (Markdown)" });
  body.value = page.body;
  // allow-same-origin (without allow-scripts) so the site's fonts load; the page's scripts never run here.
  const frame = h("iframe", { class: "preview", title: "Preview", sandbox: "allow-same-origin" });
  const previewNote = h("p", { class: "preview-note", hidden: true });

  const status = () => {
    const s = data.draft ? "draft" : data.datePublished && String(data.datePublished).slice(0, 10) > today() ? "scheduled" : "published";
    statusSlot.replaceChildren(pill(s));
  };

  function fieldInput(f) {
    const id = `f-${f.key}`;
    const value = data[f.key];
    let input;
    if (f.kind === "checkbox") input = h("input", { type: "checkbox", id, checked: value === true || (value === undefined && f.default === true) });
    else if (f.kind === "select") {
      // A saved value that isn't one of the choices stays selectable, so saving never drops it.
      const options = value !== undefined && !(f.options ?? []).some((o) => String(o) === String(value)) ? [...(f.options ?? []), value] : (f.options ?? []);
      input = h("select", { id }, h("option", { value: "" }, f.key === "layout" ? "default" : "—"), ...options.map((o) => h("option", { value: String(o), selected: String(value) === String(o) }, String(o))));
    }
    else if (f.kind === "textarea") input = h("textarea", { id, rows: 3 }, value ?? "");
    else if (f.kind === "json") input = h("textarea", { id, rows: 6, class: "mono" }, value === undefined ? "" : JSON.stringify(value, null, 2));
    else if (f.kind === "list") input = h("input", { id, value: Array.isArray(value) ? value.join(", ") : (value ?? "") });
    else if (f.kind === "number") input = h("input", { id, type: "number", step: "any", value: value ?? "" });
    else input = h("input", { id, value: value ?? "", placeholder: f.kind === "date" ? "YYYY-MM-DD" : undefined, inputmode: f.kind === "date" ? "numeric" : undefined });
    if (f.required) input.required = true;
    inputs.set(f.key, input);
    const error = h("p", { class: "field-error", id: `${id}-error` });
    input.setAttribute("aria-describedby", `${id}-help ${id}-error`);
    input.addEventListener("input", () => changed(f));
    input.addEventListener("change", () => changed(f));
    const label = h("label", { for: id }, f.label, f.required ? h("span", { class: "req", "aria-hidden": "true" }, " *") : "");
    const help = h("p", { class: "help", id: `${id}-help` }, f.help ?? "");
    return f.kind === "checkbox" ? h("div", { class: "field check" }, input, h("div", {}, label, help), error) : h("div", { class: "field" }, label, help, input, error);
  }

  /** Reads one input into data; returns false when its text isn't valid yet. */
  function read(f) {
    const input = inputs.get(f.key);
    const error = document.getElementById(`f-${f.key}-error`);
    error.textContent = "";
    let v;
    if (f.kind === "json" && !input.value.trim()) badJson.delete(f.key);
    if (f.kind === "checkbox") v = input.checked ? true : f.default === true ? false : undefined;
    else if (f.kind === "number") v = input.value === "" ? undefined : Number(input.value);
    else if (f.kind === "list") {
      const items = input.value.split(",").map((s) => s.trim()).filter(Boolean);
      v = items.length ? items : undefined;
    } else if (f.kind === "json") {
      if (!input.value.trim()) v = undefined;
      else {
        try {
          v = JSON.parse(input.value);
          badJson.delete(f.key);
        } catch {
          error.textContent = "This isn't valid JSON yet.";
          badJson.add(f.key);
          return false;
        }
      }
    } else if (f.kind === "select") {
      // Back to the value the choice stands for (numbers stay numbers).
      const choice = [...(f.options ?? []), data[f.key]].find((o) => o !== undefined && String(o) === input.value);
      v = input.value === "" ? undefined : (choice ?? input.value);
    } else v = input.value.trim() === "" ? undefined : input.value;
    if (v === undefined) delete data[f.key];
    else data[f.key] = v;
    return true;
  }

  async function changed(f) {
    read(f);
    markDirty();
    status();
    if (f.key === "layout") {
      try {
        fields = (await call("schema", { query: { layout: data.layout ?? "" } })).fields;
        renderFields();
      } catch (err) {
        showBanner(err.message);
      }
    }
  }

  /** Fields in the file that neither vagejs nor the layout declares, with an input that fits each value. */
  function otherFields() {
    const known = new Set(fields.map((f) => f.key));
    return Object.keys(data)
      .filter((key) => !known.has(key))
      .map((key) => {
        const v = data[key];
        const kind = typeof v === "boolean" ? "checkbox" : typeof v === "number" ? "number" : typeof v === "string" ? (v.length > 80 ? "textarea" : "text") : Array.isArray(v) && v.every((x) => typeof x === "string") ? "list" : "json";
        const label = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
        // default: true keeps an unticked box as "false" in the file instead of removing the field.
        return { key, label, kind, required: false, group: "other", default: kind === "checkbox" ? true : undefined, help: kind === "json" ? "Edited as JSON." : undefined };
      });
  }

  function renderFields() {
    inputs.clear();
    badJson.clear();
    fields = fields.filter((f) => f.group !== "other");
    const others = otherFields();
    fields = [...fields, ...others];
    const main = fields.filter((f) => f.group === "main");
    const own = fields.filter((f) => f.group === "layout");
    const more = fields.filter((f) => f.group === "more");
    form.replaceChildren(
      ...main.map(fieldInput),
      own.length ? h("fieldset", {}, h("legend", {}, `Fields from the ${data.layout ?? "default"} layout`), ...own.map(fieldInput)) : "",
      others.length ? h("fieldset", {}, h("legend", {}, "Other fields in this page"), ...others.map(fieldInput)) : "",
      h("details", {}, h("summary", {}, "More settings"), ...more.map(fieldInput)),
    );
  }

  function markDirty() {
    dirty = true;
    saveButton.disabled = false;
    saved.textContent = "Unsaved changes";
    schedulePreview();
  }

  let timer;
  let previewRun = 0;
  function schedulePreview() {
    clearTimeout(timer);
    timer = setTimeout(preview, 400);
  }
  async function preview() {
    const run = ++previewRun;
    try {
      const html = await call("preview", { method: "POST", body: { source, data, body: body.value } });
      if (run !== previewRun) return;
      previewNote.hidden = true;
      // Styles, fonts and images come from the dev server.
      frame.srcdoc = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${SITE}/">`);
    } catch (err) {
      if (run !== previewRun) return;
      previewNote.hidden = false;
      previewNote.textContent = `Preview not updated: ${err.message}`;
    }
  }

  function showBanner(message) {
    banner.hidden = !message;
    banner.textContent = message ?? "";
  }

  async function save() {
    // Fields are read as they change, so untouched ones keep their exact value.
    if (badJson.size) return showBanner("Fix the highlighted field first.");
    showBanner();
    saveButton.disabled = true;
    saved.textContent = "Saving…";
    try {
      ({ version } = await call("page", { method: "PUT", body: { source, data, body: body.value, version } }));
    } catch (err) {
      saveButton.disabled = false;
      saved.textContent = "Not saved";
      return showBanner(err.message);
    }
    dirty = false;
    saved.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    document.title = `${data.title ?? source} · vagejs editor`;
    loadFindings();
  }

  /** A prompt for any AI chat: rules, the change to make, the check results and the page as it stands. */
  async function copyPrompt() {
    let text;
    try {
      text = await call("text", { method: "POST", body: { source, data, body: body.value } });
    } catch (err) {
      return showBanner(err.message);
    }
    const problems = lastFindings ? [...lastFindings.findings, ...lastFindings.site] : [];
    const prompt = [
      "You are helping me edit one page of a website built with vagejs. The page is a Markdown file; the block between the --- lines at the top is YAML frontmatter (the page's details).",
      "",
      "Rules:",
      "- Don't invent facts, numbers, prices, quotes, testimonials, names or links. If you need something I haven't given you, ask me instead.",
      "- Keep my meaning and my wording where it works; fix what I ask for.",
      "- Title under 60 characters, description under 160. Links to this site's own pages start with / (for example /about/).",
      "- Reply with the new page text (everything below the second --- line) in one Markdown code block. Then list any frontmatter fields I should change, as \"field: new value\". Then a short list of what you changed and why.",
      "",
      "WHAT I WANT: DESCRIBE THE CHANGE HERE",
      "",
      "Problems vagejs found on this page:",
      ...(problems.length ? problems.map((f) => `- ${f.severity} (${f.rule}): ${f.message}`) : [lastFindings ? "- None" : "- Not checked yet (save the page to check it)"]),
      "",
      `The page, ${source}:`,
      "````markdown",
      text.replace(/\n+$/, ""),
      "````",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(prompt);
      saved.textContent = "Prompt copied: paste it into your AI chat and replace DESCRIBE THE CHANGE HERE";
    } catch {
      showBanner("The browser didn't allow copying. Select the prompt below and copy it yourself.");
      banner.append(h("textarea", { rows: 10, class: "mono", readonly: true, "aria-label": "Prompt for AI" }, prompt));
    }
  }

  async function loadFindings() {
    findings.replaceChildren(h("h2", {}, "Checks"), h("p", { class: "muted" }, "Checking the site…"));
    try {
      const result = await call("findings", { query: { source } });
      lastFindings = result;
      const list = (items) => h("ul", {}, ...items.map((f) => h("li", { class: f.severity }, h("strong", {}, f.severity === "error" ? "Error" : "Warning"), " ", f.message, h("span", { class: "rule" }, ` (${f.rule})`))));
      findings.replaceChildren(
        h("h2", {}, "Checks"),
        result.findings.length ? list(result.findings) : h("p", { class: "ok" }, "No problems found on this page."),
        ...(result.site.length ? [h("h3", {}, "Site settings (vage.config.ts)"), list(result.site)] : []),
      );
    } catch (err) {
      findings.replaceChildren(h("h2", {}, "Checks"), h("p", { class: "error" }, err.message));
    }
  }

  /* Images: pick or drop a file, describe it, and the Markdown goes in at the cursor. */
  const picker = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/avif,image/gif", hidden: true });
  const imagePanel = h("div", { class: "image-panel", hidden: true });
  function askAlt(file) {
    const alt = h("input", { id: "img-alt", required: true, autocomplete: "off" });
    const error = h("p", { class: "error", role: "alert" });
    imagePanel.hidden = false;
    imagePanel.replaceChildren(
      h(
        "form",
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const { path } = await call("image", { method: "POST", query: { name: file.name }, raw: file, type: file.type });
              const text = `![${alt.value.replace(/[[\]]/g, "")}](${path})`;
              const at = body.selectionStart ?? body.value.length;
              body.setRangeText(`${at > 0 && body.value[at - 1] !== "\n" ? "\n\n" : ""}${text}\n`, at, body.selectionEnd ?? at, "end");
              imagePanel.hidden = true;
              body.focus();
              markDirty();
            } catch (err) {
              error.textContent = err.message;
            }
          },
        },
        h("label", { for: "img-alt" }, `Describe ${file.name} for people who can't see it`),
        alt,
        error,
        h("div", { class: "actions" }, h("button", { class: "primary" }, "Add image"), h("button", { type: "button", onclick: () => (imagePanel.hidden = true) }, "Cancel")),
      ),
    );
    alt.focus();
  }
  picker.addEventListener("change", () => picker.files[0] && askAlt(picker.files[0]));
  body.addEventListener("dragover", (e) => e.preventDefault());
  body.addEventListener("drop", (e) => {
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    askAlt(file);
  });
  body.addEventListener("input", markDirty);

  renderFields();
  status();
  app.replaceChildren(
    h(
      "div",
      { class: "edit-head" },
      h("a", { href: "#/", class: "back" }, "← All pages"),
      statusSlot,
      h("span", { class: "mono muted" }, page.route ?? source),
      page.route ? h("a", { href: SITE + page.route, target: "_blank", rel: "noopener" }, "Open page") : "",
      h("span", { class: "spacer" }),
      saved,
      promptButton,
      saveButton,
    ),
    banner,
    h(
      "div",
      { class: "edit-grid" },
      h(
        "div",
        { class: "edit-col" },
        form,
        h("div", { class: "body-head" }, h("label", { for: "body" }, "Text"), h("span", { class: "help" }, "Markdown: ## for headings, **bold**, [link](/page/)."), h("button", { type: "button", onclick: () => picker.click() }, "Add image"), picker),
        imagePanel,
        body,
        findings,
      ),
      h("div", { class: "preview-col" }, h("p", { class: "preview-label" }, "Preview"), previewNote, frame),
    ),
  );
  body.id = "body";
  preview();
  loadFindings();
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    const button = document.querySelector(".edit-head .primary");
    if (button) {
      e.preventDefault();
      if (!button.disabled) button.click();
    }
  }
});

let current = location.hash;
function route() {
  if (dirty && location.hash !== current && !confirm("Leave without saving your changes?")) {
    history.replaceState(null, "", current);
    return;
  }
  dirty = false;
  current = location.hash;
  const edit = /^#\/edit\/(.+)$/.exec(location.hash);
  if (edit) showEditor(decodeURIComponent(edit[1]));
  else showList();
}
window.addEventListener("hashchange", route);
route();
