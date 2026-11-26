// Shows the chat of this cmux terminal in the browser pane of its own workspace.
// It navigates one exact surface or none. With --new it replaces that surface with
// one that has no address bar, see bare(). --project is --new for a workspace with many
// chats, --tab adds a chat to it, see tab() and lib/tabs.ts. cmux gets the
// parameters on stdin and a one-time link, so the token is in no argv and not in
// the cmux event log.
import { basename, dirname, join } from "node:path";
import { folderOf, readTabs, selectTab, startTabs, type Rpc } from "./tabs";
import { STATE_DIR, UUID, ensureStateDir, refuse, run, signLink } from "./common";

const DEADLINE = 15_000; // claude waits for this command
let child: any;

async function call(cmd: string[], input = ""): Promise<string> {
  child = Bun.spawn(cmd, { stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return (await child.exited) === 0 ? out.trim() : refuse(err.trim().split("\n")[0].replace(/^orca-chat: /, "") || "a command failed");
}

run(async () => {
  process.umask(0o077);
  const { CMUX_WORKSPACE_ID: workspace = "", CMUX_SURFACE_ID: surface = "" } = process.env;
  if (!UUID.test(workspace) || !UUID.test(surface)) refuse("this is not a cmux terminal");
  const cli = process.env.CMUX_BUNDLED_CLI_PATH || Bun.which("cmux") || refuse("the cmux CLI is not on PATH");
  const late = setTimeout(() => {
    child?.kill(9);
    console.error("orca-chat: no answer in 15 seconds");
    process.exit(1);
  }, DEADLINE);
  const rpc: Rpc = async (method, params) => JSON.parse(await call([cli, "rpc", method, "-"], JSON.stringify(params)));
  const has = (flag: string) => process.argv.includes(flag);
  // A name that a person gives is never replaced by the auto-naming of cmux.
  if (has("--project")) await git().catch(() => process.cwd()).then((dir) => rpc("workspace.rename", { workspace_id: workspace, title: basename(dir) })).catch(() => {});
  const list = await rpc("surface.list", { workspace_id: workspace });
  if (String(list.workspace_id).toLowerCase() !== workspace.toLowerCase()) refuse("cmux answered for another workspace");
  const browsers = list.surfaces.filter((s: any) => s.type === "browser" && !s.dock_scope);
  if (has("--tab")) (await readTabs(rpc, workspace)).some((t) => t.chat) || refuse("no chat page in this workspace, so no tab was added");
  else if (browsers.length !== 1) refuse(`${browsers.length} browser tabs in this workspace, the chat needs exactly one, so none was changed`);
  ensureStateDir();
  const base = new URL(await call(["/usr/bin/lockf", "-k", "-t", "10", join(STATE_DIR, "lock"), process.execPath, join(import.meta.dir, "chat.ts"), "cmux"]));
  let until = Date.now() + 60_000;
  const url = () => {
    const at = String(until++); // a link works once
    return `${base.origin}/cmux-open?cmux=${surface}&until=${at}&sig=${signLink(base.pathname.slice(1), surface, at)}`;
  };
  if (has("--tab")) {
    await tab(rpc, workspace, surface.toLowerCase(), url);
    startTabs();
    return clearTimeout(late);
  }
  const terminal = list.surfaces.find((s: any) => s.type === "terminal" && String(s.id).toLowerCase() === surface.toLowerCase());
  if (!(has("--new") || has("--project")) || !terminal || !(await bare(rpc, workspace, browsers[0], terminal, url())))
    await rpc("browser.navigate", { workspace_id: workspace, surface_id: browsers[0].id, url: url() });
  clearTimeout(late);
  startTabs();
  // The command palette puts a new workspace outside its project group. The chat is
  // open now, so a group that fails or hangs is not an error: claude starts in 3 s.
  setTimeout(() => (child?.kill(9), process.exit(0)), 3_000).unref();
  await group(rpc, workspace).catch(() => {});
});

// cmux 0.65 has no way to hide the address bar of a page that is open, or of a page
// in a layout. So: a page without it, in a split that is there for a moment, moves
// to the pane of the old page. A move gives its pane the focus, so the terminal
// "moves" to its own pane. The old page closes last. False: nothing has changed.
async function bare(rpc: Rpc, workspace: string, old: any, terminal: any, url: string): Promise<boolean> {
  if (!UUID.test(old.pane_id) || !UUID.test(terminal.pane_id) || old.pane_id === terminal.pane_id) return false;
  let made = "";
  try {
    made = String((await rpc("browser.open_split", { workspace_id: workspace, surface_id: old.id, url, focus: false, show_omnibar: false })).surface_id);
    if (!UUID.test(made)) return false;
    await rpc("surface.move", { workspace_id: workspace, surface_id: made, pane_id: old.pane_id, focus: false });
  } catch {
    if (UUID.test(made)) await rpc("surface.close", { workspace_id: workspace, surface_id: made }).catch(() => {});
    return false;
  }
  await rpc("surface.move", { workspace_id: workspace, surface_id: terminal.id, pane_id: terminal.pane_id, focus: false }).catch(() => {});
  await rpc("surface.close", { workspace_id: workspace, surface_id: old.id }).catch(() => {});
  return true;
}

// Adds the page of this terminal to the pane of the chat pages, as bare() does. The
// terminal keeps the focus when its tab is still the selected one.
async function tab(rpc: Rpc, workspace: string, surface: string, url: () => string) {
  let all = await readTabs(rpc, workspace);
  const me = () => all.find((t) => t.id === surface) ?? refuse("this terminal is not in its workspace");
  const pages = all.filter((t) => t.chat), old = pages[0] ?? refuse("no chat page in this workspace, so no tab was added");
  const chats = all.filter((t) => t.type === "terminal" && pages.some((p) => p.chat === t.id));
  // The new tab is in the top pane when the pages had the focus.
  const below = me().pane === old.pane && (chats.find((t) => t.pane !== old.pane) ?? refuse("no terminal pane in this workspace"));
  const mine = pages.find((p) => p.chat === surface);
  if (mine) await rpc("browser.navigate", { workspace_id: workspace, surface_id: mine.id, url: url() });
  else {
    const made = String((await rpc("browser.open_split", { workspace_id: workspace, surface_id: old.id, url: url(), focus: false, show_omnibar: false })).surface_id);
    if (!UUID.test(made)) refuse("cmux has made no page");
    try {
      await rpc("surface.move", { workspace_id: workspace, surface_id: made, pane_id: old.pane, focus: false });
    } catch (err) {
      await rpc("surface.close", { workspace_id: workspace, surface_id: made }).catch(() => {});
      throw err;
    }
  }
  if (below) return rpc("surface.move", { workspace_id: workspace, surface_id: surface, pane_id: below.pane, focus: false });
  all = await readTabs(rpc, workspace);
  const on = me().selected ? me() : all.find((t) => t.selected && t.pane === me().pane);
  const page = on?.id === surface ? mine : all.find((t) => t.chat && t.chat === on?.id);
  if (page) await selectTab(rpc, page);
  if (on) await selectTab(rpc, on);
}

// The folder of the project, also in a git worktree, which can be outside of it.
const git = async () => dirname(await call(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]));

async function group(rpc: Rpc, workspace: string) {
  const groups: any[] = (await rpc("workspace.group.list", {})).groups;
  if (groups.some((g) => g.member_workspace_ids?.some((id: string) => id.toLowerCase() === workspace.toLowerCase()))) return;
  const find = (dir: string) => {
    const hits = groups.filter((g) => folderOf(g) && (dir === folderOf(g) || dir.startsWith(folderOf(g) + "/"))).sort((a, b) => folderOf(b).length - folderOf(a).length);
    return hits[1] && folderOf(hits[0]) === folderOf(hits[1]) ? undefined : hits[0];
  };
  const hit = find(process.cwd()) ?? find(await git());
  if (hit) await rpc("workspace.group.add", { group_id: hit.id, workspace_id: workspace });
}
