// L01 A React node moves or changes, or a streaming update breaks the page.
// L02 The view goes stale, rebuilds per chunk, disappears, or appears twice.
// L03 A failed transform hides the original answer.
// L04 Label lines are missed, ordinary bold becomes a label, or rows split or keep separators.
// L05 A long paragraph, label line, or second answer body gets a lead.
// L06 A path loses its full text, or JSON and URLs get shortened.
// L07 A cloned fence copies the wrong text or has a missing, duplicate, or dead component.
// L08 A tool button stops working or a user message loses text.
// L09 The frame loads against the wrong background, or the strip and state colors clash.
// L10 The follow page receives the script or another injected feature breaks.
// L11 View writes trigger a loop, a request, or a new global.
// L12 Transcript text becomes HTML.
// L13 Removing or replacing a source leaves an orphan view or the wrong lead.
// L14 A label chip gets the wrong color: Did shown as fine, Expected as a problem, Try with no color.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContext, runInContext } from "node:vm";

const dir = mkdtempSync(join(tmpdir(), "cmux-look-"));
// Resolve the pinned DOM simulator from the isolated test directory with Bun's package cache.
const dom = join(dir, "dom.mjs");
writeFileSync(dom, 'export { JSDOM } from "jsdom@26.1.0";');
const { JSDOM } = await import(dom);
const win = new JSDOM().window;
const document = win.document;
const fixture = readFileSync(join(import.meta.dir, "fixtures/ui-demo.html"), "utf8");
document.body.innerHTML = fixture.split("<body>")[1].split("<script>")[0];
process.env.ORCA_CHAT_STATE_DIR = join(dir, "state");
process.env.CMUX_AGENT_CHAT_TOKEN = "look-test";
let route: (req: Request) => Promise<Response>;
Bun.serve = ((options: any) => { route = options.fetch; }) as any;
await import("../lib/guard");
Bun.serve({ fetch: () => new Response("<head></head>", { headers: { "content-type": "text/html" } }) });
const page = async (path: string) => (await route(new Request("http://localhost" + path, { headers: { host: "localhost" } }))).text();
const html = await page("/chat"), follow = await page("/look-test/follow?cmux=" + crypto.randomUUID());
const script = (name: string) => html.match(new RegExp('<script id="cmux-chat-' + name + '">([\\s\\S]*?)</script>'))![1];

const copies: string[] = [], frames: Function[] = [], timers: Function[] = [];
let requests = 0;
const network = () => { requests++; throw Error("Unexpected request"); };
const ctx = createContext({ document, MutationObserver: win.MutationObserver, URL, fetch: network, WebSocket: network,
  XMLHttpRequest: network, navigator: { clipboard: { writeText: async (s: string) => { copies.push(s); } } },
  requestAnimationFrame: (fn: Function) => frames.push(fn),
  setTimeout(fn: Function, ms: number) { if (ms === 250) timers.push(fn); return 1; } });
const names = () => runInContext("Object.getOwnPropertyNames(globalThis).sort().join(' ')", ctx);
const before = names();
const q = (s: string) => document.querySelector(s);
const all = (s: string) => [...document.querySelectorAll(s)];
const source = q(".msg.assistant > .body.selectable > p").parentNode, user = q(".msg.user > .body");
const original = source.innerHTML, userText = user.textContent;
const msg = source.parentNode, turn = msg.parentNode;
const view = () => msg.querySelector(".cc-view");
const settle = () => Bun.sleep(0);
async function flush() {
  for (let i = 0; i < 8; i++) {
    await settle();
    if (!frames.length && !timers.length) return;
    for (const fn of frames.splice(0)) fn();
    for (const fn of timers.splice(0)) fn();
  }
  assert.fail("Observer loop");
}
const summary = q(".turn-summary");
summary.addEventListener("click", () => summary.setAttribute("aria-expanded", "true"));
for (const id of ["blocks", "ui", "look"]) runInContext(script(id), ctx);
await flush();
const results: { id: string; ok: boolean; error?: string }[] = [];
async function check(id: string, fn: () => unknown) {
  try { await fn(); results.push({ id, ok: true }); console.log("PASS", id); }
  catch (error) { results.push({ id, ok: false, error: String(error) }); console.error("FAIL", id, error); }
}

