#!/usr/bin/env bun
// E2E of cmux/sidebar-projects.patch: the sidebar file runs in the real cmux SidebarRuntime.js, with a fake host.
// Usage: bun e2e/projects.e2e.ts [sidebar file] [out folder]
//
// Ways it can fail (written before the code):
//   J01 A group still lists a chat, also when it works, has finished, or is the open one, or when the group is collapsed.
//   J02 A plain terminal, a file, an agent with no chat page, or a chat in no group goes away.
//   J03 The header has a wrong state or count: working, waiting, finished, also for a subagent or an old (stale) turn.
//   J04 A collapsed parent hides what the chats of its subgroups do.
//   J05 A click on the header opens another chat than the last one, a chat that is closed, or one of another group.
//   J06 A group with no chat: the click does not open its anchor. The anchor cannot be reached any more.
//   J07 The header of the open chat does not look open.
//   J08 The toggle does not bring the old list back, or the old list is different from before.
//   J09 The Active and Favorites filters find no chats.
//   J10 A click on a header calls cmux for something else (collapse, close, move).
//   J11 A heartbeat of an agent draws the whole list again.
//   J12 (sidebar-look.patch) A section looks like a project, two projects have the same icon color, a project with
//       nothing open looks like one with chats, a chevron with nothing to unfold, the open project does not stand out,
//       no line between two sections, or the toggle of the chats breaks the icons.
//   J13 An idle agent flashes green before a background marker arrives or a new turn starts.
//       Work that really ended stays orange until another workspace update arrives.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import vm from "node:vm";
const FILE = process.argv[2] ?? `${homedir()}/.config/cmux/sidebars/cmux-sidebar.js`;
const OUT = `${process.argv[3] ?? process.env.ORCA_CHAT_E2E_OUT ?? "/tmp/orca-chat-e2e"}/projects-${Date.now()}`;
const RUNTIME = "/Applications/cmux.app/Contents/Resources/CmuxSwiftRenderUI_CmuxSwiftRenderUI.bundle/Contents/Resources/SidebarRuntime.js";
const results: any[] = [];
const ok = (id: string, name: string, pass: boolean, detail: unknown = "") => { results.push({ id, name, pass, detail }); console.log(`${pass ? "ok  " : "FAIL"} ${id} ${name}${pass ? "" : " " + JSON.stringify(detail)}`); };

const T = 1_795_555_000;
const ag = (status: string, at = T, extra = {}) => ({ id: "s-" + status + at, kind: "claude", name: "Claude Code", status, lastActivityAt: at, ...extra });
const chat = (id: string, group: string | null, status = "idle", extra: any = {}) => ({ id, title: id, group, agents: [ag(status)], tabCount: 2, tabs: [], ...extra });
const plain = (id: string, group: string | null, extra: any = {}) => ({ id, title: id, group, tabCount: 1, tabs: [], ...extra });
const group = (id: string, name: string, extra: any = {}) => ({ id, name, anchorId: id + "-anchor", collapsed: false, pinned: true, ...extra });

function mount(ws: any[], groups: any[]) {
  const nodes = new Map<string, any>(), actions: any[] = [];
  let root: any, ops = 0;
  const ctx: any = vm.createContext({
    __host_applyOps: (j: string) => JSON.parse(j).forEach((o: any) => {
      ops++;
      if (o.op === "create") nodes.set(o.id, { id: o.id, type: o.type, props: {}, children: [] });
      else if (o.op === "update") nodes.get(o.id).props[o.key] = o.value;
      else if (o.op === "children") nodes.get(o.id).children = o.children;
      else if (o.op === "append") nodes.get(o.id).children.push(o.child);
      else if (o.op === "remove") nodes.delete(o.id);
      else if (o.op === "root") root = o.id;
    }),
    __host_action: (j: string) => { const a = JSON.parse(j); if (a.kind === "cmux") actions.push(a); }, __host_log: () => {},
  });
  vm.runInContext(readFileSync(RUNTIME, "utf8"), ctx);
  const tick = (t: number) => {
    vm.runInContext(`Date.now = () => ${t * 1000}`, ctx);
    ctx.__setData("clock", JSON.stringify({ epoch: t }));
  };
  const set = (list: any[], gs: any[], t = T) => {
    const all = list.map((w, index) => ({ selected: false, pinned: false, unread: 0, directory: "/tmp", ports: [], portCount: 0, ...w, index }));
    vm.runInContext(`Date.now = () => ${t * 1000}`, ctx);
    ctx.__setData("workspaces", JSON.stringify(all)); ctx.__setData("groups", JSON.stringify(gs));
    ctx.__setData("selectedId", JSON.stringify(all.find((w) => w.selected)?.id ?? "")); ctx.__setData("clock", JSON.stringify({ epoch: t }));
  };
  set(ws, groups);
  vm.runInContext(readFileSync(FILE, "utf8"), ctx);
  const deep = (id: any, f: (n: any) => boolean, menus = false): any[] => { const n = nodes.get(id); return !n || (!menus && n.type === "contextMenu") ? [] : [...(f(n) ? [n] : []), ...n.children.flatMap((c: any) => deep(c, f, menus))]; };
  const list = () => nodes.get(deep(root, (n) => n.type === "reorderable")[0].id).children as string[];
  const texts = (id: string) => deep(id, (n) => n.type === "text" && !!n.props.text).map((n) => n.props.text as string);
  const find = (title: string) => list().find((c) => texts(c)[0]?.toLowerCase() === title.toLowerCase())!;
  // Of a header: [color or "", count] per mark, after its title.
  const marks = (title: string) => {
    const out: string[] = [];
    for (const n of deep(find(title), (x) => (x.type === "text" && /^\d+$/.test(x.props.text ?? "")) || x.type === "circle")) out.push(n.type === "circle" ? String(n.props.fill ?? n.props.color) : n.props.text);
    return out.join(" ");
  };
  const tap = (id: string) => ctx.__dispatch(id, "tap", "{}");
  const calls = () => actions.splice(0).filter((a) => a.params?.action !== "set_description").map((a) => `${a.command ?? a.name ?? a.method} ${a.params?.workspace_id ?? a.params?.group_id ?? ""}`);
  return { set, tick, nodes, deep, root: () => root, list, rows: () => list().map((c) => texts(c)[0]?.toLowerCase()).filter(Boolean), find, marks, tap, calls, ops: () => ops, background: (t: string) => nodes.get(find(t)).props.background, raw: actions };
}

