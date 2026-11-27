// U01 A JSON fence draws without a top-level ui array, or a valid fence stays plain.
// U02 Partial JSON throws or draws early, or the final text never draws.
// U03 HTML in a string creates markup or runs a script.
// U04 Unsafe or relative URLs become links.
// U05 React replaces the source, block or added child and leaves stale or duplicate content.
// U06 Writes inside the component trigger another scan or a loop.
// U07 The comparison loses key order, gets equality wrong or hides missing values.
// U08 A copy button copies the wrong text or the original JSON becomes unavailable.
// U09 Scripts or styles leak onto the follow page, appear twice or conflict.
// U10 Unknown parts throw or hide the original code.
// U11 The script makes a network request or adds a global name.
// U12 Malformed fields break later parts or an invalid status becomes a class name.
// U13 The fixture drifts from the documented example or the injected assets.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

const dir = mkdtempSync(join(tmpdir(), "cmux-ui-"));
process.env.ORCA_CHAT_STATE_DIR = join(dir, "state");
process.env.CMUX_AGENT_CHAT_TOKEN = "ui-test";
let route: (req: Request) => Promise<Response>;
Bun.serve = ((options: any) => { route = options.fetch; }) as any;
await import("../lib/guard");
const shell = "<html><head></head><body></body></html>";
Bun.serve({ fetch: req => new Response(shell, { headers: { "content-type": req.url.endsWith("/plain") ? "text/plain" : "text/html" } }) });
async function get(path: string) {
  const response = await route(new Request("http://localhost" + path, { headers: { host: "localhost" } }));
  assert.equal(response.status, 200);
  return response.text();
}
const html = await get("/chat");
const script = (id: string) => html.match(new RegExp('<script id="cmux-chat-' + id + '">([\\s\\S]*?)</script>'))![1];
const fixture = readFileSync(join(import.meta.dir, "fixtures/ui-demo.html"), "utf8");
const example = fixture.match(/<pre class="shiki"><code>([\s\S]*?)<\/code>/)![1];
type Change = { target: Node; type: string; addedNodes: Node[]; removedNodes: Node[] };

// Only connected writes reach the observer. Deliver them in batches between frames.
class Node {
  children: Node[] = [];
  parentNode?: Node;
  className = "";
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  click?: Function;
  href?: string;
  target?: string;
  rel?: string;
  constructor(readonly tag: string, readonly changes: Change[], private value = "") {}
  get nodeType() { return this.tag === "#text" ? 3 : 1; }
  get parentElement() { return this.parentNode; }
  get isConnected(): boolean { return this.tag === "#document" || !!this.parentNode?.isConnected; }
  get childElementCount() { return this.children.filter(n => n.nodeType === 1).length; }
  get textContent(): string { return this.value + this.children.map(n => n.textContent).join(""); }
  set textContent(value: string) {
    const removed = this.children.splice(0);
    for (const child of removed) child.parentNode = undefined;
    this.value = value;
    this.changed([], removed, this.nodeType === 3 ? "characterData" : "childList");
  }
  set innerHTML(_: string) { throw Error("unexpected HTML write"); }
  createElement(tag: string) { return new Node(tag, this.changes); }
  changed(addedNodes: Node[], removedNodes: Node[], type = "childList") {
    if (this.isConnected) this.changes.push({ target: this, type, addedNodes, removedNodes });
  }
  append(...values: (Node | string)[]) {
    for (const v of values) {
      const node = typeof v === "string" ? new Node("#text", this.changes, v) : v;
      node.remove(); node.parentNode = this; this.children.push(node); this.changed([node], []);
    }
  }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentNode = undefined;
    parent.changed([], [this]);
  }
  matches(s: string) { return s.startsWith(".") ? this.className.split(" ").includes(s.slice(1)) : this.tag === s; }
  closest(s: string): Node | undefined { return this.matches(s) ? this : this.parentNode?.closest(s); }
  querySelectorAll(s: string): Node[] {
    return this.children.flatMap(n => [...(n.matches(s) ? [n] : []), ...n.querySelectorAll(s)]);
  }
  querySelector(s: string): Node | undefined {
    if (s === "pre code") return this.querySelector("pre")?.querySelector("code");
    return this.querySelectorAll(s)[0];
  }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(name: string, fn: Function) { assert.equal(name, "click"); this.click = fn; }
}

