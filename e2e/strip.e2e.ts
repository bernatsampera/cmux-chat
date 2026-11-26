#!/usr/bin/env bun
// E2E of the project strip (lib/tabs.ts, the page of lib/follow.ts) and of cmux/to-workspaces, with the
// real cmux: hidden workspaces and a group of its own, a shell in place of claude, a server of its own.
// The cmux CLI of the helper is a wrapper: workspace.select is written to a file and NOT sent, because a
// real one changes what the user sees.
// The ways it can fail, written before the code:
// The list
//   S01 It misses a chat, has one twice, one of another group, a merged workspace, or a plain terminal. The order is not that of the group.
//   S02 A new chat, a closed chat, a new name, a result that is not read, or one that was read does not come into the list.
//   S03 It is written when nothing changed, others can read it, or it has the token or a URL.
//   S04 A chat that cmux has not loaded yet (no URL after a restart) is not in it.
// The pick
//   S05 A click in the real page (WebKit) does not arrive: the policy, the header, or a hidden page.
//   S06 It selects another workspace, selects two times, or acts on an old pick, on a terminal that is gone, or on another group.
//   S07 The workspace that is left keeps the focus on its page, or a tab or a workspace moves.
//   S08 It needs more than half a second.
//   S09 The plus: no new chat, two, in another group or folder, not at the end, not the layout of cmux.json, or it is not selected.
// The helper
//   S10 The plain mode or --new does not start it, or two run.
//   S11 It costs CPU when nothing happens.
//   S12 The token is in an argv, a log, the event log of cmux, or the files. The user loses the focus, or sees one of these workspaces.
// to-workspaces
//   W01 The dry run changes something, or says something else than the real run.
//   W02 A terminal process starts again, or its page is another one.
//   W03 A chat ends with the wrong page, in the wrong pane, with two tabs in a pane, or a placeholder stays.
//   W04 The workspace has not the name of the chat, or a name like "Claude Code" becomes a name that a person gave.
//   W05 A workspace is not in the group, or the order of the chats changes.
//   W06 The split is not the one of the command.
//   W07 It moves something of another project, or of a workspace with one chat. A project name that nobody has.
//   W08 A plain terminal is lost, or it stays as a tab under the chat.
//   W09 The chat that is open moves. A second run changes something.
//   W10 The saved layout is missing, others can read it, or it has the token.
//
// Not here: a real click with the mouse, the look, a real workspace.select, a real Claude.
//
// Run: bun e2e/strip.e2e.ts   (in a cmux terminal, needs bin/install first)
// Output: $ORCA_CHAT_E2E_OUT/strip-<time>/result.json
// It closes only workspaces that it made, by uuid, and stops only its own server and helper.
import { config } from "../lib/config";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, ".."), CMUX = process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux";
const OUT = join(process.env.ORCA_CHAT_E2E_OUT ?? join(tmpdir(), "orca-chat-e2e"), `strip-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const STATE = join(OUT, "state"), CHATS = join(STATE, "chats.json"), PICK = join(STATE, "pick.json");
const folder = (name: string) => join(OUT, name);
for (const dir of [STATE, join(OUT, "claude"), join(OUT, "codex"), ...["strip-e2e-p", "strip-e2e-q", "strip-e2e-m", "elsewhere"].map(folder)]) mkdirSync(dir, { recursive: true });

const results: { id: string; check: string; ok: boolean; evidence?: unknown }[] = [], metrics: Record<string, unknown> = {};
const hide = (x: unknown) => JSON.parse(JSON.stringify(x ?? null).replace(/[0-9a-f]{64}/gi, "***"));
function check(id: string, name: string, ok: boolean, evidence?: unknown) {
  results.push({ id, check: name, ok, evidence: hide(evidence) });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${ok ? "" : " :: " + JSON.stringify(hide(evidence)).slice(0, 1200)}`);
}
async function until<T>(fn: () => T | Promise<T>, ms = 4_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) {
    const value = await fn();
    if (value) return value;
  }
}
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
// lib/tabs.ts reads the port, so only pages of this test are chats: the workspaces of the user are not.
Object.assign(process.env, { ORCA_CHAT_STATE_DIR: STATE, ORCA_CHAT_PORT: String(port), CLAUDE_CONFIG_DIR: join(OUT, "claude"), CODEX_HOME: join(OUT, "codex") });
const { readTabs, selectTab } = await import("../lib/tabs");
type Tab = Awaited<ReturnType<typeof readTabs>>[number];
const low = (x: unknown) => String(x ?? "").toLowerCase();
async function rpc(method: string, params: object): Promise<any> {
  const p = Bun.spawn([CMUX, "rpc", method, "-"], { stdin: Buffer.from(JSON.stringify(params)), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(9), 8_000);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${method}: ${err.trim()}`);
  return JSON.parse(out);
}

// ---- the cmux CLI of the helper, and the agent ----
const WRAP = join(OUT, "cmux"), SELECTS = join(OUT, "selects.log"), CREATES = join(OUT, "creates.log"), AGENT = join(OUT, "agent.sh");
writeFileSync(WRAP, `#!/bin/bash
# The real cmux. A select is written down and not sent. A new chat starts the agent of the test.
case "$1 $2" in
  "rpc workspace.select") { cat; echo; } >>'${SELECTS}'; echo '{}'; exit 0 ;;
  "rpc surface.focus"|"rpc pane.focus"|"rpc workspace.group.focus") echo 'Error: not in this test' >&2; exit 1 ;;
  "rpc workspace.create") in="$(cat)"; echo "$in" >>'${CREATES}'
    jq -c --arg c "exec ${AGENT} plus$(wc -l <'${CREATES}' | tr -d ' ') Plus 0 --new" '.layout.children[1].pane.surfaces[0].command=$c' <<<"$in" | exec '${CMUX}' "$@"; exit $? ;;
