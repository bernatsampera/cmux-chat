// A project workspace of cmux has one page tab and one terminal tab per chat. This
// keeps them together: a pick in one pane selects the partner in the other pane.
// A page belongs to the terminal of its ?cmux= parameter, so nothing is stored.
// surface.focus and pane.focus switch the visible workspace, so they are not used:
// a tab that "moves" to its own place is selected, and only its pane gets the focus.
// For the projects with one workspace per chat it writes the list of the chats, which the
// page shows as a strip (lib/follow.ts), and it opens the chat that was picked there.
import { config } from "./config";
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHATS_FILE, PICK_FILE, STATE_DIR, UUID, ensureStateDir, refuse, run, writePrivate, type Chat, type Project } from "./common";

// The second form is the one-time link, until the page has followed it.
const PAGE = new RegExp(`^http://127\\.0\\.0\\.1:${Number(process.env.ORCA_CHAT_PORT || 47739)}/(?:[0-9a-f]{64}/follow|cmux-open)\\?cmux=([0-9a-f-]{36})(?:&until=\\d+&sig=[0-9a-f]{64})?$`, "i");
const SWEEP = 5_000; // names, terminals that are gone, and whether cmux is there

export type Rpc = (method: string, params: object) => Promise<any>;
export interface Tab { id: string; workspace: string; pane: string; index: number; type: string; title: string; selected: boolean; focused: boolean; name: string; url: boolean; chat?: string }

const low = (x: unknown) => String(x ?? "").toLowerCase();

