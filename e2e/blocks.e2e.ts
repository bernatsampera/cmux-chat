// B01 A text fence gets a code tag or a json fence gets a quote tag.
// B02 A streamed or replaced block has a missing or stale tag after its language changes.
// B03 The script appears twice, on the follow page, or in a non-HTML response.
// B04 A missing observer breaks the script or its own writes cause a loop.
// B05 The header or language stays visible, or the copy button never appears.
// B06 Long code lines scroll sideways instead of wrapping.
// B07 The new styles change inline code or tables.
// B08 The stick-to-bottom script breaks.
// B09 The script makes a network request or creates global names.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

// Run STICK in its own process before the guard restricts child processes.
const stick = Bun.spawnSync([process.execPath, join(import.meta.dir, "stick.e2e.ts")]);
const dir = mkdtempSync(join(tmpdir(), "cmux-blocks-"));
process.env.ORCA_CHAT_STATE_DIR = join(dir, "state");
process.env.CMUX_AGENT_CHAT_TOKEN = "blocks-test";
let route: (req: Request) => Promise<Response>;
Bun.serve = ((options: any) => { route = options.fetch; }) as any;
await import("../lib/guard");
const shell = "<html><head></head><body></body></html>";
Bun.serve({ fetch(req) {
  return new Response(shell, { headers: { "content-type": req.url.endsWith("/plain") ? "text/plain" : "text/html" } });
} });
async function get(path: string) {
  const response = await route(new Request("http://localhost" + path, { headers: { host: "localhost" } }));
  assert.equal(response.status, 200);
  return response.text();
}
const html = await get("/chat");
const follow = await get("/blocks-test/follow?cmux=" + crypto.randomUUID());
const scripts = [...html.matchAll(/<script id="cmux-chat-blocks">([\s\S]*?)<\/script>/g)];
const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
writeFileSync(join(dir, "chat.html"), html);

function block(lang: string) {
  return {
    label: { textContent: lang },
    dataset: {} as { kind?: string },
    querySelector(selector: string) { assert.equal(selector, ".code-lang"); return this.label; },
  };
}

function page(observer = true) {
  const blocks = [block("text"), block("json")];
  const frames: Function[] = [];
  let scans = 0, requests = 0;
  const document = { querySelectorAll(selector: string) {
    assert.equal(selector, ".markdown-code"); scans++; return blocks;
  } };
  let change = (_type: string) => {};
  class Observer {
    constructor(readonly callback: Function) {}
    observe(root: unknown, options: Record<string, boolean>) {
      assert.equal(root, document);
      assert.ok(options.subtree);
      change = type => { if (options[type]) this.callback([{ type }]); };
    }
  }
  function network() { requests++; throw Error("unexpected network request"); }
  const ctx = createContext({ document, MutationObserver: observer ? Observer : undefined,
    requestAnimationFrame(fn: Function) { return frames.push(fn); },
    fetch: network, XMLHttpRequest: network, WebSocket: network, navigator: { sendBeacon: network },
  });
  runInContext("this.window = this", ctx);
  const names = () => runInContext("Object.getOwnPropertyNames(globalThis).sort().join(' ')", ctx);
  const before = names();
  runInContext(scripts[0][1], ctx);
  const frame = () => { for (const fn of frames.splice(0)) fn(); };
  frame();
  return { blocks, change, frame, frames, get scans() { return scans; },
    clean() { assert.equal(names(), before); assert.equal(requests, 0); },
  };
}

const results: { id: string; ok: boolean; error?: string }[] = [];
function check(id: string, fn: () => void) {
  try { fn(); results.push({ id, ok: true }); }
  catch (err) { results.push({ id, ok: false, error: String(err) }); }
  const result = results.at(-1)!;
  console.log(result.ok ? "PASS" : "FAIL", id, result.error ?? "");
}
check("B01", () => {
  assert.deepEqual(page().blocks.map(b => b.dataset.kind), ["quote", "code"]);
});
check("B02", () => {
  const p = page(), late = block("text");
  p.blocks.push(late); p.change("childList"); p.frame();
  assert.equal(late.dataset.kind, "quote");
  late.label.textContent = "json"; p.change("characterData"); p.frame();
  assert.equal(late.dataset.kind, "code");
  p.blocks[0] = block("json"); p.change("childList"); p.frame();
  assert.equal(p.blocks[0].dataset.kind, "code");
});
const plain = await get("/plain");
check("B03", () => {
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(follow, /cmux-chat-blocks/);
  assert.equal(plain, shell);
});
check("B04", () => {
  assert.equal(page(false).blocks[0].dataset.kind, "quote");
  const p = page();
  Object.freeze(p.blocks[0].dataset);
  p.change("attributes"); assert.equal(p.frames.length, 0);
  p.change("characterData"); p.change("childList"); p.change("childList");
  assert.equal(p.frames.length, 1); p.frame();
  assert.equal(p.scans, 2); assert.equal(p.frames.length, 0);
});
check("B05", () => {
  assert.ok(css.includes(".markdown-code .code-header{display:contents}"));
  assert.ok(css.includes(".markdown-code .code-lang{display:none}"));
  assert.match(css, /\.markdown-code \.code-copy\{position:absolute;top:2px;right:2px;[^}]*opacity:0}/);
  assert.match(css, /\.markdown-code:hover \.code-copy,[^{]+\{opacity:1}/);
  assert.match(css, /\.markdown-code\{[^}]*margin:4px 0 12px;border:1px solid var\(--border\);border-radius:6px;padding:8px 12px}/);
  assert.ok(css.includes("p:has(+ .markdown-code){margin-bottom:4px}"));
  assert.match(css, /\[data-kind="quote"\]\{background:none;border:0;border-left:3px solid #6272a4;border-radius:0;padding:2px 0 2px 12px}/);
  assert.match(css, /\[data-kind="quote"\] :is\(pre,pre code,pre span\)\{font:inherit;color:inherit!important;background:none!important}/);
});
check("B06", () => {
  assert.match(css, /\.markdown-code\) pre\{[^}]*white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:visible}/);
  assert.match(css, /\.markdown-code\) pre code\{display:block;white-space:inherit;overflow-wrap:inherit}/);
});
check("B07", () => {
  const rules = (style: string) => style.match(/[^{}]+\{[^{}]*\}/g)!.map(rule => rule.trim());
  const shared = new Set(rules(follow.match(/<style>([^<]*#chat-card[^<]*)<\/style>/)![1]));
  const added = rules(css).filter(rule => !shared.has(rule));
  assert.ok(added.length);
  for (const rule of added) {
    for (const selector of rule.split("{")[0].split(/,(?![^()]*\))/)) {
      assert.ok(selector.includes(".markdown-code"), selector);
    }
  }
});
check("B08", () => {
  assert.equal(stick.exitCode, 0, stick.stderr.toString());
  assert.match(stick.stdout.toString(), /11 passed, 0 failed/);
});
check("B09", () => {
  const p = page(); p.blocks.push(block("text")); p.change("childList"); p.frame(); p.clean();
});

const passed = results.filter(r => r.ok).length, failed = results.length - passed;
const path = join(dir, "result.json");
writeFileSync(path, JSON.stringify({ passed, failed, results }, null, 2));
console.log(passed + " passed, " + failed + " failed\n" + path);
process.exitCode = failed ? 1 : 0;
