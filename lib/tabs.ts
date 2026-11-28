// A project workspace of cmux has one page tab and one terminal tab per chat. This
// keeps them together: a pick in one pane selects the partner in the other pane.
// A page belongs to the terminal of its ?cmux= parameter, so nothing is stored.
// surface.focus and pane.focus switch the visible workspace, so they are not used:
// a tab that "moves" to its own place is selected, and only its pane gets the focus.
// For the projects with one workspace per chat it writes the list of the chats, which the
// page shows as a strip (lib/follow.ts), and it opens the chat that was picked there.
import { config } from "./config";
import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { CHATS_FILE, CLOSE_FILE, CODEX_DIR, MENUS_FILE, DATA_DIR, PICK_FILE, RENAME_FILE, validTitle, STATE_DIR, UUID, ensureStateDir, readStore, Refusal, refuse, run, writePrivate, type Chat, type Project } from "./common";
import { backgroundTerminals, claudeTerminals, waitingQuestions } from "./follow";

// The second form is the one-time link, until the page has followed it.
const PAGE = new RegExp(`^http://127\\.0\\.0\\.1:${Number(process.env.ORCA_CHAT_PORT || 47739)}/(?:[0-9a-f]{64}/follow|cmux-open)\\?cmux=([0-9a-f-]{36})(?:&until=\\d+&sig=[0-9a-f]{64})?$`, "i");
const SWEEP = 5_000; // names, terminals that are gone, and whether cmux is there

export type Rpc = (method: string, params: object) => Promise<any>;
export interface Tab { id: string; workspace: string; window: string; visible: boolean; pane: string; sibling?: string; index: number; type: string; title: string; selected: boolean; focused: boolean; name: string; url: boolean; chat?: string }

const low = (x: unknown) => String(x ?? "").toLowerCase();

function sibling(layout: any, pane: string): string | undefined {
  if (layout?.children?.length !== 2) return;
  const [a, b] = layout.children;
  if (low(a.pane?.id) === pane) return low(b.pane?.id);
  if (low(b.pane?.id) === pane) return low(a.pane?.id);
  return sibling(a, pane) || sibling(b, pane);
}

// The tabs of one workspace, or of all. The URL of a page holds the token: it stays in here.
export async function readTabs(rpc: Rpc, workspace?: string): Promise<Tab[]> {
  const tree = await rpc("system.tree", workspace ? { workspace_id: workspace } : { all_windows: true });
  const list = tree.windows.flatMap((window: any) => window.workspaces.map((w: any) => ({ ...w, window: low(window.id) }))).filter((w: any) => !workspace || low(w.id) === low(workspace));
  return list.flatMap((w: any) => w.panes.flatMap((p: any) => p.surfaces.map((s: any) => {
    const chat = s.type === "browser" ? low(PAGE.exec(s.url ?? "")?.[1]) : "";
    return { id: low(s.id), workspace: low(w.id), window: w.window, visible: w.selected === true, pane: low(p.id), sibling: sibling(w.layout, low(p.id)), index: s.index_in_pane, type: s.type, title: String(s.title ?? ""), selected: s.selected_in_pane === true, focused: s.focused === true, name: String(w.title ?? ""), url: Boolean(s.url), chat: UUID.test(chat) ? chat : undefined };
  })));
}

export const selectTab = (rpc: Rpc, t: Tab) => rpc("surface.move", { workspace_id: t.workspace, surface_id: t.id, pane_id: t.pane, index: t.index, focus: false });

export const folderOf = (group: any): string => String(group.idempotency_key ?? "").match(/^project:(\/.+)$/)?.[1] ?? "";

// The chat of a workspace. One with more than one chat has native tabs and is not for the strip.
// After a restart cmux loads a page when it is shown first: until then it has no URL.
function chatOf(tabs: Tab[], unread: Set<string>): Chat[] {
  const pages = tabs.filter((t) => t.chat || (t.type === "browser" && !t.url && t.title === "Chat")), terminals = tabs.filter((t) => t.type === "terminal");
  const t = pages.length === 1 && (pages[0].chat ? terminals.find((x) => x.id === pages[0].chat) : terminals.length === 1 && terminals[0]);
  if (!t) return [];
  const agent = /^(claude|codex)\b/i.exec(t.title)?.[1].toLowerCase() as Chat["agent"];
  return [{ workspace: t.workspace, terminal: t.id, title: t.name, agent, unread: unread.has(t.id) || unread.has(t.workspace) }];
}

// The chats of each project (a group of cmux), in the order of the group.
export async function readProjects(rpc: Rpc, all: Tab[]): Promise<Project[]> {
  const [{ groups }, { notifications }] = await Promise.all([rpc("workspace.group.list", {}), rpc("notification.list", {})]);
  const unread = new Set<string>(notifications.filter((n: any) => !n.is_read).map((n: any) => low(n.surface_id ?? n.workspace_id)));
  return groups.map((g: any) => ({ id: low(g.id), folder: folderOf(g), chats: g.member_workspace_ids.flatMap((id: string) => chatOf(all.filter((t) => t.workspace === low(id)), unread)) })).filter((p: Project) => p.chats.length);
}

