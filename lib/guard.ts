// Loaded with `bun --preload` before the unmodified cmux server. The server has
// no flag to stop it from launching agents (claude, codex app-server, opencode
// acp, ...) at start, or on demand with auto-approve. Here they look like
// commands that are not installed. It also adds the follow page and makes the
// server read-only: nothing can send text or an interrupt to a terminal.
import { basename } from "node:path";
import { UUID, signLink } from "./common";
import { PAGE, followState, followSurface, pickChat, renameChat } from "./follow";
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
  const worktree = url.searchParams.get("worktree") ?? "", surface = url.searchParams.get("cmux")?.toLowerCase();
  if (surface === undefined ? !/^id:.{1,500}$/.test(worktree) : worktree || !UUID.test(surface)) return new Response("worktree is missing", { status: 400 });
  if (url.pathname === `/${TOKEN}/follow`) return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  const state = await (surface ? followSurface(surface) : followState(worktree, TOKEN)).catch((err) => ({ session: null, title: "", message: `The session is not known: ${err?.message ?? err}` }));
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

// No input box, and no request to another host, for example an image in a reply.
async function harden(res: Response | undefined, host: string) {
  if (!res?.headers.get("content-type")?.startsWith("text/html")) return res;
  const headers = new Headers(res.headers);
  headers.set("content-security-policy", `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://${host}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'`);
  const text = (await res.text()).replace("</head>", `<style>:root{--font-size-base:16px!important;--font-size-code:14px!important}:is(${WIDE}){max-width:none!important;padding-left:16px;padding-right:16px}${TERMINAL}#chat-card{display:none!important}</style></head>`);
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
      return harden(await options.fetch(req, server), url.host);
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
