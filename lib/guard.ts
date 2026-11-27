// Loaded with `bun --preload` before the unmodified cmux server. The server has
// no flag to stop it from launching agents (claude, codex app-server, opencode
// acp, ...) at start, or on demand with auto-approve. Here they look like
// commands that are not installed. It also adds the follow page and makes the
// server read-only: nothing can send text or an interrupt to a terminal.
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { UUID, signLink } from "./common";
import { PAGE, PLAIN_CLICK, followSurface, pickChat, renameChat } from "./follow";
import { liveJoin, liveServer } from "./live";
import "./queue";

const shim = process.env.CMUX_BUNDLED_CLI_PATH ?? "";
const PLAIN = new Set(["git", "defaults"]);
// ps, pgrep, and lsof are for lib/follow.ts.
const EXACT = new Set(["/Applications/Ghostty.app/Contents/MacOS/ghostty", "/bin/ps", "/usr/bin/pgrep", "/usr/sbin/lsof"]);

function check(args: any[]) {
  const cmd = Array.isArray(args[0]) ? args[0][0] : args[0]?.cmd?.[0];
  if (EXACT.has(cmd) || PLAIN.has(cmd)) return;
  // The chat asks for cmux messages every 30 seconds: not in the log.
  if (cmd !== shim) console.log(`[orca-chat guard] blocked process: ${basename(String(cmd))}`);
  throw new Error(`Executable not found in $PATH: "${basename(String(cmd))}" (blocked by orca-chat)`);
}

const spawn = Bun.spawn as any;
const spawnSync = Bun.spawnSync as any;
(Bun as any).spawn = (...args: any[]) => (check(args), spawn(...args));
(Bun as any).spawnSync = (...args: any[]) => (check(args), spawnSync(...args));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  console.log(`[orca-chat guard] blocked request: ${url.hostname}`);
  throw new Error("network is off in orca-chat");
}) as typeof fetch;

const TOKEN = process.env.CMUX_AGENT_CHAT_TOKEN ?? "";
const READ_OPS = new Set(["subscribe", "get-file-diff"]);

// The same rules as hasTrustedHost and hasTrustedOrigin in server.ts.
function trusted(req: Request): boolean {
  const host = req.headers.get("host") ?? "", origin = req.headers.get("origin");
  try {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(`http://${host}`).hostname)) return false;
    return origin === null || (new URL(origin).protocol === "http:" && new URL(origin).host === host);
  } catch {
    return false;
  }
}

async function follow(url: URL): Promise<Response> {
  const surface = url.searchParams.get("cmux")?.toLowerCase();
  if (!surface || !UUID.test(surface) || url.searchParams.has("worktree")) return new Response("a cmux surface id is required", { status: 400 });
  if (url.pathname === `/${TOKEN}/follow`) return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  const state = await followSurface(surface).catch((err) => ({ session: null, title: "", message: `The session is not known: ${err?.message ?? err}` }));
  return Response.json(state, { headers: { "cache-control": "no-store" } });
}

// A pick does something, so only the script of our own page can send it: an image or a link
// in a chat has no such header, and another site may not set it.
function stripAction(req: Request, url: URL, action: "pick" | "rename"): Response {
  const [from, to] = ["cmux", "to"].map((k) => (url.searchParams.get(k) ?? "").toLowerCase());
  if (req.headers.get("x-orca-chat") !== action || !["same-origin", null].includes(req.headers.get("sec-fetch-site"))) return new Response("forbidden", { status: 403 });
  const ok = action === "pick" ? pickChat(from, to) : renameChat(from, (url.searchParams.get("workspace") ?? "").toLowerCase(), url.searchParams.get("title"));
  return new Response(null, { status: ok ? 204 : 404, headers: { "cache-control": "no-store" } });
}

// The one-time link that cmux-chat-open gives to cmux: valid for a minute.
const used = new Set<string>();
function openLink(url: URL): Response {
  const [surface, until, sig] = ["cmux", "until", "sig"].map((k) => url.searchParams.get(k) ?? "");
  if (!UUID.test(surface) || !(Number(until) > Date.now()) || sig !== signLink(TOKEN, surface, until) || used.has(sig)) return new Response("The link is not valid. Run cmux-chat-open again.", { status: 404 });
  used.add(sig);
  return new Response(null, { status: 302, headers: { location: `/${TOKEN}/follow?cmux=${surface}`, "cache-control": "no-store" } });
}

