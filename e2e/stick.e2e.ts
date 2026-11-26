// S01 A row grows after the first stick and leaves the view above the end.
// S02 A programmatic scroll from the sidecar unpins the view.
// S03 Scrolling up with the wheel, keys, touch, or scroll bar pulls the reader back down.
// S04 Scrolling back to the end fails to pin later content.
// S05 The messages element appears late or is replaced and never sticks.
// S06 A hidden frame grows and is above the end when shown.
// S07 Missing observers break the page.
// S08 The script appears twice, on the follow page, or in a non-HTML response.
// S09 Scroll writes repeat in a frame or trigger an endless loop.
// S10 The script makes a network request or creates global names.
// S11 Old input or events outside the transcript change the pin.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

// Run the real guard with an in-memory server. No socket is opened.
let route: (req: Request) => Promise<Response>;
const dir = mkdtempSync(join(tmpdir(), "cmux-stick-"));
process.env.ORCA_CHAT_STATE_DIR = join(dir, "state");
Bun.serve = ((options: any) => { route = options.fetch; }) as any;
process.env.CMUX_AGENT_CHAT_TOKEN = "stick-test";
await import("../lib/guard");
Bun.serve({ fetch(req) {
  const type = req.url.endsWith("/plain") ? "text/plain" : "text/html";
  return new Response("<html><head></head><body></body></html>", { headers: { "content-type": type } });
} });
const get = (path: string) => route(new Request("http://localhost" + path, { headers: { host: "localhost" } }));
const chat = await get("/chat"), html = await chat.text();
const scripts = [...html.matchAll(/<script id="cmux-chat-stick">([\s\S]*?)<\/script>/g)];
const source = scripts[0]?.[1];

class Box {
  children: Box[] = [];
  scrollHeight = 1000;
  clientHeight = 200;
  clientWidth = 500;
  position = 100;
  writes = 0;
  afterWrite = () => {};
  contains(target: Box): boolean { return this === target || this.children.some(c => c.contains(target)); }
  get end() { return this.scrollHeight - this.clientHeight; }
  get scrollTop() { return this.position; }
  set scrollTop(value: number) {
    this.position = Math.min(this.end, Math.max(0, value));
    this.writes++;
    this.afterWrite();
  }
}

function page({ late = false, resize = true, mutation = true } = {}) {
  let box = new Box(), mounted = !late, time = 1, nextId = 0;
  box.children.push(new Box());
  const frames: Function[] = [], timers: Function[] = [];
  const handlers = new Map<string, Function[]>();
  const doc = {
    visibilityState: "visible",
    defaultView: { frameElement: { style: { visibility: "visible" } } },
    getElementById: (id: string) => mounted && id === "messages" ? box : null,
    addEventListener(type: string, fn: Function) { handlers.set(type, [...handlers.get(type) ?? [], fn]); },
  };
  const event = (type: string, data = {}) => {
    for (const fn of handlers.get(type) ?? []) fn({ target: box, pointerId: 1, ...data });
  };
  class Observer {
    targets = new Map<unknown, any>();
    constructor(readonly callback: Function) {}
    observe(target: unknown, opts = {}) { this.targets.set(target, opts); }
    disconnect() { this.targets.clear(); }
  }
  const sizes: Observer[] = [], changes: Observer[] = [];
  function change(target: Box | typeof doc, type = "childList") {
    for (const observer of changes) {
      if ([...observer.targets].some(([root, opts]) => opts[type] && (root === target ||
        (opts.subtree && target instanceof Box && (root === doc ? mounted && box.contains(target) : (root as Box).contains(target)))))) {
        observer.callback([{ target, type }]);
      }
    }
  }
  function grow(node = box.children[0]) {
    box.scrollHeight += 360;
    for (const o of sizes) if (o.targets.has(node)) o.callback([]);
  }
  function frame() { time += 16; for (const fn of frames.splice(0)) fn(time); }
  let requests = 0;
  const network = () => { requests++; throw Error("unexpected network call"); };
  const ctx = createContext({
    document: doc, performance: { now: () => time },
    requestAnimationFrame(fn: Function) { frames.push(fn); return ++nextId; },
    setInterval(fn: Function) { timers.push(fn); },
    ResizeObserver: resize ? class extends Observer { constructor(fn: Function) { super(fn); sizes.push(this); } } : undefined,
    MutationObserver: mutation ? class extends Observer { constructor(fn: Function) { super(fn); changes.push(this); } } : undefined,
    fetch: network, WebSocket: network, XMLHttpRequest: network, navigator: { sendBeacon: network },
  });
  runInContext("this.window = this", ctx);
  const names = () => runInContext("Object.getOwnPropertyNames(globalThis).sort().join(' ')", ctx);
  const before = names();
  assert.ok(source, "missing sidecar script");
  runInContext(source, ctx);
  frame();
  return {
    get box() { return box; }, frames, doc, event, frame, grow, change,
    mount() { mounted = true; box = new Box(); box.children.push(new Box()); change(doc); },
    scroll(top: number) { box.position = top; event("scroll"); },
    tick() { time += 500; for (const fn of timers) fn(); frame(); },
    atEnd() { assert.equal(box.position, box.end); },
    clean() { assert.equal(names(), before); assert.equal(requests, 0); },
  };
}