function page() {
  const changes: Change[] = [], frames: Function[] = [], observers: Function[] = [], copies: string[] = [];
  const document = new Node("#document", changes);
  let requests = 0;
  const network = () => { requests++; throw Error("unexpected network call"); };
  const ctx = createContext({ document, URL, setTimeout: () => 0, fetch: network, XMLHttpRequest: network, WebSocket: network,
    navigator: { sendBeacon: network, clipboard: { writeText: async (text: string) => { copies.push(text); } } },
    MutationObserver: class {
      constructor(readonly callback: Function) {}
      observe(root: Node, opts: any) {
        assert.equal(root, document); assert.ok(opts.subtree && opts.characterData && opts.childList);
        observers.push(this.callback);
      }
    },
    requestAnimationFrame(fn: Function) { return frames.push(fn); },
  });
  runInContext("this.window = this", ctx);
  const names = () => runInContext("Object.getOwnPropertyNames(globalThis).sort().join(' ')", ctx);
  const before = names();
  runInContext(script("blocks"), ctx);
  runInContext(script("ui"), ctx);
  function notify() {
    const records = changes.splice(0);
    if (records.length) for (const observer of observers) observer(records);
  }
  function flush() {
    for (let n = 0; changes.length || frames.length; n++) {
      assert.ok(n < 6, "observer feedback loop");
      notify(); for (const fn of frames.splice(0)) fn();
    }
  }
  function add(source = example, lang = "json") {
    const element = (tag: string, cls = "") => { const n = document.createElement(tag); n.className = cls; return n; };
    const block = element("div", "markdown-code selectable"), header = element("div", "code-header");
    const label = element("span", "code-lang"), button = element("button", "code-copy");
    const pre = element("pre"), code = element("code");
    label.textContent = lang; code.textContent = source;
    button.click = () => copies.push(source);
    header.append(label, button); pre.append(code); block.append(header, pre); document.append(block);
    flush();
    return { block, header, button, label, pre, code, view: () => block.querySelector(".cc-ui") };
  }
  return { add, document, flush, notify, frames, copies, clean() { assert.equal(requests, 0); assert.equal(names(), before); } };
}