function markedDescription(text: string, on: boolean | undefined): string {
  const marker = /^orca: background(?: (\d{4}-\d\d-\d\dT\d\d:\d\dZ))?$/;
  const parts = text ? text.split(" | ") : [];
  const old = parts.find(part => marker.test(part));
  if (on ?? (old !== undefined)) {
    const age = Date.now() - Date.parse(old?.match(marker)?.[1] ?? "");
    if (age >= 0 && age < 115_000) return text;
    const stamp = new Date().toISOString().slice(0, 16) + "Z";
    return ["orca: background " + stamp, ...parts.filter(part => !marker.test(part))].join(" | ");
  }
  return parts.filter(part => !marker.test(part)).join(" | ");
}

const NEW_CHAT = "Claude + chat";
export const command = () => config("cmux.json").commands.find((c: any) => c.name === NEW_CHAT);

// Scan complete rows backwards, keeping split UTF-8 characters together.
function claudeTitle(path: string): unknown {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size, chunk = 1 << 20, limit = Math.max(0, size - 8 * chunk);
    let end = size, rest = Buffer.alloc(0);
    while (end > limit) {
      const start = Math.max(limit, end - chunk), part = Buffer.alloc(end - start);
      if (readSync(fd, part, 0, part.length, start) !== part.length) return;
      const bytes = rest.length ? Buffer.concat([part, rest]) : part;
      let right = bytes.length;
      while (right > 0) {
        const newline = bytes.lastIndexOf(10, right - 1);
        if (newline < 0 && start > 0) break;
        const line = bytes.subarray(newline + 1, right);
        if (line.includes('"ai-title"')) {
          try {
            const row = JSON.parse(line.toString());
            if (row.type === "ai-title") return row.aiTitle;
          } catch {}
        }
        right = newline;
      }
      rest = bytes.subarray(0, Math.max(0, right));
      end = start;
    }
  } finally { closeSync(fd); }
}

function codexTitles() {
  const titles = new Map<string, unknown>();
  for (const line of readFileSync(join(CODEX_DIR, "session_index.jsonl"), "utf8").split("\n")) {
    try {
      const row = JSON.parse(line);
      titles.set(row.id, row.thread_name);
    } catch {}
  }
  return titles;
}

function shortTitle(name: unknown) {
  if (typeof name !== "string") return;
  const words = name.trim().replace(/(?:…|\.\.\.)$/, "").trim().split(/\s+/).slice(0, 6);
  while (words.join(" ").length > 48) words.pop();
  return words.join(" ");
}

// Stop the child if cmux takes too long.
export function connect() {
  const cli = process.env.CMUX_BUNDLED_CLI_PATH || Bun.which("cmux") || refuse("the cmux CLI is not on PATH");
  async function cmux(args: string[], input = ""): Promise<string> {
    const child = Bun.spawn([cli, ...args], { stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe" });
    const started = Date.now(), readers = [child.stdout.getReader(), child.stderr.getReader()];
    const output = readers.map(async reader => {
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return Buffer.concat(chunks).toString();
        chunks.push(value);
      }
    });
    let timer: Timer;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Refusal(`${args[1]} timed out after ${Date.now() - started} ms`));
        child.kill(9);
        for (const reader of readers) void reader.cancel().catch(() => {});
      }, 5_000);
    });
    try {
      const [[out, err], code] = await Promise.race([Promise.all([Promise.all(output), child.exited]), deadline]);
      return code === 0 ? out : refuse(err.trim().split("\n")[0] || "cmux does not answer");
    } finally { clearTimeout(timer!); }
  }
  const rpc: Rpc = async (method, params) => JSON.parse(await cmux(["rpc", method, "-"], JSON.stringify(params)));
  return { cli, cmux, rpc };
}

function pairFor(tabs: Tab[], surface: string) {
  const term = tabs.find(t => t.id === surface && t.type === "terminal" && UUID.test(t.workspace) && UUID.test(t.pane));
  const pages = tabs.filter(p => p.chat === surface && p.workspace === term?.workspace);
  if (term && pages.length === 1 && UUID.test(pages[0].pane)) return { term, page: pages[0] };
}