const G = [group("p", "p"), group("q", "q"), group("sub", "p/sub"), group("empty", "empty")];
const anchors = G.map((g) => plain(g.anchorId, g.id));
const W = () => [anchors[0], chat("p1", "p"), chat("p2", "p", "working"), plain("p-files", "p"), chat("alone", "p", "idle", { tabCount: 1 }), anchors[2], chat("s1", "sub", "needs_input"), anchors[1], chat("q1", "q"), anchors[3], chat("loose", null), plain("shell", null)];
const opened = (id: string, ws = W()) => ws.map((w) => ({ ...w, selected: w.id === id }));
const want = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
const folder = (s: ReturnType<typeof mount>) => s.deep(s.root(), (n) => Object.values(n.props).some((v) => String(v).startsWith("Projects only: hide")))[0];
const ORANGE = "#FF8A00", PINK = "#FF79C6", GREEN = "#30D158";

const marker = "orca: background " + new Date(T * 1000).toISOString().slice(0, 16) + "Z";
{ const stamp = "last active 2026-01-01T00:00Z";
  const marked = (description: string, status = "idle") => opened("shell", W().map(w => w.id === "q1"
    ? { ...w, description, latestAt: T, agents: [ag(status, T - 3600)] } : w));
  const text = marker + " | notes | " + stamp;
  const s = mount(marked(text), G);
  const chatDot = (color: string) => {
    s.tap(folder(s).id);
    const visible = s.deep(s.find("q1"), n => n.type === "circle" && n.props.fill === color && n.props.opacity === 1).length > 0;
    s.tap(folder(s).id);
    return visible;
  };
  ok("J13", "an idle agent with background work has an orange project badge", s.marks("q") === ORANGE + " 1", s.marks("q"));
  ok("J13", "the chat shows its orange dot", chatDot(ORANGE));
  ok("J13", "saving the age keeps the marker and notes", s.raw.some(a => a.params?.workspace_id === "q1" &&
    a.params.description === marker + " | notes | last active " + new Date(T * 1000).toISOString().slice(0, 16) + "Z"));
  const expired = mount(marked(text.replace(marker, "orca: background 2020-01-01T00:00Z")), G);
  ok("J13", "an expired marker cannot turn an idle project orange", !expired.marks("q").includes(ORANGE));
  const stopped = mount(marked(text), G);
  stopped.tick(T + 301); stopped.tick(T + 310);
  ok("J13", "the clock expires a stopped helper marker", !stopped.marks("q").includes(ORANGE));
  s.set(marked(text, "working"), G);
  ok("J13", "a stale agent record cannot hide background work", s.marks("q") === ORANGE + " 1", s.marks("q"));
  s.set(marked("notes mention orca: background | " + stamp), G, T + 5);
  s.tick(T + 13);
  ok("J13", "removing the exact marker turns the project badge green", s.marks("q") === GREEN + " 1", s.marks("q"));
  ok("J13", "the finished chat shows its green dot", chatDot(GREEN)); }

