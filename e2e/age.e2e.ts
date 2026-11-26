#!/usr/bin/env bun
// E2E of cmux/sidebar-age.patch: the sidebar file runs in the real cmux SidebarRuntime.js, with a fake host.
// Usage: bun e2e/age.e2e.ts [sidebar file] [out folder]
//
// Ways it can fail (written before the code):
//   A01 A chat has no age, or the wrong unit (now, m, h, d, w), or a negative age (clock skew).
//   A02 The age does not move when only time passes.
//   A03 An old chat looks as bright as a new one. The open chat or a title color is dimmed.
//   A04 A working chat shows an age, or it is dimmed.
//   A05 A chat that was only opened, resumed, or quit looks new (its agent record has a new time).
//   A06 After a restart of cmux (no latestAt) the age is lost or is the start time.
//   A07 The end of a long turn does not count. The end of a stale (interrupted) turn counts.
//   A08 The saved text removes the text that the user or move-chats wrote, or grows at each save.
//   A09 It writes on each tick, writes again when cmux refuses, or writes an older time.
//   A10 A chat with no data shows a wrong age.
//   A11 An unread count and the age are drawn on top of each other, or a long title runs under the age.
//   A12 A new conversation does not become bright at once.
//   A13 A bad date in the description breaks the sidebar.
//   A14 move-chats makes a second workspace because the description has the new text (move.e2e.ts).
//   A15 An update of cmux-sidebar replaces the file, and the patch does not apply or applies two times (by hand: cmux/setup).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import vm from "node:vm";
const FILE = process.argv[2] ?? `${homedir()}/.config/cmux/sidebars/cmux-sidebar.js`;
const OUT = `${process.argv[3] ?? tmpdir()}/age-${Date.now()}`;
const RUNTIME = "/Applications/cmux.app/Contents/Resources/CmuxSwiftRenderUI_CmuxSwiftRenderUI.bundle/Contents/Resources/SidebarRuntime.js";
const results: any[] = [];
const ok = (id: string, name: string, pass: boolean, detail: unknown = "") => { results.push({ id, name, pass, detail }); console.log(`${pass ? "ok  " : "FAIL"} ${id} ${name}${pass ? "" : " " + JSON.stringify(detail)}`); };