async function geometry(rpc: Rpc, term: Tab, page: Tab) {
  if (term.sibling !== page.pane) return;
  const list = await rpc("pane.list", { workspace_id: term.workspace });
  if (low(list.workspace_id) !== term.workspace) return;
  const frame = (t: Tab) => list.panes.find((p: any) => low(p.id) === t.pane && low(p.selected_surface_id) === t.id)?.pixel_frame;
  const t = frame(term), p = frame(page);
  if (![t, p].every(f => f && [f.x, f.y, f.width, f.height].every(Number.isFinite) && f.width > 0 && f.height > 0)) return;
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  if (near(t.x, p.x) && near(t.width, p.width) && near(t.y, p.y + p.height))
    return { size: t.height, total: t.height + p.height, grow: "up", undo: "down" };
  if (!near(t.y, p.y) || !near(t.height, p.height)) return;
  if (near(t.x, p.x + p.width)) return { size: t.width, total: t.width + p.width, grow: "left", undo: "right" };
  if (near(p.x, t.x + t.width)) return { size: t.width, total: t.width + p.width, grow: "right", undo: "left" };
}

// Claude puts these keyboard hints below its menus and permission prompts.
const MENU_HINT = /\besc (?:to )?(?:cancel|go back|close)\b|\benter(?:\/\u2193)? (?:to )?(?:select|confirm|approve)\b|\u2191\u2193 navigate\b/i;

// A fresh tree and pane list must still agree just before moving the divider.
export function questionWatcher(rpc: Rpc, log: (line: string) => void, cmux?: (args: string[]) => Promise<string>) {
  const states = new Map<string, { open: boolean; since: number; applied: boolean;
    grown?: { amount: number; size: number; total: number; grow: string; term: string; page: string; workspace: string } }>();
  const enabled = process.env.ORCA_CHAT_QUESTION_RESIZE !== "0";
  const picker = process.env.ORCA_CHAT_PICKER_RESIZE !== "0" && cmux;
  const menus = new Set<string>();
  const screens = new Map<string, { text?: string; changed: number; read: number }>();
  let written = "", claimKey = "", checked = -Infinity, live = new Set<string>();
  return async (tabs: Tab[]) => {
    if (!enabled && !picker) return;
    if (picker) {
      const visible = new Set(tabs.flatMap(t => t.visible && t.selected && t.chat && pairFor(tabs, t.chat)?.term.selected ? [t.chat] : []));
      const key = [...visible].sort().join(), now = performance.now();
      if (key !== claimKey || now - checked >= 1500) {
        live = claudeTerminals(visible);
        claimKey = key;
        checked = now;
      }
      for (const id of screens.keys()) if (!live.has(id)) screens.delete(id);
      for (const id of visible) if (!live.has(id)) menus.delete(id);
      await Promise.all([...live].map(async surface => {
        const state = screens.get(surface) ?? { changed: now, read: -Infinity };
        if (now - state.read < (now - state.changed >= 10_000 ? 1500 : 400)) return;
        screens.set(surface, state);
        try {
          const screen = await picker(["read-screen", "--surface", surface, "--lines", "20"]);
          if (state.text !== screen) { state.text = screen; state.changed = now; }
          const lines = screen.split("\n").map(line => line.trim()).filter(Boolean).slice(-12);
          // The normal input box (a "❯" line between two rules) means no menu, even when the
          // chat text just above it quotes a hint.
          const rule = (line?: string) => /^─{10,}$/.test(line ?? "");
          const box = lines.some((line, i) => line.startsWith("❯") && rule(lines[i - 1]) && lines.slice(i + 1).some(rule));
          if (!box && lines.slice(-3).some(line => MENU_HINT.test(line))) menus.add(surface);
          else menus.delete(surface);
        } catch { /* Keep the last screen state until cmux answers. */ }
        finally { state.read = performance.now(); }
      }));
    }
    const surfaces = new Set(tabs.flatMap(t => t.chat && pairFor(tabs, t.chat) ? [t.chat] : []));
    for (const surface of states.keys()) if (!surfaces.has(surface)) states.delete(surface);
    if (picker) {
      for (const id of menus) if (!surfaces.has(id)) menus.delete(id);
      const text = JSON.stringify({ pid: process.pid, terminals: [...menus].sort() });
      if (text !== written) { writePrivate(MENUS_FILE, text); written = text; }
    }
    if (!surfaces.size) return;
    const open = waitingQuestions(surfaces);
    const shouldGrow = (surface: string, questions: Set<string>) => questions.has(surface) ? enabled : menus.has(surface);
    for (const surface of surfaces) {
      const waiting = shouldGrow(surface, open);
      let state = states.get(surface);
      if (!state && !waiting) continue;
      if (!state) states.set(surface, state = { open: true, since: Date.now(), applied: false });
      if (state.open !== waiting) { state.open = waiting; state.since = Date.now(); }
      if (waiting === state.applied || Date.now() - state.since < 400) continue;
      state.applied = waiting;
      const saved = state.grown;
      state.grown = undefined;
      const pair = pairFor(await readTabs(rpc), surface);
      if (!pair) continue;
      const { term, page } = pair;
      const g = await geometry(rpc, term, page);
      if (!g || shouldGrow(surface, waitingQuestions(new Set([surface]), true)) !== waiting) continue;
      if (waiting) {
        const amount = Math.min(800, Math.round(g.total * 0.6 - g.size));
        if (amount < 1) continue;
        log("grow " + surface + " " + g.grow + " " + amount);
        await rpc("pane.resize", { workspace_id: term.workspace, pane_id: term.pane, direction: g.grow, amount });
        state.grown = { amount, size: g.size + amount, total: g.total, grow: g.grow, term: term.pane, page: page.pane, workspace: term.workspace };
      } else if (saved && saved.workspace === term.workspace && saved.term === term.pane && saved.page === page.pane &&
          saved.grow === g.grow && Math.abs(g.size - saved.size) <= 1 && Math.abs(g.total - saved.total) <= 1) {
        log("shrink " + surface + " " + g.undo + " " + saved.amount);
        await rpc("pane.resize", { workspace_id: term.workspace, pane_id: page.pane, direction: g.undo, amount: saved.amount });
      }
    }
  };
}

