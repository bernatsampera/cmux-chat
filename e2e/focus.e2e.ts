// A plain click in the current chat, the state line or empty space misses or repeats a pick.
// A drag, text selection, second press or double click moves focus while reading.
// Controls, modified clicks and right clicks take the keyboard away.
// Quick clicks in either document bypass the shared 400 ms limit.
// An unrelated window, foreign origin or hidden frame can pick a terminal.
// A click on a tab picks twice or steals focus from the rename field.

import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cmux-focus-"));
const dom = join(dir, "dom.mjs");
writeFileSync(dom, 'export { JSDOM } from "jsdom@26.1.0";');
const { JSDOM } = await import(dom);
const me = crypto.randomUUID(), base = "http://localhost/focus-test/follow?cmux=" + me;
process.env.ORCA_CHAT_STATE_DIR = dir;
process.env.CMUX_AGENT_CHAT_TOKEN = "focus-test";
let route: (req: Request) => Promise<Response>;
Bun.serve = ((options: any) => { route = options.fetch; }) as any;
await import("../lib/guard");
Bun.serve({ fetch: () => new Response("<head></head>", { headers: { "content-type": "text/html" } }) });
const get = async (url: string) => (await route(new Request(url, { headers: { host: "localhost" } }))).text();
const follow = await get(base);
const results: { name: string; error?: string }[] = [];
async function check(name: string, test: () => void) {
  try { test(); results.push({ name }); }
  catch (error) { results.push({ name, error: String(error) }); }
}

