// cmux/to-workspaces: gives each chat of a merged project workspace a workspace of its own,
// in the same group and order. A surface that moves keeps its process and its page. The chat
// that is open, or selected, is not moved: it keeps the workspace. Nothing is closed but the
// placeholder of a new workspace, by its id, after the move is seen.
import { basename, join } from "node:path";
import { STATE_DIR, ensureStateDir, refuse, run, writePrivate } from "./common";
import { command, connect, folderOf, readTabs, selectTab, type Tab } from "./tabs";

const low = (x: unknown) => String(x ?? "").toLowerCase();
// Names that nobody gave: the agent, a folder, a command.
const GENERIC = /^$|^(claude|codex)( code)?$|^terminal$|^chat$|^[~/…]/i;

run(async () => {
  process.umask(0o077);
  const args = process.argv.slice(2), dry = args.includes("--dry-run"), [want, ...more] = args.filter((a) => a !== "--dry-run");
  if (more.length || want?.startsWith("-")) refuse("use: to-workspaces [--dry-run] [project]");
  const { rpc } = connect(), { layout } = command().workspace;
  const groups = (await rpc("workspace.group.list", {})).groups.filter((g: any) => !want || [g.name, basename(g.name), folderOf(g)].some((x) => low(x) === low(want)));
  if (want && groups.length !== 1) refuse(`${groups.length} projects are called ${want}`);
  const all = await readTabs(rpc);
  const chatsOf = (tabs: Tab[]) => tabs.filter((p) => p.chat && tabs.some((t) => t.id === p.chat));
  const merged = groups.flatMap((g: any) => g.member_workspace_ids.map((id: string) => ({ g, id: low(id), tabs: all.filter((t) => t.workspace === low(id)) }))).filter((w: any) => chatsOf(w.tabs).length > 1);
  if (!merged.length) return console.log("no workspace has more than one chat");
  if (!dry) {
    ensureStateDir();
    const file = join(STATE_DIR, `layout-before-workspaces.${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.json`);
    writePrivate(file, JSON.stringify({ groups, tabs: all }, null, 1));
    console.log(`the layout before: ${file}`);
  }

  // Makes a workspace after another one, moves these surfaces to its panes (top to bottom), then closes its placeholders.
  async function move(g: any, after: string, parts: Tab[], title: string, auto: boolean): Promise<string> {
    const hold = (i: number) => ({ pane: { surfaces: [{ ...layout.children[0].pane.surfaces[0], name: `placeholder ${i}` }] } });
    const made = low((await rpc("workspace.create", { title, title_source: auto ? "auto" : "user", cwd: folderOf(g) || undefined, layout: parts.length === 2 ? { ...layout, children: [hold(0), hold(1)] } : hold(0), group_id: g.id, group_placement: "afterCurrent", group_reference_workspace_id: after, focus: false })).workspace_id);
    const look = async (ok: (tabs: Tab[]) => boolean) => {
      for (let i = 0; i < 30; i++, await Bun.sleep(150)) {
        const tabs = await readTabs(rpc, made);
        if (ok(tabs)) return tabs;
      }
      return refuse(`"${title}" is not complete in the new workspace ${made}, so nothing was closed there. Look at it before you run this again`);
    };
    const holds = (tabs: Tab[]) => parts.map((_, i) => tabs.find((t) => t.title === `placeholder ${i}`)!);
    const held = holds(await look((tabs) => tabs.length === parts.length && holds(tabs).every(Boolean)));
    for (const [i, t] of parts.entries()) await rpc("surface.move", { surface_id: t.id, workspace_id: made, pane_id: held[i].pane, focus: false });
    await look((tabs) => parts.every((p, i) => tabs.some((t) => t.id === p.id && t.pane === held[i].pane)));
    for (const h of held) await rpc("surface.close", { workspace_id: made, surface_id: h.id });
    const done = await look((tabs) => tabs.length === parts.length);
    await selectTab(rpc, done.find((t) => t.id === parts.at(-1)!.id)!); // typing goes to the terminal
    return made;
  }

  const open = low((await rpc("system.identify", {})).focused?.workspace_id);
  // The workspace that the user sees is last.
  for (const { g, id, tabs } of merged.sort((a: any, b: any) => Number(a.id === open) - Number(b.id === open))) {
    const pages = chatsOf(tabs), terminal = (p: Tab) => tabs.find((t: Tab) => t.id === p.chat)!;
    const stay = pages.find((p) => terminal(p).selected) ?? pages.find((p) => p.selected) ?? pages[0];
    const title = (p: Tab) => [terminal(p).title, p.title].map((x) => x.trim()).find((x) => !GENERIC.test(x)) ?? "";
    const say = (text: string) => console.log(`${dry ? "would: " : ""}${g.name}: ${text}`);
    let after = id, before = "";
    for (const p of pages) {
      const name = title(p) || command().name;
      if (p === stay) {
        before = after;
        continue;
      }
      if (!dry) after = await move(g, after, [p, terminal(p)], name, !title(p));
      say(`"${name}" gets a workspace${dry ? "" : " " + after.slice(0, 8)}`);
    }
    // Files and terminals with no chat. A page whose terminal is gone stays.
    for (const t of tabs.filter((t: Tab) => !t.chat && !pages.some((p) => p.chat === t.id))) {
      if (!dry) after = await move(g, after, [t], t.title || "Terminal", GENERIC.test(t.title));
      say(`"${t.title}" (${t.type}, no chat) gets a workspace${dry ? "" : " " + after.slice(0, 8)}`);
    }
    say(`"${title(stay) || command().name}" keeps the workspace ${id.slice(0, 8)}`);
    if (dry) continue;
    if (before !== id && low(g.anchor_workspace_id) !== id) await rpc("workspace.reorder", { workspace_id: id, after_workspace_id: before });
    if (title(stay)) await rpc("workspace.rename", { workspace_id: id, title: title(stay) });
    else await rpc("workspace.action", { action: "clear_name", workspace_id: id });
    const panes = await rpc("pane.list", { workspace_id: id });
    if (panes.panes.length === 2) await rpc("pane.resize", { workspace_id: id, pane_id: stay.pane, absolute_axis: "vertical", target_pixels: Math.round(layout.split * panes.container_frame.height) });
    if (panes.panes.length !== 2 || panes.panes.some((p: any) => p.surface_count !== 1)) say("this workspace still has other tabs or panes, look at it");
  }
});