const T = 1_795_555_000, H = 3600, D = 24 * H;
const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 16) + "Z";
const ag = (status: string, at = 0) => ({ id: "s1", kind: "claude", name: "Claude Code", status, lastActivityAt: at });
function mount(list: any[], now: number) {
  const nodes = new Map<string, any>(), actions: any[] = []; let root: any;
  const ctx: any = vm.createContext({
    __host_applyOps: (j: string) => JSON.parse(j).forEach((o: any) => {
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
  const set = (l: any[], t: number) => {
    const ws = l.map((w, index) => ({ selected: false, pinned: false, unread: 0, directory: "/tmp", ports: [], portCount: 0, tabs: [], tabCount: 0, ...w, index }));
    vm.runInContext(`Date.now = () => ${t * 1000}`, ctx);
    ctx.__setData("workspaces", JSON.stringify(ws)); ctx.__setData("groups", "[]");
    ctx.__setData("selectedId", JSON.stringify(ws.find((w) => w.selected)?.id ?? "")); ctx.__setData("clock", JSON.stringify({ epoch: t }));
  };
  set(list, now);
  vm.runInContext(readFileSync(FILE, "utf8"), ctx);
  const deep = (id: any, f: (n: any) => boolean): any[] => { const n = nodes.get(id); return !n || n.type === "contextMenu" ? [] : [...(f(n) ? [n] : []), ...n.children.flatMap((c: any) => deep(c, f))]; };
  const row = (title: string) => {
    const l = deep(root, (n) => n.type === "reorderable")[0];
    const r = l.children.find((c: any) => deep(c, (n) => n.props.text === title).length);
    const texts = deep(r, (n) => n.type === "text" && !!n.props.text);
    const t = texts.find((n) => n.props.text === title), age = texts.find((n) => /^(now|\d+[mhdw])$/.test(n.props.text));
    const holder = deep(r, (n) => n.type === "hstack")[0];
    return { age: age?.props.text ?? null, ageNode: age, color: t.props.color, badge: texts.some((n) => n !== t && n !== age && /^\d+$/.test(n.props.text)), pad: holder?.props.paddingTrailing ?? 0 };
  };
  return { set, row, writes: () => actions.filter((a) => a.params?.action === "set_description").map((a) => a.params), clear: () => actions.splice(0) };
}
const one = (x: any = {}) => [{ id: "w1", title: "job", ...x }];

for (const [ago, want] of [[20, "now"], [5 * 60, "5m"], [59 * 60, "59m"], [3 * H, "3h"], [23 * H, "23h"], [2 * D, "2d"], [15 * D, "2w"], [-300, "now"]] as any)
  ok("A01", `${ago} s ago is ${want}`, mount(one({ latestAt: T - ago }), T).row("job").age === want, mount(one({ latestAt: T - ago }), T).row("job").age);
{ const s = mount(one({ latestAt: T }), T); s.set(one({ latestAt: T }), T + 600); ok("A02", "time passes", s.row("job").age === "10m", s.row("job")); s.set(one({ latestAt: T }), T + 2 * D); ok("A02", "it becomes dim", s.row("job").color === "tertiary", s.row("job")); }
{ const c = (x: any) => mount(one(x), T).row("job").color;
  ok("A03", "under 1 h bright", c({ latestAt: T - 1800 }) === "primary", c({ latestAt: T - 1800 }));
  ok("A03", "today normal", c({ latestAt: T - 5 * H }) === "secondary"); ok("A03", "older dim", c({ latestAt: T - 2 * D }) === "tertiary");
  ok("A03", "open chat is bright", c({ latestAt: T - 2 * D, selected: true }) === "primary"); ok("A03", "title color stays", c({ latestAt: T - 2 * D, color: "#0A84FF" }) === "#0A84FF"); }
{ const r = mount(one({ latestAt: T - 2 * D, agents: [ag("working", T)] }), T).row("job"); ok("A04", "working: no age, bright", r.age === null && r.color === "primary", r); }
{ const d = `Moved from Orca: x | last active ${iso(T - 2 * D)}`;
  ok("A05", "only opened", mount(one({ description: d, agents: [ag("idle", T)] }), T).row("job").age === "2d");
  ok("A05", "resumed after a real message", mount(one({ latestAt: T - 5 * H, agents: [ag("ended", T)] }), T).row("job").age === "5h");
  ok("A06", "restart keeps the saved time", mount(one({ description: d }), T).row("job").age === "2d");
  const s = mount(one({ description: d }), T); ok("A09", "no write when nothing is new", s.writes().length === 0, s.writes());
  s.set(one({ description: d, latestAt: T + 10 }), T + 10); ok("A12", "a new message is bright at once", s.row("job").color === "primary" && s.row("job").age === "now", s.row("job"));
  const w = s.writes(); ok("A08", "one save, text stays", w.length === 1 && w[0].description === `Moved from Orca: x | last active ${iso(T + 10)}` && w[0].workspace_id === "w1", w);
  for (let i = 0; i < 20; i++) s.set(one({ description: d, latestAt: T + 10 }), T + 10 + i);
  ok("A09", "cmux refuses: no second write", s.writes().length === 1, s.writes());
  const s2 = mount(one({ description: w[0]?.description }), T + 3 * H); ok("A06", "mount after the save", s2.row("job").age === "3h" || s2.row("job").age === "2h", s2.row("job").age);
  const s3 = mount(one({ description: d, latestAt: T - 3 * D }), T); ok("A09", "older time is not written", s3.writes().length === 0 && s3.row("job").age === "2d", s3.writes()); }
{ const s = mount(one({ latestAt: T }), T); ok("A08", "no description", s.writes()[0]?.description === `last active ${iso(T)}`, s.writes());
  s.clear(); s.set(one({ latestAt: T + 500, description: `last active ${iso(T)}` }), T + 500); ok("A08", "it does not grow", s.writes()[0]?.description === `last active ${iso(T + 500)}`, s.writes()); }
{ const s = mount(one({ latestAt: T, agents: [ag("working", T)] }), T); s.set(one({ latestAt: T, agents: [ag("working", T + 3 * H - 5)] }), T + 3 * H - 2); s.set(one({ latestAt: T, agents: [ag("idle", T + 3 * H)] }), T + 3 * H);
  ok("A07", "the end of a long turn counts", s.row("job").age === "now", s.row("job")); ok("A07", "and is saved", s.writes().at(-1)?.description === `last active ${iso(T + 3 * H)}`, s.writes()); }
{ const s = mount(one({ latestAt: T, agents: [ag("working", T)] }), T); s.set(one({ latestAt: T, agents: [ag("working", T)] }), T + 2 * H); s.set(one({ latestAt: T, agents: [ag("idle", T + 2 * H + 5)] }), T + 2 * H + 5);
  ok("A07", "a stale end does not count", s.row("job").age === "2h", s.row("job")); }
{ const r = mount(one(), T).row("job"); ok("A10", "no data: no age, normal color", r.age === null && r.color === "secondary" && mount(one(), T).writes().length === 0, r);
  const f = mount(one({ agents: [ag("idle", T - 3 * H)] }), T); ok("A10", "only an agent: its time, not saved", f.row("job").age === "3h" && f.writes().length === 0, f.row("job")); }
{ const r = mount(one({ latestAt: T - 2 * H, unread: 2 }), T).row("job"); ok("A11", "unread: the count, no age", r.badge && r.age === null, r);
  const a = mount(one({ latestAt: T - 2 * H }), T).row("job"); ok("A11", "the title keeps space, the age hides on hover", a.pad >= 28 && JSON.stringify(a.ageNode?.props).toLowerCase().includes("hover"), [a.pad, a.ageNode?.props]);
  ok("A11", "no age: no space", mount(one(), T).row("job").pad === 0); }
{ const r = mount(one({ description: "my note | last active 2026-99-99T00:00Z" }), T).row("job"); ok("A13", "a bad date", r.age === null, r); }
mkdirSync(OUT, { recursive: true });
const failed = results.filter((r) => !r.pass).length;
writeFileSync(`${OUT}/result.json`, JSON.stringify({ file: FILE, passed: results.length - failed, failed, results }, null, 1));
console.log(`${results.length - failed} passed, ${failed} failed\n${OUT}/result.json`);
process.exit(failed ? 1 : 0);