const results: { id: string; check: string; ok: boolean; error?: string }[] = [];
async function check(id: string, name: string, fn: () => unknown) {
  try { await fn(); results.push({ id, check: name, ok: true }); }
  catch (err) { results.push({ id, check: name, ok: false, error: String(err) }); }
  const result = results.at(-1)!;
  console.log(result.ok ? "PASS" : "FAIL", id, name, result.error ?? "");
}
await check("S01", "late row growth and replacement children", () => {
  const p = page(); p.atEnd(); p.grow(); p.frame(); p.atEnd();
  p.box.children = [new Box()]; p.change(p.box); p.frame();
  p.grow(); p.frame(); p.atEnd(); p.grow(p.box); p.frame(); p.atEnd();
});
await check("S02", "sidecar compensation keeps the pin", () => {
  const p = page(); p.event("pointerdown", { offsetX: 100 }); p.scroll(300); p.frame(); p.atEnd(); p.grow(); p.frame(); p.atEnd();
});
await check("S03", "upward input leaves the reader in place", () => {
  for (const action of ["wheel", "ArrowUp", "PageUp", "Home", " ", "drag", "touch"]) {
    const p = page(), writes = p.box.writes;
    p.grow();
    if (action === "wheel") p.event("wheel", { deltaY: -1 });
    else if (action === "drag") { p.event("pointerdown"); p.event("pointermove"); }
    else if (action === "touch") {
      p.event("touchstart", { touches: [{ clientY: 40 }] });
      p.event("touchmove", { touches: [{ clientY: 60 }] });
    } else p.event("keydown", { key: action, shiftKey: true });
    p.scroll(100); p.event("pointerup"); p.frame();
    p.grow(); p.frame(); assert.equal(p.box.writes, writes, action);
  }
});
await check("S04", "downward input and End resume the pin", () => {
  for (const key of ["wheel", "ArrowDown", "PageDown", " ", "drag", "End"]) {
    const p = page(); p.event("wheel", { deltaY: -1 }); p.scroll(100); p.frame();
    if (key === "wheel") p.event("wheel", { deltaY: 5 });
    else if (key === "drag") p.event("pointerdown", { offsetX: p.box.clientWidth });
    else p.event("keydown", { key });
    if (key !== "End") p.scroll(p.box.end - 80);
    p.event("pointerup"); p.frame(); p.atEnd(); p.grow(); p.frame(); p.atEnd();
  }
});
await check("S05", "late mount and React replacement", () => {
  const p = page({ late: true }); p.mount(); p.frame(); p.atEnd();
  const old = p.box; p.mount(); p.frame(); p.atEnd();
  p.event("wheel", { target: old, deltaY: -1 }); p.grow(); p.frame(); p.atEnd();
});
await check("S06", "growth while the iframe is hidden and when shown", () => {
  // CSS visibility preserves layout and does not send a document visibility event.
  const p = page(), iframe = p.doc.defaultView.frameElement;
  iframe.style.visibility = "hidden";
  p.grow(); p.frame(); p.atEnd(); p.grow(); iframe.style.visibility = "visible"; p.frame(); p.atEnd();
});
await check("S07", "missing observers still allow growth and late mounts", () => {
  for (const [resize, mutation] of [[false, true], [true, false], [false, false]]) {
    const p = page({ resize, mutation, late: true }); p.mount(); p.tick(); p.atEnd();
    p.box.scrollHeight += 400; p.change(p.box.children[0], "characterData"); p.tick(); p.atEnd();
  }
});
await check("S08", "only sidecar HTML gets one inline script", async () => {
  assert.equal(scripts.length, 1);
  assert.ok(html.indexOf(scripts[0][0]) < html.indexOf("</head>"));
  assert.match(chat.headers.get("content-security-policy") ?? "", /script-src [^;]*'unsafe-inline'/);
  const follow = await get("/stick-test/follow?cmux=" + crypto.randomUUID());
  assert.equal(follow.status, 200); assert.match(follow.headers.get("content-type")!, /text\/html/);
  assert.doesNotMatch(await follow.text(), /cmux-chat-stick/);
  assert.equal(await (await get("/plain")).text(), "<html><head></head><body></body></html>");
});
await check("S09", "bursts coalesce, small gaps and feedback cause no writes", () => {
  const p = page(), initial = p.box.writes;
  p.box.afterWrite = () => { p.event("scroll"); p.change(p.box); };
  p.box.scrollHeight += 2; p.change(p.box); p.frame(); assert.equal(p.box.writes, initial);
  p.grow(); p.grow(); p.change(p.box); p.event("scroll");
  assert.equal(p.frames.length, 1); p.frame(); p.atEnd(); p.frame();
  assert.equal(p.box.writes, initial + 1); assert.equal(p.frames.length, 0);
});
await check("S10", "no requests or new global names", () => {
  const p = page(); p.mount(); p.grow(); p.frame(); p.event("keydown", { key: "End" }); p.frame(); p.clean();
});
await check("S11", "outside input and expired scroll intent are ignored", () => {
  const p = page(); p.event("wheel", { target: new Box(), deltaY: -1 }); p.grow(); p.frame(); p.atEnd();
  p.event("wheel", { deltaY: -1 }); p.scroll(100); p.event("wheel", { deltaY: 1 }); p.tick();
  const writes = p.box.writes; p.scroll(p.box.end); p.grow(); p.frame(); assert.equal(p.box.writes, writes);
});

const path = join(dir, "result.json");
const failed = results.filter(r => !r.ok).length, passed = results.length - failed;
writeFileSync(path, JSON.stringify({ passed, failed, results }, null, 2));
console.log(passed + " passed, " + failed + " failed\n" + path);
process.exitCode = failed ? 1 : 0;