esac
exec '${CMUX}' "$@"
`);
writeFileSync(AGENT, `#!/usr/bin/env bash
# agent.sh <name> <title> <wait> <mode>...: runs cmux-chat-open with each mode, then waits like an agent.
export ${["ORCA_CHAT_STATE_DIR", "ORCA_CHAT_PORT", "CLAUDE_CONFIG_DIR", "CODEX_HOME"].map((k) => `${k}='${process.env[k]}'`).join(" ")} CMUX_BUNDLED_CLI_PATH='${WRAP}'
name="$1" title="$2"; sleep "$3"; shift 3
for mode in "$@"; do '${ROOT}/bin/cmux-chat-open' $mode 2>>"${OUT}/$name.err"; echo "$mode exit $?" >>"${OUT}/$name.log"; done
printf '\\033]0;%s\\007' "$title"
echo "ready $$ $CMUX_SURFACE_ID $CMUX_WORKSPACE_ID" >>"${OUT}/$name.log"
exec cat
`);
for (const f of [WRAP, AGENT]) chmodSync(f, 0o755);
const text = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const lines = (f: string) => text(f).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ready = (name: string) => until(() => /ready (\d+) (\S+) (\S+)/.exec(text(join(OUT, `${name}.log`))), 25_000);
const pidOf = (name: string) => Number(/ready (\d+)/.exec(text(join(OUT, `${name}.log`)))?.[1]);
const ps = () => spawnSync("/bin/ps", ["-axww", "-o", "command"], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout;
const start = (pid: number) => spawnSync("/bin/ps", ["-o", "lstart=,tty=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

// ---- workspaces and groups of our own ----
const made: string[] = [], groups: Record<string, string> = {};
async function group(name: string) {
  const g = (await rpc("workspace.group.create", { name, cwd: folder(name), idempotency_key: `project:${folder(name)}` })).group;
  made.push(low(g.anchor_workspace_id));
  await rpc("workspace.group.collapse", { group_id: g.id }); // less to see in the sidebar of the user
  return (groups[name] = g.id);
}
const members = async (name: string): Promise<string[]> => (await rpc("workspace.group.list", {})).groups.find((g: any) => g.id === groups[name])?.member_workspace_ids.map(low) ?? [];
const run = (name: string, title: string, mode: string) => `exec ${AGENT} ${name} '${title}' 0 ${mode ? mode : "''"}`;
async function workspace(title: string, cwd: string, terminal: object, extra: object = {}): Promise<string> {
  const layout = { direction: "vertical", split: 0.7, children: [
    { pane: { surfaces: [{ type: "browser", name: "Chat", url: "data:text/html,empty" }] } },
    { pane: { surfaces: [{ type: "terminal", cwd, focus: true, ...terminal }] } },
  ] };
  const r = await rpc("workspace.create", { cwd, focus: false, title, title_source: "auto", layout, ...extra });
  made.push(low(r.workspace_id));
  return made.at(-1)!;
}
async function newTerminal(ws: string, pane: string, command: string): Promise<string> {
  const p = Bun.spawn([CMUX, "new-surface", "--type", "terminal", "--workspace", ws, "--pane", pane, "--focus", "false", "--id-format", "uuids", "--command", command], { stdout: "pipe", stderr: "pipe" });
  return low(/[0-9a-f-]{36}/i.exec(await new Response(p.stdout).text())?.[0]);
}
const tabs = (ws: string) => readTabs(rpc, ws);
const brief = (all: Tab[]) => all.map((t) => `${t.type[0]}${t.id.slice(0, 4)}@${t.pane.slice(0, 2)}${t.chat ? "->" + t.chat.slice(0, 4) : ""}${t.selected ? "*" : ""}${t.focused ? "F" : ""} ${t.title}`);
const terminalOf = async (ws: string) => (await tabs(ws)).find((t) => t.type === "terminal")!;
const pageOf = async (ws: string) => (await tabs(ws)).find((t) => t.chat)!;
const list = (name: string): any[] => { try { return JSON.parse(text(CHATS)).projects.find((p: any) => p.folder === folder(name))?.chats ?? []; } catch { return []; } };
const listed = (name: string) => list(name).map((c) => c.workspace).join();

// ---- what the user sees, all the time ----
const focusOf = async () => (await rpc("system.identify", {})).focused ?? {};
const before = await focusOf(), stolen: unknown[] = [], visited = new Set<string>();
let watching = true;
const guard = (async () => {
  while (watching) {
    const f = await focusOf().catch(() => null);
    if (f) visited.add(f.workspace_id);
    if (f && made.includes(low(f.workspace_id))) stolen.push(f);
    await Bun.sleep(150);
  }
})();
const pgrep = (...args: string[]) => spawnSync("/usr/bin/pgrep", args, { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map(Number);
const helpers = () => pgrep("-f", `lockf.*${STATE}/tabs.lock`);
const eventLog = join(homedir(), ".cmuxterm/events.jsonl"), eventLogFrom = existsSync(eventLog) ? statSync(eventLog).size : 0;
let argv = "";

try {
  // ---- S10 S01 ----
  for (const g of ["strip-e2e-p", "strip-e2e-q", "strip-e2e-m"]) await group(g);
  const P = { group_id: groups["strip-e2e-p"], group_placement: "end" }, Q = { group_id: groups["strip-e2e-q"], group_placement: "end" };
  const p = folder("strip-e2e-p");
  const a = await workspace("Alpha", p, { command: run("a", "Alpha agent", "") }, P);
  await ready("a");
  check("S10", "the plain mode starts the helper", Boolean(await until(() => helpers().length === 1)), [helpers(), text(join(OUT, "a.err"))]);
  const helper = pgrep("-P", String(helpers()[0]))[0];
  const b = await workspace("Beta", p, { command: run("b", "Beta agent", "--new"), name: "Claude" }, P);
  const c = await workspace("Gamma", p, { command: run("c", "Gamma agent", "--new"), name: "Codex" }, P);
  const q1 = await workspace("Other", folder("strip-e2e-q"), { command: run("q1", "Other agent", "--new") }, Q);
  const loose = await workspace("Loose", folder("elsewhere"), { command: run("loose", "Loose agent", "--new") });
  const plain = await workspace("Plain", p, { command: "exec cat" }, P);
  for (const n of ["b", "c", "q1", "loose"]) await ready(n);
  check("S10", "more chats: one helper, the same one", helpers().length === 1 && pgrep("-P", String(helpers()[0]))[0] === helper, helpers());
  await until(() => list("strip-e2e-p").length === 3 && list("strip-e2e-q").length === 1, 8_000);
  const order = (await members("strip-e2e-p")).filter((w) => [a, b, c].includes(w));
  check("S01", "the chats of the project in the order of the group, not the plain terminal", listed("strip-e2e-p") === order.join() && order.join() === [a, b, c].join(), [list("strip-e2e-p"), order]);
  check("S01", "the other project has its own, a chat in no group is in none", listed("strip-e2e-q") === q1 && !text(CHATS).includes(loose) && !text(CHATS).includes(plain), list("strip-e2e-q"));
  const ta = await terminalOf(a), tb = await terminalOf(b);
  check("S01", "each with its terminal, its name, and the agent of its tab", JSON.stringify(list("strip-e2e-p").map((x) => [x.terminal, x.title, x.agent, x.unread])) === JSON.stringify([[ta.id, "Alpha", undefined, false], [tb.id, "Beta", "claude", false], [(await terminalOf(c)).id, "Gamma", "codex", false]].map((x) => x.map((y) => y ?? null))), list("strip-e2e-p"));
  check("S03", "the list is 0600, with no token and no URL", (statSync(CHATS).mode & 0o777) === 0o600 && !/[0-9a-f]{64}|http/i.test(text(CHATS)));

  // ---- S02 ----
  const took = async (what: () => Promise<unknown>, done: () => unknown) => { await what(); const from = Date.now(); return (await until(done, 8_000)) ? Date.now() - from : -1; };
  const row = (ws: string) => list("strip-e2e-p").find((x) => x.workspace === ws);
  const ms: Record<string, number> = {};
  ms.rename = await took(() => rpc("workspace.rename", { workspace_id: b, title: "Beta two" }), () => row(b)?.title === "Beta two");
  const note = await rpc("notification.create_for_surface", { workspace_id: b, surface_id: tb.id, title: "e2e", body: "done", desktop: false });
  ms.unread = await took(async () => {}, () => row(b)?.unread === true);
  check("S02", "only the chat with the result is not read", list("strip-e2e-p").filter((x) => x.unread).length <= 1, list("strip-e2e-p"));
  ms.read = await took(() => rpc("notification.mark_read", { id: note.id }), () => row(b)?.unread === false);
  const d = await workspace("Delta", p, { command: run("d", "Delta agent", "--new") }, P);
  await ready("d");
  ms.newChat = await took(async () => {}, () => row(d));
  ms.closed = await took(() => rpc("workspace.close", { workspace_id: d, force: true }), () => !row(d));
  metrics.changeToListMs = ms;
  check("S02", "a name, an unread and a read result, a new and a closed chat are in the list in 1.6 s", Object.values(ms).every((x) => x >= 0 && x < 1_600), ms);
  await Bun.sleep(2_500);
  const mtime = statSync(CHATS).mtimeMs;
  await Bun.sleep(11_000);
  check("S03", "nothing changes: it is not written again", statSync(CHATS).mtimeMs === mtime);

  // ---- S04 ----
  const cold = await rpc("workspace.create", { cwd: p, focus: false, title: "Cold", title_source: "auto", ...P, layout: { direction: "vertical", split: 0.7, children: [{ pane: { surfaces: [{ type: "browser", name: "Chat" }] } }, { pane: { surfaces: [{ type: "terminal", name: "Codex", command: "exec cat" }] } }] } });
  made.push(low(cold.workspace_id));
  await until(() => row(low(cold.workspace_id)), 8_000);
  const cold1 = row(low(cold.workspace_id));
  check("S04", "a chat page that cmux has not loaded yet is in the list", cold1?.agent === "codex" && cold1.terminal === (await terminalOf(low(cold.workspace_id))).id, [cold1, (await tabs(low(cold.workspace_id))).map((t) => [t.type, t.title, t.url])]);
  await rpc("workspace.close", { workspace_id: cold.workspace_id, force: true });

  // ---- S05 S07 S08 the page in WebKit ----
  const evalIn = async (ws: string, script: string) => { const r = await rpc("browser.eval", { workspace_id: ws, surface_id: (await pageOf(ws)).id, script }); return r.value ?? r.result ?? r; };
  // A hidden page does not poll: here it thinks that it is visible. cmux evaluates in a world of its own, so this is a script in the page.
  const wake = (ws: string) => evalIn(ws, `const s=document.createElement("script");s.textContent='Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"visible"});document.dispatchEvent(new Event("visibilitychange"))';document.head.append(s);"ok"`);
  await wake(a);
  const drawn = await until(async () => { const x = String(await evalIn(a, `[...document.querySelectorAll(".tab")].map(t=>t.className+"|"+t.children[1].textContent).join("\\n")`)); return x.includes("Gamma") && x; }, 8_000);
  // cmux moves a workspace with a new notification to the top of its group, and the strip has the order of the group.
  const want: Record<string, string> = { [a]: "tab   me|Alpha", [b]: "tab claude |Beta two", [c]: "tab codex |Gamma" };
  check("S05", "the page draws the strip: the names, the icons, the own chat, the order of the group", drawn === (await members("strip-e2e-p")).map((w) => want[w]).filter(Boolean).join("\n"), drawn);
  const look = JSON.parse(String(await evalIn(a, `JSON.stringify({bar:document.getElementById("bar").getBoundingClientRect().height,tab:document.querySelector(".tab").getBoundingClientRect().height,icon:getComputedStyle(document.querySelector(".tab.claude i")).backgroundImage.slice(0,24),frames:[...document.querySelectorAll("iframe")].map(f=>f.getBoundingClientRect().top),width:innerWidth,state:document.getElementById("state").textContent})`)));
  metrics.look = look;
  check("S05", "the strip is 32 px high, with its icon", look.bar === 32 && look.tab > 28 && look.icon.startsWith('url("data:image/svg+xml'), look);
  await selectTab(rpc, await pageOf(a)); // as a click: the page has the focus of the workspace
  await until(async () => (await pageOf(a)).focused);
  const layoutBefore = (await tabs(a)).map((t) => `${t.pane}/${t.id}`).join() + (await members("strip-e2e-p")).join();
  let from = Date.now();
  await evalIn(a, `[...document.querySelectorAll(".tab")].find(t=>t.title.startsWith("Beta")).click();"ok"`);
  await until(() => lines(SELECTS).length > 0);
  metrics.clickToSelectMs = Date.now() - from;
  check("S05 S06", "a click on a tab selects the workspace of that chat, one time", JSON.stringify(lines(SELECTS).map((x) => low(x.workspace_id))) === JSON.stringify([b]), lines(SELECTS));
  // cmux answers an eval of a hidden page late at times, so the limit is from the pick that the server wrote.
  metrics.pickToSelectMs = Math.round(statSync(SELECTS).mtimeMs - JSON.parse(text(PICK)).at);
  check("S08", "in less than 500 ms", (metrics.pickToSelectMs as number) < 500, [metrics.pickToSelectMs, metrics.clickToSelectMs]);
  check("S07", "the terminal of the workspace that was left has the focus again", Boolean(await until(async () => (await terminalOf(a)).focused)), brief(await tabs(a)));
  check("S07", "and no tab and no workspace has moved", (await tabs(a)).map((t) => `${t.pane}/${t.id}`).join() + (await members("strip-e2e-p")).join() === layoutBefore);
  await selectTab(rpc, await pageOf(a));
  await until(async () => (await pageOf(a)).focused);
  await evalIn(a, `document.querySelector(".tab.me").click();"ok"`);
  check("S07", "a click on the own tab gives the focus to the terminal, and selects nothing", Boolean(await until(async () => (await terminalOf(a)).focused)) && lines(SELECTS).length === 1, brief(await tabs(a)));
  // Two terminal tabs under the chat: the one that the user chose stays.
  const extra = await newTerminal(a, ta.pane, "exec cat");
  await selectTab(rpc, (await until(async () => (await tabs(a)).find((t) => t.id === extra)))!);
  await Bun.sleep(1_500);
  await evalIn(a, `document.querySelector(".tab.me").click();"ok"`);
  await Bun.sleep(800);
  check("S07", "another tab that is selected under the chat stays selected", Boolean((await tabs(a)).find((t) => t.id === extra)?.selected), brief(await tabs(a)));
  await rpc("surface.close", { workspace_id: a, surface_id: extra, force: true });

  // ---- S06 picks that must do nothing ----
  const pick = async (x: object) => { writeFileSync(PICK, JSON.stringify(x), { mode: 0o600 }); await Bun.sleep(700); };
  const now = lines(SELECTS).length, tq = (await terminalOf(q1)).id, tl = (await terminalOf(loose)).id;
  await pick({ from: ta.id, to: tb.id, at: Date.now() - 3_000 });
  await pick({ from: ta.id, to: tq, at: Date.now() });
  await pick({ from: ta.id, to: tl, at: Date.now() });
  await pick({ from: tl, to: tb.id, at: Date.now() });
  await pick({ from: ta.id, to: crypto.randomUUID(), at: Date.now() });
  await pick({});
  writeFileSync(PICK, "{");
  await Bun.sleep(300);
  check("S06", "an old pick, another project, no group, an unknown terminal, no JSON: nothing is selected or made", lines(SELECTS).length === now && lines(CREATES).length === 0, [lines(SELECTS).slice(now), lines(CREATES)]);
  await pick({ from: ta.id, to: tb.id, at: Date.now() });
  check("S06", "and the next good pick works", lines(SELECTS).length === now + 1, text(join(STATE, "tabs.log")));

  // ---- S09 the plus ----
  from = Date.now();
  await evalIn(a, `document.getElementById("plus").click();document.getElementById("plus").click();"ok"`);
  await until(() => lines(SELECTS).length > now + 1, 6_000);
  metrics.plusToSelectMs = Date.now() - from;
  const created = lines(CREATES), fresh = low(lines(SELECTS).at(-1)?.workspace_id);
  if (fresh && !made.includes(fresh)) made.push(fresh);
  await Bun.sleep(1_500);
  check("S09", "a double click on the plus makes one chat and selects it", created.length === 1 && lines(SELECTS).length === now + 2 && (await members("strip-e2e-p")).includes(fresh), [created.length, fresh]);
  const command = config("cmux.json").commands.find((x: any) => x.name === "Claude + chat");
  check("S09", "with the layout and the name of cmux.json, in the folder of the project, and cmux may name it", JSON.stringify(created[0]?.layout) === JSON.stringify(command.workspace.layout) && created[0].title === command.name && created[0].title_source === "auto" && created[0].cwd === p && created[0].focus === false, created[0]);
  await ready("plus1");
  check("S09", "it is the last one of the project, and its chat is in the list", (await members("strip-e2e-p")).at(-1) === fresh && Boolean(await until(() => list("strip-e2e-p").at(-1)?.workspace === fresh, 8_000)), [await members("strip-e2e-p"), list("strip-e2e-p")]);

  // ---- S11 ----
  const cpu = (pid: number) => { const [m, s] = spawnSync("/bin/ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().split(":"); return Number(m) * 60 + Number(s); };
  const c0 = cpu(helper), t0 = Date.now();
  argv += ps();
  await Bun.sleep(20_000);
  metrics.helperCpuPercentIdle = Math.round(((cpu(helper) - c0) / ((Date.now() - t0) / 1000)) * 10000) / 100;
  check("S11", "under 2 percent of a core when nothing happens (its own process)", (metrics.helperCpuPercentIdle as number) < 2, metrics.helperCpuPercentIdle);

  // ---- W the way back to one workspace per chat ----
  const m = folder("strip-e2e-m"), M = { group_id: groups["strip-e2e-m"], group_placement: "end" };
  const ws = await workspace("merged", m, { command: run("m1", "Claude Code", "--project") }, M);
  await ready("m1");
  const m1 = await terminalOf(ws);
  const single = await workspace("Single", m, { command: run("single", "Single agent", "--new") }, M);
  await ready("single");
  const ids = [m1.id];
  for (const [n, title] of [["m2", "Second chat"], ["m3", "Third chat"], ["m4", "Fourth chat"]]) {
    ids.push(await newTerminal(ws, m1.pane, run(n, title, "--tab")));
    await ready(n);
    await until(async () => (await tabs(ws)).filter((t) => t.chat).length === ids.length, 8_000);
  }
  const bare = await newTerminal(ws, m1.pane, "exec cat");
  await Bun.sleep(1_500);
  await rpc("surface.action", { action: "rename", workspace_id: ws, surface_id: ids[2], title: "My third" });
  await rpc("surface.action", { action: "rename", workspace_id: ws, surface_id: bare, title: "My notes" });
  await selectTab(rpc, (await tabs(ws)).find((t) => t.id === ids[2])!); // the one that is "open" is in the middle
  await until(async () => (await tabs(ws)).filter((t) => t.title === "My third").length === 2 && (await tabs(ws)).filter((t) => t.title === "Second chat").length === 2, 15_000);
  await Bun.sleep(2_000);
  const merged = await tabs(ws), page = (t: string) => merged.find((x) => x.chat === t)!;
  check("S01", "a workspace with more than one chat is not in the list, the single chat of that project is", listed("strip-e2e-m") === single, list("strip-e2e-m"));
  for (const t of ids) await rpc("browser.eval", { workspace_id: ws, surface_id: page(t).id, script: `document.documentElement.dataset.mark="${t}"` });
  const starts = ["m1", "m2", "m3", "m4"].map((n) => [pidOf(n), start(pidOf(n))]);
  const tool = (...args: string[]) => spawnSync(join(ROOT, "cmux/to-workspaces"), args, { env: { ...process.env, CMUX_BUNDLED_CLI_PATH: CMUX }, encoding: "utf8" });
  const world = async () => JSON.stringify([await readTabs(rpc, ws), await readTabs(rpc, single), await members("strip-e2e-m"), await members("strip-e2e-p")]);
  const was = await world(), bad = tool("strip-e2e-nobody"), flag = tool("--go"), dry = tool("--dry-run", "strip-e2e-m");
  check("W07", "an unknown project or option: refused, nothing changes", bad.status === 1 && /0 projects/.test(bad.stderr) && flag.status === 1, [bad, flag].map((x) => [x.status, x.stderr]));
  check("W01", "the dry run changes nothing and saves nothing", dry.status === 0 && (await world()) === was && !readdirSync(STATE).some((f) => f.startsWith("layout-before")), dry.stdout + dry.stderr);
  from = Date.now();
  const real = tool("strip-e2e-m");
  metrics.toWorkspacesMs = Date.now() - from;
  for (const w of await members("strip-e2e-m")) if (!made.includes(w)) made.push(w);
  const plan = (s: string) => s.split("\n").filter((l) => l.includes("strip-e2e-m: ")).map((l) => l.replace(/^would: /, "").replace(/(gets a workspace) [0-9a-f]{8}/, "$1"));
  check("W01", "the real run says the same", real.status === 0 && plan(real.stdout).join() === plan(dry.stdout).join() && plan(dry.stdout).length === 5, [dry.stdout, real.stdout, real.stderr]);
  metrics.toWorkspacesOutput = plan(real.stdout);
  await Bun.sleep(1_500);
  const everything = await readTabs(rpc), home = (t: string) => everything.find((x) => x.id === t)?.workspace ?? "";
  const rows = [];
  for (const [i, t] of ids.entries()) {
    const now = everything.filter((x) => x.workspace === home(t)), mine = now.find((x) => x.chat === t);
    const mark = mine && (await rpc("browser.eval", { workspace_id: home(t), surface_id: mine.id, script: "document.documentElement.dataset.mark" }).then((r) => r.value ?? r.result, String));
    const tree = (await rpc("system.tree", { workspace_id: home(t) })).windows.flatMap((w: any) => w.workspaces).find((w: any) => low(w.id) === home(t));
    rows.push({ t, tabs: now.length, panes: new Set(now.map((x) => x.pane)).size, page: mine?.id === page(t).id, mark: mark === t, title: tree.title, split: Math.round(tree.layout.split * 100) / 100, top: low(tree.layout.children[0].pane.id) === mine?.pane, focus: Boolean(now.find((x) => x.id === t)?.focused), same: start(starts[i][0] as number) === starts[i][1] });
  }
  check("W02", "each terminal is the same process, each page is the same page, not loaded again", rows.every((r) => r.same && r.page && r.mark) && starts.every(([pid, s]) => pid && s), rows);
  check("W03", "each chat has its page on top and its terminal below, nothing else, and the terminal has the focus", rows.every((r) => r.tabs === 2 && r.panes === 2 && r.top && r.focus), rows);
  check("W06", "the split of the command", rows.every((r) => r.split === command.workspace.layout.split), rows.map((r) => r.split));
  check("W04", "the workspace has the name of its tab, a name that nobody gave is not kept", rows.map((r) => r.title).join() === "Claude + chat,Second chat,My third,Fourth chat", rows.map((r) => r.title));
  const owned = []; // a name that a person gave is not replaced by cmux
  for (const t of ids) owned.push((await rpc("workspace.set_auto_title", { probe: true, workspace_id: home(t) })).workspace_user_owned);
  check("W04", "cmux may name only the one with no name", JSON.stringify(owned) === "[false,true,true,true]", owned);
  const nowMembers = await members("strip-e2e-m");
  check("W05", "all are in the group, the chats in their order, then the plain terminal, then the chat that was there", nowMembers.filter((w) => w !== nowMembers[0]).join() === [...ids.map(home), home(bare), single].join(), [nowMembers, ids.map(home), home(bare), single]);
  const notes = everything.filter((x) => x.workspace === home(bare));
  check("W08", "the plain terminal has its own workspace with its name", notes.length === 1 && notes[0].id === bare && notes[0].name === "My notes", brief(notes));
  check("W09", "the open chat kept its workspace", home(ids[2]) === ws);
  check("W07", "the single chat of the project and the other project did not change", JSON.stringify([await readTabs(rpc, single), await members("strip-e2e-p")]) === JSON.stringify([JSON.parse(was)[1], JSON.parse(was)[3]]), brief(await tabs(single)));
  check("S01", "now all of them are in the list", Boolean(await until(() => listed("strip-e2e-m") === [...ids.map(home), single].join(), 8_000)), list("strip-e2e-m"));
  const [save, ...more] = readdirSync(STATE).filter((f) => f.startsWith("layout-before-workspaces."));
  const saved = JSON.parse(text(join(STATE, save)));
  check("W10", "the layout before is saved, 0600, with no token", more.length === 0 && (statSync(join(STATE, save)).mode & 0o777) === 0o600 && !/[0-9a-f]{64}/i.test(text(join(STATE, save))) && ids.every((t) => saved.tabs.some((x: any) => x.id === t && x.workspace === ws)));
  const after1 = await world(), again = tool("strip-e2e-m");
  check("W09", "a second run changes nothing", again.status === 0 && /no workspace has more than one chat/.test(again.stdout) && (await world()) === after1, again.stdout + again.stderr);

  // ---- S12 the token ----
  argv += ps();
  const token = readFileSync(join(STATE, "token"), "utf8").trim();
  const files = [CHATS, PICK, SELECTS, CREATES, join(STATE, "tabs.log"), ...["a", "b", "c", "q1", "m1", "m2", "plus1"].map((n) => join(OUT, `${n}.err`))].map(text).join("\n") + real.stdout + real.stderr;
  const newEvents = existsSync(eventLog) && statSync(eventLog).size >= eventLogFrom ? readFileSync(eventLog).subarray(eventLogFrom).toString() : "";
  check("S12", "the token is in no argv, no list, no log, and no event of cmux", !argv.includes(token) && !files.includes(token) && !newEvents.includes(token), { argv: argv.includes(token), files: files.includes(token), events: newEvents.split("\n").filter((l) => l.includes(token)).map((l) => l.slice(0, 200)) });
  check("S12", "no message in the launchers", ["a", "b", "c", "q1", "loose", "m1", "m2", "single"].every((n) => text(join(OUT, `${n}.err`)) === ""), ["a", "b", "m1", "m2"].map((n) => text(join(OUT, `${n}.err`))));
  metrics.helperLog = text(join(STATE, "tabs.log")).split("\n").slice(0, 20);
} catch (err: any) {
  check("ERR", "the test ran to its end", false, err?.stack ?? String(err));
}

// ---- the end: only what is ours ----
// The user can click on a workspace of the test in the sidebar: it is not closed under him.
await until(async () => !made.includes(low((await focusOf()).workspace_id)), 60_000);
watching = false;
await guard;
const after = await focusOf();
check("S12", "the user never had one of these workspaces in front", stolen.length === 0, stolen);
metrics.focus = { before: before.workspace_id, after: after.workspace_id, workspacesSeen: [...visited] };
for (const pid of helpers()) for (const k of pgrep("-P", String(pid))) process.kill(k);
for (const name of Object.keys(groups)) for (const w of await members(name)) if (!made.includes(w)) made.push(w); // all in a group of ours
for (const id of made.reverse()) if ((await rpc("workspace.list", {})).workspaces.some((x: any) => low(x.id) === id)) await rpc("workspace.close", { workspace_id: id, force: true }).catch((e) => console.log(String(e)));
const stopped = spawnSync(process.execPath, [join(ROOT, "lib/chat.ts"), "stop"], { env: process.env, encoding: "utf8" }).stdout.trim();
await Bun.sleep(1_000);
const left = (await rpc("workspace.group.list", {})).groups.filter((g: any) => Object.values(groups).includes(g.id)).map((g: any) => g.name);
check("END", "no workspace, group, helper, or server of the test is left", !(await rpc("workspace.list", {})).workspaces.some((w: any) => made.includes(low(w.id))) && left.length === 0 && helpers().length === 0 && /stopped server/.test(stopped), [left, stopped, helpers()]);
const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(OUT, "result.json"), JSON.stringify(hide({ at: new Date().toISOString(), cmux: spawnSync(CMUX, ["--version"], { encoding: "utf8" }).stdout.trim(), port, passed: results.length - failed, failed, metrics, results }), null, 1));
console.log(`${JSON.stringify(hide(metrics))}\n${results.length - failed} passed, ${failed} failed\n${OUT}/result.json`);
process.exit(failed ? 1 : 0);