const results: { id: string; ok: boolean; error?: string }[] = [];
async function check(id: string, fn: () => unknown) {
  try { await fn(); results.push({ id, ok: true }); console.log("PASS", id); }
  catch (err) { results.push({ id, ok: false, error: String(err) }); console.log("FAIL", id, err); }
}
const ui = (...parts: unknown[]) => JSON.stringify({ ui: parts });
await check("U01", () => {
  const p = page(), { block, view } = p.add();
  assert.equal(block.dataset.kind, "ui");
  assert.deepEqual(view()!.children.map(n => n.tag), ["section", "dl", "table", "aside", "section"]);
  assert.equal(view()!.querySelector("dt")!.textContent, "Owner");
  assert.equal(view()!.querySelectorAll("li").length, 3);
  for (const text of ['{"k":{"ui":[]}}', 'null', '1', '[]', '{"ui":{}}', '{}']) assert.equal(p.add(text).block.dataset.kind, "code");
  assert.equal(p.add(example, "text").block.dataset.kind, "quote");
});
await check("U02", () => {
  const p = page(), f = p.add('{"ui":[');
  assert.equal(f.view(), undefined);
  const raw = new Node("#text", p.document.changes, example.slice(0, -1));
  f.code.textContent = ""; f.code.append(raw); p.flush(); assert.equal(f.view(), undefined);
  raw.textContent = example; p.flush(); assert.equal(f.block.dataset.kind, "ui");
  raw.textContent += "{"; p.flush(); assert.equal(f.view(), undefined); assert.equal(f.block.dataset.kind, "code");
});
await check("U03", () => {
  const text = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const view = page().add(ui({ card: text, sub: text }, { story: [[text, text]] },
    { compare: { left: text, a: { [text]: text }, b: {} } }, { note: text, label: text },
    { steps: { title: text, link: { text, href: "https://example.test" }, items: [{ text, copy: text, checks: [[text, text]] }] } })).view()!;
  assert.ok(view.textContent.includes(text)); assert.equal(view.querySelector("img"), undefined);
  assert.equal(view.querySelector("script"), undefined);
  const note = page().add(ui({ note: "**bold** and `code` with _literal_ [url](x)" })).view()!;
  assert.equal(note.querySelector("strong")!.textContent, "bold"); assert.equal(note.querySelector("code")!.textContent, "code");
  assert.match(note.textContent, /_literal_ \[url\]\(x\)/);
});
await check("U04", () => {
  const p = page();
  for (const href of ["javascript:alert(1)", "data:text/html,x", "/path", "//example.test", "path", "https://example.test/lab", "http://example.test/"]) {
    const view = p.add(ui({ steps: { items: [], link: { text: "Open", href } } })).view()!;
    assert.equal(view.textContent, "Open");
    const a = view.querySelector("a");
    if (href.startsWith("http")) assert.deepEqual([a!.href, a!.target, a!.rel], [href, "_blank", "noopener noreferrer"]);
    else assert.equal(a, undefined);
  }
});
await check("U05", () => {
  const p = page(), f = p.add(), original = f.view()!;
  original.remove(); p.flush(); assert.equal(f.view(), original);
  const wrap = p.document.createElement("div"); f.pre.remove(); wrap.append(f.pre); f.block.append(wrap); p.flush();
  assert.equal(f.view(), original); assert.equal(f.block.querySelectorAll(".cc-ui").length, 1);
  f.code.textContent = ui({ note: "Updated" }); p.flush(); assert.equal(f.view()!.textContent, "Updated");
  f.label.textContent = "text"; p.flush(); assert.equal(f.view(), undefined); assert.equal(f.block.dataset.kind, "quote");
  f.block.remove(); const next = p.add(); assert.ok(next.view()); assert.equal(next.block.querySelectorAll(".cc-ui").length, 1);
});
await check("U06", () => {
  const p = page(), f = p.add();
  const view = f.view()!;
  view.querySelector("button")!.textContent = "Copied";
  p.notify(); assert.equal(p.frames.length, 1, "only BLOCKS schedules its normal scan");
  p.flush(); assert.equal(f.view(), view); assert.equal(f.block.dataset.kind, "ui");
});
await check("U07", () => {
  const a = JSON.parse('{"same":{"x":1,"z":[1,2]},"array":[1,2],"onlyA":null,"constructor":0}');
  const b = { same: { z: [1, 2], x: 1 }, array: [2, 1], onlyB: false };
  const table = page().add(ui({ compare: { a, b } })).view()!;
  assert.deepEqual(table.querySelectorAll("th").map(n => n.textContent), ["", "before", "after"]);
  const rows = table.querySelector("tbody")!.children;
  assert.deepEqual(rows.map(r => r.querySelector(".cc-key")!.textContent), ["same", "array", "onlyA", "constructor", "onlyB"]);
  assert.deepEqual(rows.map(r => r.className), ["cc-equal", ...Array(4).fill("cc-changed")]);
  assert.deepEqual(rows[1].children.map(c => c.textContent), ["array", "- [1,2]", "+ [2,1]"]);
  assert.deepEqual(table.querySelectorAll(".cc-missing").map(n => n.textContent), Array(3).fill("(none)"));
});
await check("U08", async () => {
  const p = page(), raw = '  line 1\n**keep** `ticks`  ', q = 'Question "A"?\n';
  const source = ui({ steps: { items: [{ text: "Try", copy: raw, checks: [["one", q], ["two", "Other?"]] }] } });
  const f = p.add(source);
  for (const b of f.view()!.querySelectorAll("button")) await b.click!();
  assert.equal(f.block.children[0], f.header); assert.equal(f.header.children[1], f.button);
  f.button.click!(); assert.equal(f.code.textContent, source); assert.deepEqual(p.copies, [raw, q, "Other?", source]);
  assert.match(html, /\.markdown-code:hover \.code-copy,[^{]*:focus-visible\{opacity:1\}/);
  assert.match(html, /\.code-header > :not\(\.code-copy\) \{ display: none \}/);
});
await check("U09", async () => {
  for (const id of ["ui", "blocks", "stick", "ui-style"]) assert.equal(html.split('id="cmux-chat-' + id + '"').length, 2);
  const follow = await get("/ui-test/follow?cmux=" + crypto.randomUUID());
  assert.doesNotMatch(follow, /cmux-chat-ui|\.cc-ui/); assert.equal(await get("/plain"), shell);
});
await check("U10", () => {
  const p = page();
  for (const source of [ui(), ui({ other: "?" }, null)]) assert.equal(p.add(source).view(), undefined);
  assert.equal(p.add(ui({ other: "?" }, { note: "known" })).view()!.textContent, "known");
});
await check("U11", () => { const p = page(); p.add(); p.clean(); });
await check("U12", () => {
  const p = page();
  for (const status of ["ok", "warn", "fail", "info", "constructor", [], null]) {
    const f = p.add(ui({ story: [4, []] }, { compare: { a: [] } }, { steps: { items: [null, 4] } }, { card: "Status", status }));
    const expected = typeof status === "string" && status !== "constructor" ? status : "info";
    assert.equal(f.view()!.querySelector(".cc-icon")!.attrs["aria-label"], expected);
  }
});
await check("U13", () => {
  const readme = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
  assert.ok(readme.includes('`' .repeat(3) + 'json\n' + example + '\n' + '`'.repeat(3)));
  assert.ok(fixture.includes(html.match(/<head>([\s\S]+?)<\/head>/)![1]));
});
const failed = results.filter(r => !r.ok).length;
const path = join(dir, "result.json");
writeFileSync(path, JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
console.log(results.length - failed + " passed, " + failed + " failed\n" + path);
process.exitCode = Number(failed !== 0);