{ const state = (status: string, description = "") => opened("shell", W().map(w => w.id === "q1"
    ? { ...w, agents: [ag(status)], description } : w));
  const s = mount(state("working"), G);
  const check = (name: string, color: string) => ok("J13", name, s.marks("q") === color + " 1", s.marks("q"));
  s.set(state("idle"), G, T);
  check("the chat stays orange when the agent goes idle", ORANGE);
  s.set(state("idle", marker), G, T + 3);
  s.tick(T + 8);
  check("the marker arriving three seconds later cancels the first finish", ORANGE);
  s.set(state("idle"), G, T + 10);
  s.tick(T + 17.999);
  check("the chat stays orange for the full wait after the marker goes", ORANGE);
  s.tick(T + 18);
  check("the clock alone turns the badge green after background work ends", GREEN);

  s.set(state("working"), G, T + 20);
  s.set(state("idle"), G, T + 21);
  s.tick(T + 28.999);
  check("a turn without background work stays orange before eight seconds", ORANGE);
  s.tick(T + 29);
  check("a turn without background work turns green at eight seconds", GREEN);

  s.set(state("working"), G, T + 30);
  s.set(state("idle"), G, T + 31);
  s.set(state("working"), G, T + 34);
  s.tick(T + 39);
  check("a new prompt keeps the badge orange past the canceled deadline", ORANGE);
  s.set(state("idle"), G, T + 40);
  check("the new turn gets its own wait when it ends", ORANGE); }