// The full width, not the 760 px of cmux: these are all its parts with that cap.
// The app sets its font sizes on the root by script, so they need !important.
const WIDE = ".connection-notice,.msg,.agent-messages-queued,details.thinking,.activity-indicator,.tool,.turn-activity,.turn-live-activity,.turn-actions,.error-block-wrap,.status-line,.plan-block,.files-changed";

// The look of Claude Code in a terminal, dark theme: the colors are those of 2.1.332,
// code blocks are its "Monokai Extended".
const TERMINAL = [
  ".msg .body :not(pre)>code{color:#b1b9f9;background:none;padding:0}",
  ".msg .body :is(h1,h2,h3,h4,h5,h6){font-weight:700}.msg .body h1{font-style:italic;text-decoration:underline}",
  ".msg .body blockquote{font-style:italic}.msg .body a{text-decoration:underline}",
  ".msg .body .markdown-table-wrap th{font-weight:700;color:var(--text)}",
  ".tool .name{font-weight:700;color:var(--text)}.tool-dot.ok{background:#4eba65}.tool-dot.fail{background:#ff6b80}",
  ".markdown-code{--shiki-token-keyword:#f92672;--shiki-token-function:#a6e22e;--shiki-token-string:#e6db74;--shiki-token-string-expression:#e6db74;--shiki-token-constant:#be84ff;--shiki-token-parameter:#fd971f;--shiki-token-comment:#75715e;--shiki-token-punctuation:#f8f8f2}",
].join("");

const BLOCK_STYLE = `
.markdown-code{position:relative;margin:4px 0 12px;border:1px solid var(--border);border-radius:6px;padding:8px 12px}
p:has(+ .markdown-code){margin-bottom:4px}
.markdown-code .code-header{display:contents}
.markdown-code .code-lang{display:none}
.markdown-code .code-copy{position:absolute;top:2px;right:2px;z-index:1;opacity:0}
.markdown-code:hover .code-copy,.markdown-code .code-copy:focus-visible{opacity:1}
:is(.msg .body .markdown-code,.markdown-code) pre{margin:0;padding:0;white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:visible}
:is(.msg .body .markdown-code,.markdown-code) pre code{display:block;white-space:inherit;overflow-wrap:inherit}
.markdown-code[data-kind="quote"]{background:none;border:0;border-left:3px solid #6272a4;border-radius:0;padding:2px 0 2px 12px}
:is(.msg .body .markdown-code,.markdown-code)[data-kind="quote"] :is(pre,pre code,pre span){font:inherit;color:inherit!important;background:none!important}
`;

const FOCUS = `<script id="cmux-chat-focus">if (parent !== window) (${PLAIN_CLICK})(() => {
  parent.postMessage({type:"orca-chat-focus"}, location.origin);
});</script>`;

const BLOCKS = `<script id="cmux-chat-blocks">(() => {
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      for (const block of document.querySelectorAll('.markdown-code')) {
        if (block.dataset.kind === 'ui') continue;
        const kind = block.querySelector('.code-lang')?.textContent.trim() === 'text' ? 'quote' : 'code';
        if (block.dataset.kind !== kind) block.dataset.kind = kind;
      }
    });
  }
  if (typeof MutationObserver === 'function')
    new MutationObserver(schedule).observe(document, {childList:true, subtree:true, characterData:true});
  schedule();
})();</script>`;