await check("L01", async () => {
  assert.equal(source.innerHTML, original.replace('class="markdown-code"', 'class="markdown-code" data-kind="code"'));
  assert.equal(source.parentNode, msg);
  assert.equal(view(), msg.lastChild);
  const node = source.querySelector("p").firstChild;
  node.data = "Still streaming.";
  await flush();
  assert.equal(source.querySelector("p").firstChild, node);
  assert.equal(view().querySelector("p").textContent, "Still streaming.");
});
await check("L02", async () => {
  const last = view(), text = source.querySelector("p").firstChild;
  for (let i = 0; i < 6; i++) { text.data += i; await settle(); assert.equal(view(), last); }
  assert.equal(timers.length, 1);
  await flush();
  assert.equal(view().querySelector("p").textContent, text.data);
  view().remove();
  await flush();
  assert.equal(msg.querySelectorAll(".cc-view").length, 1);
  assert.equal(view(), msg.lastChild);
});
await check("L03", async () => {
  const p = source.querySelector("p");
  p.cloneNode = () => { throw Error("Synthetic transform failure"); };
  p.append(" More.");
  await flush();
  assert.equal(view(), null);
  assert.equal(source.hasAttribute("data-cc-source"), false);
  assert.ok(q(".turn-virtual-row:last-child .cc-view"));
  delete p.cloneNode;
  p.append(" Done.");
  await flush();
  assert.ok(view());
});
await check("L04", async () => {
  const p = document.createElement("p");
  p.innerHTML = "Text <strong>mid sentence</strong><br><strong>This phrase is far too long</strong> stays";
  source.append(p);
  await flush();
  assert.equal(view().querySelectorAll(".cc-grid").length, 1);
  assert.deepEqual([...view().querySelectorAll("dt")].map(n => n.textContent), ["Saw", "Did", "Expected", "Try", "Lab"]);
  // L14: the chip color follows the label.
  assert.deepEqual([...view().querySelectorAll("dt")].map(n => n.dataset.tone ?? ""), ["", "bad", "good", "next", "next"]);
  assert.equal(view().querySelector(".cc-section").textContent, "Where");
  for (const dd of view().querySelectorAll("dd")) assert.doesNotMatch(dd.textContent.trim(), /^[·:-]/);
  assert.equal(view().lastChild.innerHTML, p.innerHTML);
  assert.equal(view().querySelector("dd a").rel, "noopener noreferrer");
});
const extra = document.createElement("div");
extra.className = "msg assistant";
extra.innerHTML = '<div class="body selectable"><p>Second answer</p></div>';
await check("L05", async () => {
  assert.equal(view().querySelectorAll(".cc-lead").length, 1);
  turn.append(extra);
  source.querySelector("p").textContent = "x".repeat(221);
  await flush();
  assert.equal(turn.querySelector(".cc-lead"), null);
  source.querySelector("p").innerHTML = "<strong>Status</strong> Finished";
  await flush();
  assert.equal(turn.querySelector(".cc-lead"), null);
});
await check("L06", async () => {
  const values = ["src/app/file.ts:9", "src/file.ts", '{"by":"a/b/c"}', "https://example.test/a/b"];
  for (const val of values) { const code = document.createElement("code"); code.textContent = val; source.append(code); }
  await flush();
  const short = [...view().querySelectorAll("[data-short]")];
  assert.deepEqual(short.map(n => n.dataset.short), ["query.ts:48", "file.ts:9"]);
  for (const code of short) {
    const range = document.createRange(); range.selectNodeContents(code);
    assert.equal(range.toString(), code.title);
    assert.equal(code.textContent, code.title);
  }
  assert.match(html, /code\[data-short\]\s*\{ font-size: 0/);
});
await check("L07", async () => {
  for (const block of all(".cc-view .markdown-code")) {
    block.querySelector(".code-copy").click();
    assert.equal(copies.at(-1), block.querySelector("pre code").textContent);
  }
  const block = q('.cc-view [data-kind="ui"]');
  assert.equal(block.querySelectorAll(".cc-ui").length, 1);
  block.querySelector(".cc-check button").click();
  assert.equal(copies.at(-1), block.querySelector(".cc-check q").textContent);
  const label = source.querySelector(".code-lang"); label.textContent = "text"; await flush();
  assert.equal(view().querySelector(".markdown-code").dataset.kind, "quote");
});
await check("L08", () => {
  const button = q(".turn-summary");
  assert.equal(button, summary);
  button.click();
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(button.closest(".msg").querySelector(".cc-view"), null);
  assert.equal(user.textContent, userText);
  assert.equal(q(".msg.user > .body"), user);
});
await check("L09", () => {
  const color = "color-mix(in srgb, #f8f8f2 9%, #212121)";
  assert.ok(html.includes("--bg: " + color + " !important"));
  assert.ok(follow.includes("--page:" + color));
  for (const selector of ["iframe", "#state", "body"]) assert.ok(follow.match(new RegExp(selector + "\\{[^}]*background:var\\(--page\\)")));
  assert.match(follow, /iframe\{[^}]*visibility:hidden[^}]*color-scheme:light/);
  assert.match(follow, /#bar\{[^}]*background:#292929/);
});
await check("L10", () => {
  assert.doesNotMatch(follow, /cmux-chat-(look|ui|blocks|stick)/);
  assert.ok(fixture.includes(html.slice(6, -7)));
  for (const id of ["look", "look-style", "ui", "blocks", "stick"])
    assert.equal(html.split('id="cmux-chat-' + id + '"').length, 2);
});
await check("L11", async () => {
  const old = view();
  old.querySelector(".cc-section").append(" changed");
  await settle();
  assert.equal(timers.length, 0);
  await flush(); assert.equal(view(), old);
  assert.equal(requests, 0); assert.equal(names(), before);
});
await check("L12", async () => {
  const p = document.createElement("p"); p.textContent = '<img src=x onerror="bad()">'; source.append(p);
  await flush(); assert.equal(view().querySelector("img"), null);
  assert.equal(view().lastChild.textContent, p.textContent);
});
await check("L13", async () => {
  source.remove(); await flush(); assert.equal(view(), null);
  assert.equal(extra.querySelector(".cc-lead").textContent, "Second answer");
  const row = turn.parentNode, list = row.parentNode, fresh = row.cloneNode(false);
  row.remove(); await flush();
  fresh.innerHTML = '<div class="turn-group"><div class="msg assistant"><div class="body selectable"><p>Mounted</p></div></div></div>';
  list.append(fresh); await flush();
  assert.equal(fresh.querySelector(".cc-lead").textContent, "Mounted");
  assert.equal(fresh.querySelectorAll(".cc-view").length, 1);
});
const failed = results.filter(result => !result.ok).length;
const path = join(dir, "result.json");
writeFileSync(path, JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
console.log(results.length - failed + " passed, " + failed + " failed\n" + path);
win.close();
process.exitCode = Number(failed > 0);