{ const s = mount(opened("p1"), G);
  ok("J01", "a group lists no chat, also not one that works or is open", want(s.rows(), ["p", "p-files", "alone", "sub", "q", "empty", "loose", "shell"]), s.rows());
  ok("J02", "a plain terminal, an agent with no page, and a chat in no group stay", ["p-files", "alone", "loose", "shell"].every((t) => s.rows().includes(t)));
  ok("J03", "working and its count", s.marks("p") === `${ORANGE} 1`, s.marks("p"));
  ok("J03", "waiting", s.marks("sub") === `${PINK} 1`, s.marks("sub"));
  ok("J03", "nothing happens: the number of chats", s.marks("q") === "1" && s.marks("empty") === "", [s.marks("q"), s.marks("empty")]);
  ok("J07", "the header of the open chat looks open, the others do not", Boolean(s.background("p")) && s.background("p") !== s.background("q"), [s.background("p"), s.background("q")]);
  s.set(opened("q1", W().map((w) => (w.id === "p2" ? { ...w, agents: [ag("idle", T + 5)] } : w))), G, T + 5);
  s.tick(T + 13);
  ok("J03", "finished while another one is open", s.marks("p") === `${GREEN} 1`, s.marks("p"));
  ok("J07", "then the header of that project", !s.background("p") && Boolean(s.background("q")));
  s.set(opened("p2", W().map((w) => (w.id === "p2" ? { ...w, agents: [ag("idle", T + 5)] } : w))), G, T + 14);
  ok("J03", "opened: not finished any more", s.marks("p") === "2", s.marks("p"));
  s.calls(); s.tap(s.find("p")); const last = s.calls();
  s.set(opened("q1"), G, T + 15); s.calls(); s.tap(s.find("p")); const back = s.calls();
  ok("J05", "a click opens the chat that was open last", want(back, ["workspace.select p2"]), [last, back]);
  ok("J10", "and calls nothing else", back.length === 1);
  s.set(opened("q1", W().filter((w) => w.id !== "p2")), G, T + 16); s.tap(s.find("p")); const closed = s.calls();
  ok("J05", "that one is closed: the first chat", want(closed, ["workspace.select p1"]), closed); }
{ const s = mount(opened("shell"), G); s.calls(); s.tap(s.find("q")); ok("J05", "none was open: the first chat of this group", want(s.calls(), ["workspace.select q1"]));
  s.tap(s.find("empty")); const e = s.calls(); ok("J06", "a group with no chat opens its anchor", want(e, ["workspace.select empty-anchor"]), e);
  const buttons = s.deep(s.root(), (n) => n.props.title === "Open First Workspace" || n.props.label === "Open First Workspace" || n.props.text === "Open First Workspace", true);
  if (buttons[0]) s.tap(buttons[0].id);
  const a = s.calls(); ok("J06", "the menu of a header opens its anchor", buttons.length === 4 && a.length === 1 && /anchor$/.test(a[0]), [buttons.length, a]); }
{ const g = [{ ...G[0], collapsed: true }, ...G.slice(1)], s = mount(opened("shell"), g);
  ok("J01", "a collapsed group lists no working chat", !s.rows().some((t) => /^(p1|p2|s1)$/.test(t)), s.rows());
  ok("J04", "its header has the chats below too", s.marks("p") === `${PINK} 1 ${ORANGE} 1`, s.marks("p"));
  s.calls(); s.tap(s.find("p")); const c = s.calls(); ok("J05", "and opens a chat of its own", c.includes("workspace.select p1"), c); }
{ const s = mount(opened("shell"), G), f = folder(s);
  ok("J08", "the toggle is in the bar", Boolean(f)); s.tap(f.id);
  ok("J08", "off: the old list", want(s.rows(), ["p", "p1", "p2", "p-files", "alone", "sub", "s1", "q", "q1", "empty", "loose", "shell"]), s.rows());
  ok("J08", "off: the header has no marks and opens its anchor", s.marks("p") === "" && (s.calls(), s.tap(s.find("p")), want(s.calls(), ["workspace.select p-anchor"])), s.marks("p"));
  s.tap(f.id); ok("J08", "on again", !s.rows().includes("p1")); }
{ const s = mount(opened("shell"), G), chip = s.deep(s.root(), (n) => n.props.tappable && s.deep(n.id, (x) => /^Active/.test(x.props.text ?? "")).length > 0).at(-1);
  s.tap(chip.id); ok("J09", "the Active filter lists the working chats", s.rows().includes("p2"), s.rows()); }
{ const ws = W().map((w) => (w.id === "p1" ? { ...w, agents: [ag("working", T - 3600)] } : w)), s = mount(opened("shell", ws), G);
  ok("J03", "an old (stale) turn is not working", s.marks("p") === `${ORANGE} 1`, s.marks("p"));
  const sub = W().map((w) => (w.id === "q1" ? { ...w, agents: [ag("idle", T, { children: [{ id: "c", running: true, startedEpoch: T }] })] } : w)); s.set(opened("shell", sub), G);
  ok("J03", "a subagent that runs is working", s.marks("q") === `${ORANGE} 1`, s.marks("q"));
  const before = s.list().join(), n = s.ops(); s.set(opened("shell", sub.map((w) => (w.id === "q1" ? { ...w, agents: [{ ...w.agents[0], lastActivityAt: T + 1 }] } : w))), G);
  ok("J11", "a heartbeat draws nothing again", s.list().join() === before && s.ops() - n <= 4, s.ops() - n); }
{ const g = [group("m", "Mm"), group("a", "Mm/alpha"), group("b", "Mm/beta"), group("n", "Mm/none"), group("k", "Kk"), group("c", "Kk/alpha two")], at = (id: string) => plain(id + "-anchor", id);
  const ws = [at("m"), at("a"), chat("a1", "a"), at("b"), chat("b1", "b"), plain("b-files", "b"), at("n"), at("k"), at("c"), chat("c1", "c")], s = mount(opened("a1", ws), g);
  const icons = (t: string) => s.deep(s.find(t), (n) => n.type === "image" && /square\.fill|folder\.fill/.test(JSON.stringify(n.props))), chevron = (t: string) => s.deep(s.find(t), (n) => n.type === "image" && /chevron\.right/.test(JSON.stringify(n.props)))[0].props.opacity;
  ok("J12", "a section has a caption and no icon, a project has its letter", icons("Mm").length === 0 && s.deep(s.find("Mm"), (n) => n.props.text === "MM").length === 1 && icons("alpha").length === 1 && JSON.stringify(icons("alpha")[0].props).includes("a.square.fill"), [icons("Mm"), icons("alpha")]);
  const colors = ["alpha", "beta", "none", "alpha two"].map((t) => icons(t)[0]?.props.color); ok("J12", "each project has its own color", new Set(colors).size === 4 && colors.every((c) => /^#/.test(c ?? "")), colors);
  ok("J12", "a project with chats is a card, one with nothing open is not and is dim", !!s.background("beta") && !s.background("none") && !s.background("Mm") && icons("none")[0].props.opacity < 1 && icons("beta")[0].props.opacity === 1, [s.background("beta"), s.background("none")]);
  ok("J12", "the open project stands out", s.background("alpha") !== s.background("beta"), s.background("alpha"));
  ok("J12", "a chevron only where something unfolds", chevron("alpha") === 0 && chevron("beta") === 1 && chevron("Mm") === 1, [chevron("alpha"), chevron("beta")]);
  ok("J12", "a line ends each section", s.list().filter((id) => s.deep(id, (n) => n.type === "divider").length).length === 2, s.list().length);
  s.tap(folder(s).id); ok("J12", "with the chats listed: the icons stay", icons("alpha").length === 1 && chevron("alpha") === 1); }
mkdirSync(OUT, { recursive: true });
const failed = results.filter((r) => !r.pass).length;
writeFileSync(`${OUT}/result.json`, JSON.stringify({ file: FILE, passed: results.length - failed, failed, results }, null, 1));
console.log(`${results.length - failed} passed, ${failed} failed\n${OUT}/result.json`);
process.exit(failed ? 1 : 0);