const win = new JSDOM(follow, { url: base, pretendToBeVisual: true }).window;
const doc = win.document;
win.HTMLElement.prototype.scrollIntoView = () => {};
let now = 0, session = "first";
const timers = new Map<number, { at: number; fn: Function }>();
let next = 0;
function clock(w: any) {
  w.performance.now = () => now;
  w.setTimeout = (fn: Function, delay: number) => {
    timers.set(++next, { at: now + delay, fn });
    return next;
  };
  w.clearTimeout = (id: number) => timers.delete(id);
}
clock(win);
function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!due || due[1].at > end) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].fn();
  }
  now = end;
}
const picks: string[] = [];
win.fetch = async (path: string, options: any) => {
  if (path.startsWith("follow/state")) return { ok: true, json: async () => ({
    session, chats: [me, "other"].map(id => ({ id, title: id })),
  }) };
  const url = new URL(path, base);
  assert.equal(url.pathname, "/focus-test/follow/pick");
  assert.equal(url.searchParams.get("cmux"), me);
  assert.equal(options.headers["x-orca-chat"], "pick");
  picks.push(url.searchParams.get("to")!);
  return { ok: true };
};
const context = (w: any) => ({ document: w.document, window: w, parent: w.parent, location: w.location, performance: w.performance, setTimeout: w.setTimeout, clearTimeout: w.clearTimeout, fetch: w.fetch, URLSearchParams, AbortSignal });
runInNewContext(doc.querySelector("script").textContent, context(win));
await Bun.sleep(0);
const frame = doc.querySelector("iframe");
frame.onload();
const chat = frame.contentWindow;
assert.equal(chat.location.origin, win.location.origin);
clock(chat);
const chatHtml = await get(frame.src);
const source = new JSDOM(chatHtml).window.document.querySelector("#cmux-chat-focus")?.textContent;
const body = chat.document.createElement("body");
chat.document.appendChild(chat.document.createElement("html")).append(body);
body.innerHTML = '<p>select this word</p><a><i></i></a><button></button><button class="cc-copy"><b></b></button><summary></summary><input><textarea></textarea><select></select><label></label><div contenteditable></div><div role="button"></div><div tabindex="0"></div>';
function message(source: any, origin: string, data = { type: "orca-chat-focus" }) {
  win.dispatchEvent(new win.MessageEvent("message", { source, origin, data }));
}
// jsdom does not fill in the source and origin for postMessage between frames.
win.postMessage = (data: any, origin: string) => {
  assert.equal(origin, chat.location.origin);
  message(chat, chat.location.origin, data);
};
if (source) runInNewContext(source, context(chat));
doc.querySelector("#note").textContent = "select this word";
function event(node: any, type: string, values = {}) {
  const w = node.ownerDocument.defaultView;
  const e = new w.MouseEvent(type, { bubbles: true, ...values });
  Object.defineProperty(e, "pointerId", { value: 1 });
  node.dispatchEvent(e);
}
function click(node: any, values = {}) {
  event(node, "pointerdown", values);
  event(node, "pointerup", values);
  event(node, "click", values);
}
const take = () => picks.splice(0);
await check("plain clicks pick this terminal once after the delay", () => {
  for (const node of [body, doc.querySelector("#state"), doc.body]) {
    click(node); advance(349); assert.deepEqual(take(), []);
    advance(1); assert.deepEqual(take(), [me]); advance(400);
  }
});
await check("selection, drags, double clicks and another press cancel", () => {
  for (const node of [body.querySelector("p"), doc.querySelector("#note")]) {
    event(node, "pointerdown"); event(node, "pointerup", { clientX: 3, clientY: 4 }); advance(400);
    click(node);
    node.ownerDocument.getSelection().selectAllChildren(node);
    advance(400); node.ownerDocument.getSelection().removeAllRanges();
    click(node); advance(100); click(node); event(node, "dblclick"); advance(400);
    click(node); advance(100); event(node, "pointerdown"); advance(400);
    assert.deepEqual(take(), []);
  }
});
await check("interactive targets, modifiers and right clicks keep focus", () => {
  for (const node of body.querySelectorAll("a i,button,.cc-copy b,summary,input,textarea,select,label,[contenteditable],[role],[tabindex]")) {
    click(node); advance(400); assert.deepEqual(take(), []);
  }
  for (const node of [body, doc.body]) {
    for (const key of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
      click(node, { [key]: true }); advance(400); assert.deepEqual(take(), []);
    }
    click(node, { button: 2 }); advance(400); assert.deepEqual(take(), []);
  }
});
await check("click bursts share one limit across the frame and page", () => {
  for (let i = 0; i < 5; i++) { click(body); advance(50); }
  advance(300); assert.deepEqual(take(), [me]);
  click(doc.body); advance(350); assert.deepEqual(take(), []);
  advance(50); message(chat, win.location.origin); assert.deepEqual(take(), [me]);
});
await check("strip picks and double click rename keep their timing", () => {
  advance(500);
  const [own, other] = doc.querySelectorAll(".tab span");
  click(other); advance(500); assert.deepEqual(take(), ["other"]);
  click(own); advance(499); assert.deepEqual(take(), []);
  advance(1); assert.deepEqual(take(), [me]);
  click(own); advance(80); click(own); event(own, "dblclick"); advance(500);
  assert.equal(doc.activeElement, doc.querySelector(".tab.me input")); assert.deepEqual(take(), []);
});
await Bun.sleep(0);
session = "second";
doc.dispatchEvent(new win.Event("visibilitychange"));
await Bun.sleep(0);
doc.querySelectorAll("iframe")[1].onload();
await check("only the current frame and exact origin can request focus", () => {
  const current = doc.querySelectorAll("iframe")[1].contentWindow;
  message(win, win.location.origin); message(current, "https://example.org");
  message(chat, win.location.origin); message(current, win.location.origin, { type: "other" });
  assert.deepEqual(take(), []);
  message(current, win.location.origin); assert.deepEqual(take(), [me]);
});
const failed = results.filter(r => r.error).length;
for (const r of results) console.log(r.error ? "FAIL" : "PASS", r.name, r.error ?? "");
writeFileSync(join(dir, "result.json"), JSON.stringify(results, null, 2));
console.log(results.length - failed + " passed, " + failed + " failed\n" + join(dir, "result.json"));
process.exitCode = Number(failed > 0);