// Detached, with no terminal of its own in the environment: it lives as long as cmux.
// lockf ends at once when a watcher runs.
export function startTabs() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value && (/^(HOME|USER|PATH|TMPDIR|LANG|CLAUDE_CONFIG_DIR|CODEX_HOME)$/.test(key) || /^(ORCA_CHAT_|CMUX_SOCKET|CMUX_BUNDLED_CLI_PATH)/.test(key))) env[key] = value;
  ensureStateDir();
  const log = openSync(join(STATE_DIR, "tabs.log"), "a", 0o600);
  const child = spawn("/usr/bin/lockf", ["-k", "-s", "-t", "0", join(STATE_DIR, "tabs.lock"), join(DATA_DIR, "bun-1.3.14/package/bin/bun"), import.meta.path], { cwd: "/", env, detached: true, stdio: ["ignore", log, log] });
  child.on("error", () => {});
  child.unref();
}

if (import.meta.main) run(async () => {
  if (process.argv[2] === "start") return startTabs();
  process.umask(0o077);
  const { cli, cmux, rpc } = connect();
  let last = "";
  const log = (text: string) => {
    text = text.replace(/[0-9a-f]{64}/gi, "***");
    if (text !== last) console.error(`${new Date().toISOString()} ${process.pid} ${(last = text)}`);
  };

  const events = Bun.spawn([cli, "events", "--category", "surface", "--category", "workspace", "--category", "notification", "--reconnect", "--no-heartbeat"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  process.on("exit", () => events.kill(9));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
  const stop = (why: string): never => (log(`stop: ${why}`), process.exit(0));

  let boot = ""; // of this cmux. Another one has other terminals.
  const seen = new Set<string>(); // terminals that had a chat page
  const known = new Set<string>(); // pages
  const closeWithPage = process.env.ORCA_CHAT_CLOSE_WITH_PAGE !== "0";
  let previous: Tab[] = [];
  async function read(workspace?: string): Promise<Tab[]> {
    const all = await readTabs(rpc, workspace);
    if (closeWithPage) previous = workspace ? previous.filter(t => t.workspace !== workspace).concat(all) : all;
    for (const page of all.filter((t) => t.chat)) {
      known.add(page.id);
      if (all.some((t) => t.type === "terminal" && t.id === page.chat)) seen.add(page.chat!);
    }
    return all;
  }
  const pagesOf = (all: Tab[], workspace: string) => all.filter((t) => t.chat && t.workspace === workspace);

  const picks = new Map<string, string>(); // workspace: the last pick
  const moved = new Map<string, number>(); // workspace: when we changed something
  // Our own selections make events too. They are known by tab and time, so a pick of
  // the user in that moment still counts.
  const ours: { id: string; from: number; to: number }[] = [];
  async function select(t: Tab, mutate: Rpc) {
    const mine = { id: t.id, from: Date.now() - 5, to: Infinity };
    ours.push(mine);
    if (ours.length > 50) ours.shift();
    await selectTab(mutate, t).finally(() => (mine.to = Date.now() + 150));
  }

  async function pair(workspace: string, picked: string, mutate: Rpc) {
    const fresh = !known.has(picked), quiet = Date.now() - (moved.get(workspace) ?? 0) > 2_000;
    const all = await read(workspace), pages = pagesOf(all, workspace), hit = all.find((t) => t.id === picked);
    if (pages.length < 2 || !hit) return;
    const chatOf = (t: Tab) => pages.find((p) => p.chat === t.id);
    let terminal = hit.chat ? all.find((t) => t.type === "terminal" && t.id === hit.chat) : hit;
    // A page that is new was opened by its terminal, nobody picked it.
    if (hit.chat && fresh) terminal = all.find((t) => t.selected && t.pane === terminal?.pane && chatOf(t)) ?? terminal;
    const page = terminal && chatOf(terminal);
    if (!terminal || !page || terminal.pane === page.pane) return;
    moved.set(workspace, Date.now());
    if (page.id !== hit.id) {
      // A read is up to a second old, so it is only believed when nothing has moved.
      if (quiet && page.selected && terminal.id === hit.id) return;
      await select(page, mutate);
      if (picks.has(workspace)) return; // the user has picked another tab since
    }
    await select(terminal, mutate); // the page is read-only
  }

  // Closes the pages of terminals that are gone. A terminal can be out of the list for
  // a moment, for example when it moves, so two reads must agree, in the same cmux.
  const closingPages = new Set<string>();
  async function close(all: Tab[], mutate: Rpc) {
    const gone = (tabs: Tab[]) => tabs.filter((p) => p.chat && seen.has(p.chat) && tabs.some(t => t.workspace === p.workspace && !t.chat) && pagesOf(tabs, p.workspace).length > 1 && !tabs.some((t) => t.id === p.chat));
    const first = gone(all);
    if (!first.length) return;
    await Bun.sleep(300);
    if (JSON.parse(await cmux(["events", "--snapshot"])).boot_id !== boot) stop("another cmux");
    const again = await read();
    for (const page of gone(again).filter((p) => first.some((f) => f.id === p.id && f.chat === p.chat))) {
      const list = await rpc("surface.list", { workspace_id: page.workspace });
      if (low(list.workspace_id) !== page.workspace || list.surfaces.some((s: any) => low(s.id) === page.chat)) continue;
      // First the panes: cmux must not select a page for us.
      const stay = again.find((t) => t.workspace === page.workspace && t.type === "terminal" && t.selected && again.some((p) => p.chat === t.id));
      if (page.selected && stay) await pair(page.workspace, stay.id, mutate);
      if (closeWithPage) closingPages.add(page.id);
      await mutate("surface.close", { workspace_id: page.workspace, surface_id: page.id });
    }
  }

  type PendingClose = { page: Tab; since?: number };
  const closedPages = new Map<string, PendingClose>();
  function afterPageClose(id: string, workspace: string) {
    if (!closeWithPage || closingPages.delete(id) || !boot || closedPages.has(id)) return;
    const page = previous.find(t => t.id === id);
    if (!page?.chat || !seen.has(page.chat) || !UUID.test(page.workspace) || (workspace && workspace !== page.workspace)) return;
    const before = previous.filter(t => t.workspace === page.workspace);
    if (before.length === 2 && before.some(t => t.type === "terminal" && t.id === page.chat)) closedPages.set(id, { page });
  }

  function terminalAlone(tabs: Tab[], page: Tab) {
    const remaining = tabs.filter(t => t.workspace === page.workspace);
    return remaining.length === 1 && remaining[0].type === "terminal" && remaining[0].id === page.chat && !tabs.some(t => t.chat === page.chat);
  }

  async function confirmPageCloses(all: Tab[], pending: PendingClose[], mutate: Rpc) {
    for (const candidate of pending) {
      const { page, since } = candidate;
      if (!terminalAlone(all, page)) {
        closedPages.delete(page.id);
        continue;
      }
      if (since === undefined) {
        candidate.since = Date.now();
        setTimeout(relist, 1500);
        continue;
      }
      if (Date.now() - since < 1500) continue;
      closedPages.delete(page.id);
      if (JSON.parse(await cmux(["events", "--snapshot"])).boot_id !== boot) stop("another cmux");
      if (terminalAlone(await read(), page)) {
        await mutate("workspace.close", { workspace_id: page.workspace, force: true }); // the agent still runs, so cmux asks first
        log("closed chat workspace " + page.workspace + " after its page was closed");
      }
    }
  }

  // Only a full tree can show whether a followed terminal moved to another window.
  const waiting = new Map<string, number>();
  let confirmTimer: Timer | undefined;
  function leftovers(all: Tab[]) {
    const ids = new Set(all.map(t => t.id));
    const candidates = new Set(all.map(t => t.workspace).filter(id => UUID.test(id)));
    // Only a terminal this helper saw alive counts as closed: after a restart of cmux a page can
    // name a terminal id that cmux never gave out again, and its chat must stay.
    for (const t of all) if (!t.chat || ids.has(t.chat) || !seen.has(t.chat)) candidates.delete(t.workspace);
    return candidates;
  }
  async function closeWorkspaces(all: Tab[], mutate: Rpc) {
    if (!boot) return;
    const candidates = leftovers(all), now = Date.now();
    for (const id of waiting.keys()) if (!candidates.has(id)) waiting.delete(id);
    for (const id of candidates) {
      const since = waiting.get(id);
      if (since === undefined) waiting.set(id, now);
      else if (now - since >= 1500) {
        if (JSON.parse(await cmux(["events", "--snapshot"])).boot_id !== boot) stop("another cmux");
        if (leftovers(await read()).has(id)) {
          await mutate("workspace.close", { workspace_id: id });
          log("closed leftover chat workspace " + id);
        }
        waiting.delete(id);
      }
    }
    clearTimeout(confirmTimer);
    if (waiting.size) confirmTimer = setTimeout(relist, Math.max(0, Math.min(...waiting.values()) + 1500 - Date.now()));
  }

  // The tab of a terminal shows the title that the agent gives it. The page tab gets the same.
  // A page with another name than the one we gave it was renamed by the user: that name goes
  // to the terminal tab, where the agent cannot replace it.
  const named = new Map<string, { title: string; at: number }>();
  async function name(all: Tab[], mutate: Rpc) {
    for (const page of all.filter((t) => t.chat && pagesOf(all, t.workspace).length > 1)) {
      const terminal = all.find((t) => t.type === "terminal" && t.id === page.chat);
      let title = terminal?.title.trim().slice(0, 80);
      if (!terminal || !title) continue;
      const last = named.get(page.id), now = Date.now();
      if (title === page.title) {
        if (last?.title !== title) named.set(page.id, { title, at: now });
        continue;
      }
      // A read can be a second old, and a cleared name shows the title of the page itself.
      const byUser = last && page.title !== last.title && now - last.at > 3_000 && page.title.trim() && !/^(Chat(:|$)|https?:|127\.)/.test(page.title);
      if (byUser) title = page.title;
      named.set(page.id, { title, at: now });
      await mutate("surface.action", { action: "rename", workspace_id: page.workspace, surface_id: byUser ? terminal.id : page.id, title });
    }
  }

  let written = "";
  let questionTabs: Tab[] = [];
  const questions = questionWatcher(rpc, line => console.error(new Date().toISOString(), line), cmux);
  async function checkQuestions() {
    try { await questions(questionTabs); } catch (error: any) { log(error?.message ?? "Question check failed"); }
    setTimeout(checkQuestions, 400);
  }
  setTimeout(checkQuestions, 400);
  let cached: { at: number; all: Tab[]; projects: Project[] } | undefined;
  async function list(all: Tab[], at: number): Promise<Project[]> {
    questionTabs = all;
    const projects = await readProjects(rpc, all), text = JSON.stringify({ pid: process.pid, projects });
    if (text !== written) writePrivate(CHATS_FILE, text);
    cached = { at, all, projects };
    written = text;
    return projects;
  }

  async function markBackground(projects: Project[], all: Tab[], mutate: Rpc) {
    const chats = projects.filter(p => p.folder).flatMap(p => p.chats);
    const listed = new Map<string, any[]>();
    const byWorkspace = new Map(chats.map(c => [c.workspace, c.terminal]));
    const background = backgroundTerminals(new Set(byWorkspace.values()));
    const windows = new Set(all.map(t => t.window));
    for (const window_id of windows) {
      const list = async () => (await rpc("workspace.list", { window_id })).workspaces;
      const workspaces = await list();
      listed.set(window_id, workspaces);
      for (const w of workspaces) {
        const id = low(w.id), terminal = byWorkspace.get(id);
        const on = terminal ? background.get(terminal) : false;
        if (markedDescription(w.description ?? "", on) === (w.description ?? "")) continue;
        // The sidebar can save a newer age while this sweep is running.
        const current = (await list()).find((row: any) => low(row.id) === id);
        if (!current) continue;
        const text = current.description ?? "", description = markedDescription(text, on);
        if (description === text) continue;
        await mutate("workspace.action", { action: "set_description", workspace_id: id, description });
        log("background " + (on !== false ? "on " : "off ") + id);
      }
    }
    return listed;
  }

  const titleAttempts = new Map<string, number>();
  let lastWindow = "";
  async function nameWorkspaces(projects: Project[], all: Tab[], mutate: Rpc, listed: Map<string, any[]>) {
    const now = Date.now();
    for (const [id, at] of titleAttempts) if (now - at >= 300_000) titleAttempts.delete(id);
    const chats = projects.flatMap(p => p.chats).filter(c => /^(Claude|Codex) \+ chat$/.test(c.title) && !titleAttempts.has(c.workspace));
    if (!chats.length) return;
    // workspace.list covers one window. Give each window a turn.
    const ids = new Set(chats.map(c => c.workspace));
    const windows = [...new Set(all.filter(t => ids.has(t.workspace)).map(t => t.window))].sort();
    lastWindow = windows.find(id => id > lastWindow) ?? windows[0];
    const workspaces = listed.get(lastWindow) ?? (await rpc("workspace.list", { window_id: lastWindow })).workspaces;
    let index: ReturnType<typeof codexTitles> | undefined;
    for (const w of workspaces) {
      const chat = chats.find(c => c.workspace === low(w.id));
      if (!chat || w.title !== chat.title || !(Date.parse(w.latest_submitted_at) <= now - 60_000)) continue;
      titleAttempts.set(chat.workspace, Date.now());
      const agent = chat.title === NEW_CHAT ? "claude" : "codex";
      let title: unknown;
      try {
        const store = readStore(agent), id = store.activeSessionsBySurface[chat.terminal]?.sessionId;
        if (!id || !store.sessions[id]?.transcriptPath) continue;
        title = agent === "claude" ? claudeTitle(store.sessions[id].transcriptPath) : shortTitle((index ??= codexTitles()).get(id));
      } catch { continue; }
      if (!validTitle(title)) continue;
      await mutate("workspace.rename", { workspace_id: chat.workspace, title });
      log(`named chat workspace ${chat.workspace} from its ${agent} session title`);
    }
  }

  // A pick in the strip. The click gave the focus to the page, and typing must go to the
  // terminal when the user comes back, so that pane gets it first.
  async function open({ from, to }: { from: string; to: string }, mutate: Rpc) {
    if (to === from) {
      const pair = pairFor(await read(), from);
      if (!pair) return "skipped: no paired terminal";
      await selectTab(mutate, pair.term);
      return "focus";
    }
    const resolve = (all: Tab[], projects: Project[]) => {
      const project = projects.find(p => p.chats.some(c => c.terminal === from));
      const chat = project?.chats.find(c => c.terminal === to);
      const term = (id: string) => all.find(t => t.id === id && t.type === "terminal");
      return { project, source: term(from), target: chat && term(chat.terminal) };
    };
    const at = Date.now();
    let pick = cached && at - cached.at < 2_000 ? resolve(cached.all, cached.projects) : undefined;
    if (!pick?.source || !pick.project || !(pick.target || (to === "new" && pick.project.folder))) {
      const all = await read();
      pick = resolve(all, await list(all, at));
    }
    const { project, source, target } = pick;
    if (!project || !source || !(target || (to === "new" && project.folder))) return "skipped: no matching project chat";
    await selectTab(mutate, source);
    if (target) await selectTab(mutate, target);
    const workspace_id = target?.workspace ?? (await mutate("workspace.create", { title: NEW_CHAT, title_source: "auto", cwd: project.folder, layout: command().workspace.layout, group_id: project.id, group_placement: "end", focus: false })).workspace_id;
    await mutate("workspace.select", { workspace_id });
    return "selected";
  }
  let closeAt = Date.now(), tabClose: { workspace: string; terminal: string } | undefined;
  setInterval(() => {
    let request;
    try { request = JSON.parse(readFileSync(CLOSE_FILE, "utf8")); } catch { return; }
    if (!request || !(request.at > closeAt) || !UUID.test(request.workspace) || !UUID.test(request.terminal)) return;
    closeAt = request.at;
    tabClose = request;
    work();
  }, 100);

  let asked = Date.now(), wish: { from: string; to: string; at: number } | undefined;
  setInterval(() => {
    let now: typeof wish;
    try { now = JSON.parse(readFileSync(PICK_FILE, "utf8")); } catch { return; }
    if (!now || !(now.at > asked)) return;
    (asked = now.at), (wish = now);
    work();
  }, 100);

  let renameAt = Date.now(), rename: { workspace: string; title: string } | undefined;
  setInterval(() => {
    let request;
    try { request = JSON.parse(readFileSync(RENAME_FILE, "utf8")); } catch { return; }
    if (!request || !(request.at > renameAt) || !UUID.test(request.workspace) || !validTitle(request.title)) return;
    renameAt = request.at;
    rename = request;
    work();
  }, 100);

  // Handle strip actions before the next sweep.
  let busy = false, due = true, stale = false, fails = 0, silentSince = 0;
  // A step that never ends would keep every later pick waiting, so a watchdog frees the loop.
  let round = 0, step = "", stepAt = 0;
  setInterval(() => {
    if (!busy || Date.now() - stepAt < 15_000) return;
    log(`stuck for ${Math.round((Date.now() - stepAt) / 1000)} s in ${step}, starting again`);
    round++;
    busy = false;
    work();
  }, 5_000);
  async function work() {
    if (busy) return;
    busy = true;
    const mine = ++round;
    const mutate: Rpc = async (method, params) => {
      if (round !== mine) return refuse("watchdog replaced this round");
      return rpc(method, params);
    };
    while (round === mine && (tabClose || wish || rename || picks.size || stale || due)) {
      step = tabClose ? "close" : rename ? "rename" : wish ? "pick" : picks.size ? "pair" : "sweep";
      const started = stepAt = Date.now();
      if (tabClose) {
        const { workspace, terminal } = tabClose;
        tabClose = undefined;
        try {
          const all = await read(), projects = await list(all, started);
          if (projects.some(p => p.chats.some(c => c.workspace === workspace && c.terminal === terminal))) {
            const page = all.find(t => t.workspace === workspace && t.chat === terminal);
            const members = all.filter(t => t.workspace === workspace);
            // Only the page paired with this terminal: a guess could close another browser tab.
            const chatPage = page;
            if (!chatPage) continue;
            if (closeWithPage) closingPages.add(chatPage.id);
            try {
              if (members.length === 2) {
                await mutate("workspace.close", { workspace_id: workspace, force: true });
                log("closed chat workspace " + workspace + " from its tab");
              } else {
                await mutate("surface.close", { workspace_id: workspace, surface_id: chatPage.id });
                await mutate("surface.close", { workspace_id: workspace, surface_id: terminal, force: true });
                log("closed chat surfaces in workspace " + workspace + " from its tab");
              }
            } catch (err) {
              closingPages.delete(chatPage.id);
              throw err;
            }
            stale = true;
          }
        } catch (err: any) { log(err?.message ?? String(err)); }
        continue;
      }
      if (rename) {
        const { workspace, title } = rename;
        rename = undefined;
        try {
          const projects = await list(await read(), started);
          if (projects.some(p => p.chats.some(c => c.workspace === workspace))) {
            // cmux workspace.rename uses setCustomTitle with its default user source.
            await mutate("workspace.rename", { workspace_id: workspace, title });
            stale = true;
          }
        } catch (err: any) { log(err?.message ?? String(err)); }
        continue;
      }
      const strip = wish;
      wish = undefined;
      if (!strip) await Bun.sleep(40); // a new tab is selected for a moment
      const pick = strip ? undefined : [...picks][0], only = !strip && !pick && stale;
      if (pick) picks.delete(pick[0]);
      else if (only) stale = false;
      else if (!strip) due = false;
      try {
        if (strip) {
          // Each pick from the strip leaves one line, so a click that does nothing can be traced.
          const t0 = Date.now(), waited = t0 - strip.at, how = await open(strip, mutate);
          if (how !== "focus" || Date.now() - t0 > 500) log(`pick ${strip.from.slice(0, 8)} -> ${strip.to.slice(0, 8)}: ${how}, waited ${waited} ms, took ${Date.now() - t0} ms`);
        }
        else if (pick) await pair(...pick, mutate);
        else {
          const pending = [...closedPages.values()];
          const all = await read();
          fails = 0; silentSince = 0;
          const projects = await list(all, started);
          let listed = new Map<string, any[]>();
          if (!only) {
            try { listed = await markBackground(projects, all, mutate); }
            catch (err: any) { log(err?.message ?? String(err)); }
          }
          await confirmPageCloses(all, pending, mutate);
          await closeWorkspaces(all, mutate);
          if (!only) {
            await name(all, mutate);
            if (boot) await close(all, mutate);
            await nameWorkspaces(projects, all, mutate, listed);
          }
        }
      } catch (err: any) {
        log(err?.message ?? String(err));
        // A busy cmux can miss answers for a while. A stop hides the strip of every page until
        // the next start, so it waits for 2 minutes without any answer.
        if (!strip && !pick && !only && ++fails >= 3) {
          silentSince ||= Date.now();
          if (Date.now() - silentSince > 120_000) stop("cmux does not answer");
          log("cmux is slow, trying again on the next sweep");
        }
      }
    }
    if (round === mine) busy = false;
  }
  const sweep = () => ((due = true), work());
  setInterval(sweep, SWEEP);

  // The list follows the events. A read can be a second old, so it is read two times.
  const LISTED = /^(surface\.(created|closed|action|moved|selected)|workspace\.(created|closed|renamed|action|reordered|selected)|notification\.)/;
  let soon: Timer | undefined, later: Timer | undefined;
  const relist = () => ((stale = true), work());
  function changed() {
    soon ??= setTimeout(() => ((soon = undefined), relist()), 120);
    clearTimeout(later);
    later = setTimeout(relist, 1_200);
  }

  let rest = "";
  const decoder = new TextDecoder();
  log("start");
  try { boot = JSON.parse(await cmux(["events", "--snapshot"])).boot_id || ""; }
  catch (err: any) { log(err?.message ?? String(err)); }
  if (boot) sweep();
  for await (const chunk of events.stdout) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop()!;
    for (const line of lines) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.boot_id && boot && e.boot_id !== boot) stop("another cmux");
      if (e.boot_id && !boot) (boot = e.boot_id), sweep();
      const id = low(e.surface_id), at = Date.parse(e.occurred_at);
      if (e.name === "surface.closed" && e.payload?.kind === "browser") afterPageClose(id, low(e.workspace_id));
      if (e.name === "surface.closed" && seen.has(id)) sweep();
      if (LISTED.test(e.name)) changed();
      if (e.name !== "surface.selected" || !UUID.test(e.workspace_id ?? "") || ours.some((o) => o.id === id && at >= o.from && at <= o.to)) continue;
      picks.delete(low(e.workspace_id));
      picks.set(low(e.workspace_id), id);
      work();
    }
  }
  stop("cmux has closed the event stream");
});