// The sidecar scrolls before it knows the final row heights. Follow later growth
// until the reader scrolls up to read an earlier message.
const STICK = `<script id="cmux-chat-stick">(() => {
  let el, pinned = true, frame = 0, drag = null, dragging = false, lastTop = 0, touchY, downUntil = 0;
  const gap = () => el.scrollHeight - el.clientHeight - el.scrollTop;
  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      if (el && pinned && gap() > 2) el.scrollTop = el.scrollHeight;
    });
  }
  const sizes = typeof ResizeObserver === 'function' && new ResizeObserver(schedule);
  const changes = typeof MutationObserver === 'function' && new MutationObserver(sync);
  function sync(records = []) {
    const next = document.getElementById('messages'), replaced = next !== el;
    if (replaced) { el = next; drag = null; downUntil = 0; touchY = undefined; }
    if (replaced || records.some(r => r.target === el && r.type === 'childList') || !changes) {
      if (sizes) { sizes.disconnect(); if (el) for (const node of [el, ...el.children]) sizes.observe(node); }
      if (changes && replaced) {
        changes.disconnect();
        changes.observe(document, {childList: true, subtree: true});
        if (el) changes.observe(el, {childList: true, subtree: true, attributes: true, characterData: true});
      }
    }
    schedule();
  }
  if (!changes) setInterval(sync, 250);
  const on = (type, fn) => document.addEventListener(type, fn, {capture: true, passive: true});
  function intent(up) {
    downUntil = up ? 0 : performance.now() + 500;
    if (up) pinned = false;
    else if (el && gap() <= 2) { pinned = true; schedule(); }
  }
  on('wheel', e => { if (el?.contains(e.target) && e.deltaY) intent(e.deltaY < 0); });
  on('touchstart', e => { touchY = el?.contains(e.target) ? e.touches[0].clientY : undefined; });
  on('touchmove', e => {
    const y = e.touches[0].clientY;
    if (touchY !== undefined && y !== touchY) { intent(y > touchY); touchY = y; }
  });
  on('keydown', e => {
    if (e.key === 'End') { pinned = true; schedule(); }
    else if (['ArrowUp','PageUp','Home','ArrowDown','PageDown',' '].includes(e.key))
      intent(['ArrowUp','PageUp','Home'].includes(e.key) || (e.key === ' ' && e.shiftKey));
  });
  on('pointerdown', e => {
    if (el && e.target === el) { drag = e.pointerId; dragging = e.offsetX >= el.clientWidth; lastTop = el.scrollTop; }
  });
  on('pointermove', e => { if (drag === e.pointerId) dragging = true; });
  const release = e => { if (drag === e.pointerId) drag = null; };
  on('pointerup', release); on('pointercancel', release);
  on('scroll', e => {
    if (e.target !== el) return;
    if (drag !== null && dragging && el.scrollTop !== lastTop) { pinned = el.scrollTop > lastTop && gap() <= 80; lastTop = el.scrollTop; }
    else if (performance.now() < downUntil && gap() <= 80) pinned = true;
    schedule();
  });
  on('scrollend', e => { if (e.target === el) downUntil = 0; });
  on('visibilitychange', schedule); sync();
})();</script>`;

const UI = '<script id="cmux-chat-ui">' + readFileSync(new URL("./page/ui.js", import.meta.url), "utf8") + '</script>';
const UI_STYLE = '<style id="cmux-chat-ui-style">' + readFileSync(new URL("./page/ui.css", import.meta.url), "utf8") + '</style>';

const LOOK = '<script id="cmux-chat-look">' + readFileSync(new URL("./page/look.js", import.meta.url), "utf8") + '</script>';
const LOOK_STYLE = '<style id="cmux-chat-look-style">' + readFileSync(new URL("./page/look.css", import.meta.url), "utf8") + '</style>';

// No input box, and no request to another host, for example an image in a reply.
async function harden(res: Response | undefined, host: string, sidecar = false) {
  if (!res?.headers.get("content-type")?.startsWith("text/html")) return res;
  const headers = new Headers(res.headers);
  headers.set("content-security-policy", `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://${host}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'`);
  const text = (await res.text()).replace("</head>", () => `${sidecar ? FOCUS + STICK + BLOCKS + UI + UI_STYLE + LOOK + LOOK_STYLE : ""}<style>:root{--font-size-base:16px!important;--font-size-code:14px!important}:is(${WIDE}){max-width:none!important;padding-left:16px;padding-right:16px}${TERMINAL}${sidecar ? BLOCK_STYLE : ""}#chat-card{display:none!important}</style></head>`);
  return new Response(text, { status: res.status, headers });
}

const serve = Bun.serve as any;
(Bun as any).serve = (options: any) => {
  liveServer((ws, raw) => options.websocket.message(ws, raw));
  return serve({
    ...options,
    async fetch(req: Request, server: any) {
      const url = new URL(req.url);
      if (TOKEN && [`/${TOKEN}/follow`, `/${TOKEN}/follow/state`, `/${TOKEN}/follow/pick`, `/${TOKEN}/follow/rename`, "/cmux-open"].includes(url.pathname)) {
        if (!trusted(req) || req.method !== "GET") return new Response("forbidden", { status: 403 });
        if (url.pathname === "/cmux-open") return openLink(url);
        if (url.pathname.endsWith("/pick")) return stripAction(req, url, "pick");
        if (url.pathname.endsWith("/rename")) return stripAction(req, url, "rename");
        return harden(await follow(url), url.host);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405 });
      return harden(await options.fetch(req, server), url.host, true);
    },
    websocket: {
      ...options.websocket,
      message(ws: any, raw: any) {
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {}
        if (!READ_OPS.has(msg?.op)) return;
        options.websocket.message(ws, raw);
        if (msg.op === "subscribe") liveJoin(ws, msg.sessionId);
      },
    },
  });
};