// The tabs of one workspace, or of all. The URL of a page holds the token: it stays in here.
export async function readTabs(rpc: Rpc, workspace?: string): Promise<Tab[]> {
  const tree = await rpc("system.tree", workspace ? { workspace_id: workspace } : { all_windows: true });
  const list = tree.windows.flatMap((w: any) => w.workspaces).filter((w: any) => !workspace || low(w.id) === low(workspace));
  return list.flatMap((w: any) => w.panes.flatMap((p: any) => p.surfaces.map((s: any) => {
    const chat = s.type === "browser" ? low(PAGE.exec(s.url ?? "")?.[1]) : "";
    return { id: low(s.id), workspace: low(w.id), pane: low(p.id), index: s.index_in_pane, type: s.type, title: String(s.title ?? ""), selected: s.selected_in_pane === true, focused: s.focused === true, name: String(w.title ?? ""), url: Boolean(s.url), chat: UUID.test(chat) ? chat : undefined };
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

const NEW_CHAT = "Claude + chat";
export const command = () => config("cmux.json").commands.find((c: any) => c.name === NEW_CHAT);

// Async with a hard kill, as orca() in common.ts.
export function connect() {
  const cli = process.env.CMUX_BUNDLED_CLI_PATH || Bun.which("cmux") || refuse("the cmux CLI is not on PATH");
  async function cmux(args: string[], input = ""): Promise<string> {
    const child = Bun.spawn([cli, ...args], { stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(9), 5_000);
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    return code === 0 ? out : refuse(err.trim().split("\n")[0] || "cmux does not answer");
  }
  const rpc: Rpc = async (method, params) => JSON.parse(await cmux(["rpc", method, "-"], JSON.stringify(params)));
  return { cli, cmux, rpc };
}

// Detached, with no terminal of its own in the environment: it lives as long as cmux.
// lockf ends at once when a watcher runs.
export function startTabs() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value && (/^(HOME|USER|PATH|TMPDIR|LANG)$/.test(key) || /^(ORCA_CHAT_|CMUX_SOCKET|CMUX_BUNDLED_CLI_PATH)/.test(key))) env[key] = value;
  ensureStateDir();
  const log = openSync(join(STATE_DIR, "tabs.log"), "a", 0o600);
  const child = spawn("/usr/bin/lockf", ["-k", "-s", "-t", "0", join(STATE_DIR, "tabs.lock"), process.execPath, import.meta.path], { cwd: "/", env, detached: true, stdio: ["ignore", log, log] });
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
  async function read(workspace?: string): Promise<Tab[]> {
    const all = await readTabs(rpc, workspace);
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
  async function select(t: Tab) {
    const mine = { id: t.id, from: Date.now() - 5, to: Infinity };
    ours.push(mine);
    if (ours.length > 50) ours.shift();
    await selectTab(rpc, t).finally(() => (mine.to = Date.now() + 150));
  }

  async function pair(workspace: string, picked: string) {
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
      await select(page);
      if (picks.has(workspace)) return; // the user has picked another tab since
    }
    await select(terminal); // the page is read-only
  }

  // Closes the pages of terminals that are gone. A terminal can be out of the list for
  // a moment, for example when it moves, so two reads must agree, in the same cmux.
  async function close(all: Tab[]) {
    const gone = (tabs: Tab[]) => tabs.filter((p) => p.chat && seen.has(p.chat) && pagesOf(tabs, p.workspace).length > 1 && !tabs.some((t) => t.id === p.chat));
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
      if (page.selected && stay) await pair(page.workspace, stay.id);
      await rpc("surface.close", { workspace_id: page.workspace, surface_id: page.id });
    }
  }

  // The tab of a terminal shows the title that the agent gives it. The page tab gets the same.
  // A page with another name than the one we gave it was renamed by the user: that name goes
  // to the terminal tab, where the agent cannot replace it.
  const named = new Map<string, { title: string; at: number }>();
  async function name(all: Tab[]) {
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
      await rpc("surface.action", { action: "rename", workspace_id: page.workspace, surface_id: byUser ? terminal.id : page.id, title });
    }
  }

  let written = "";
  async function list(all: Tab[]): Promise<Project[]> {
    const projects = await readProjects(rpc, all), text = JSON.stringify({ pid: process.pid, projects });
    if (text !== written) writePrivate(CHATS_FILE, text);
    written = text;
    return projects;
  }

  // A pick in the strip. The click gave the focus to the page, and typing must go to the
  // terminal when the user comes back, so that pane gets it first.
  async function open({ from, to }: { from: string; to: string }) {
    const all = await read(), project = (await list(all)).find((p) => p.chats.some((c) => c.terminal === from));
    const chat = project?.chats.find((c) => c.terminal === to);
    if (!project || !(chat || (to === "new" && project.folder))) return;
    const focus = async (terminal: string) => {
      const pane = all.find((t) => t.id === terminal)?.pane, shown = all.find((t) => t.pane === pane && t.selected);
      if (shown) await selectTab(rpc, shown);
    };
    await focus(from);
    if (to === from) return;
    if (chat) await focus(to);
    const workspace_id = chat?.workspace ?? (await rpc("workspace.create", { title: NEW_CHAT, title_source: "auto", cwd: project.folder, layout: command().workspace.layout, group_id: project.id, group_placement: "end", focus: false })).workspace_id;
    await rpc("workspace.select", { workspace_id });
  }
  let asked = Date.now(), wish: { from: string; to: string; at: number } | undefined;
  setInterval(() => {
    let now: typeof wish;
    try { now = JSON.parse(readFileSync(PICK_FILE, "utf8")); } catch { return; }
    if (!now || !(now.at > asked)) return;
    (asked = now.at), (wish = now);
    work();
  }, 100);

  // One thing at a time: picks first, then the list, then the sweep.
  let busy = false, due = true, stale = false, fails = 0;
  async function work() {
    if (busy) return;
    busy = true;
    while (wish || picks.size || stale || due) {
      const strip = wish;
      wish = undefined;
      if (!strip) await Bun.sleep(40); // a new tab is selected for a moment
      const pick = strip ? undefined : [...picks][0], only = !strip && !pick && stale;
      if (pick) picks.delete(pick[0]);
      else if (only) stale = false;
      else if (!strip) due = false;
      try {
        if (strip) await open(strip);
        else if (pick) await pair(...pick);
        else if (only) await list(await read());
        else {
          const all = await read();
          fails = 0;
          await list(all);
          await name(all);
          if (boot) await close(all);
        }
      } catch (err: any) {
        log(err?.message ?? String(err));
        if (!strip && !pick && !only && ++fails >= 3) stop("cmux does not answer");
      }
    }
    busy = false;
  }
  const sweep = () => ((due = true), work());
  setInterval(sweep, SWEEP);

  // The list follows the events. A read can be a second old, so it is read two times.
  const LISTED = /^(surface\.(created|closed|action|moved)|workspace\.(created|closed|renamed|action|reordered)|notification\.)/;
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
  for await (const chunk of events.stdout) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop()!;
    for (const line of lines) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.boot_id && boot && e.boot_id !== boot) stop("another cmux");
      if (e.boot_id && !boot) (boot = e.boot_id), sweep();
      const id = low(e.surface_id), at = Date.parse(e.occurred_at);
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
