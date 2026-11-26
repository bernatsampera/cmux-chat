#!/usr/bin/env bun
// E2E of lib/tabs.ts and of cmux-chat-open --tab and --project, with the real cmux:
// hidden workspaces of its own, a shell in place of claude, a chat server of its own.
// The ways it can fail, written before the code:
// T01 A terminal tab is picked: its page does not follow, or another page does.
// T02 A page tab is picked: its terminal does not follow.
// T03 After a pick the page has the pane focus, not the terminal.
// T04 A loop: the two panes answer each other, or a pick makes many events.
// T05 Fast picks: the panes end on different chats, or an old pick wins.
// T06 A pick changes the order of the tabs.
// T07 It acts in another workspace, in a workspace with one chat page, or the event of one workspace moves another.
// T08 The user loses the focus, or the visible workspace changes.
// T09 A terminal closes: its page stays, or another tab closes, or the panes end on different chats.
// T10 It closes a page that is not ours (another port, host, or path), or a page whose terminal was never seen.
// T11 A terminal that moved to another workspace is taken for a closed one.
// T12 --tab: the page is in the wrong pane, has the address bar, is there twice, or the terminal loses the focus.
// T13 --tab from a tab that is not selected any more pulls the user to it.
// T14 --tab, started while the page pane has the focus (so its terminal is in the top pane).
// T15 --tab blocks or fails the start of the agent: no chat page, no server, cmux hangs.
// T16 Two watchers run, or none after the first chat of a project, or it ends with the terminal that started it.
// T17 The watcher stays when cmux goes away, or it acts on a new cmux with what it knew of the old one. A cmux that is slow for a minute stops it.
// T18 The tabs show "Chat" and not the name of the chat, or the auto-naming of cmux takes the name of the project.
// T19 The modes that were there change: no flag with two pages must refuse.
// T20 The token is in an argv, in the log, or in the event log of cmux.
// T21 The watcher costs CPU when nothing happens.
// T23 A name that the user gives to a page tab or a terminal tab goes away, or the two tabs get different names.
//
// Not here: a real click, a real Claude, and a workspace that the user can see.
//
// Run: bun e2e/tabs.e2e.ts   (in a cmux terminal, needs bin/install first)
// Output: $ORCA_CHAT_E2E_OUT/tabs-<time>/result.json
// It closes only workspaces that it made, by uuid, and stops only its own server and watcher.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, ".."), CMUX = process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux";
const OUT = join(process.env.ORCA_CHAT_E2E_OUT ?? join(tmpdir(), "orca-chat-e2e"), `tabs-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const STATE = join(OUT, "state"), PROJECT = join(OUT, "demo-project");
for (const dir of [STATE, PROJECT, join(OUT, "claude"), join(OUT, "codex")]) mkdirSync(dir, { recursive: true });
spawnSync("git", ["init", "-q", PROJECT]);

const results: { id: string; check: string; ok: boolean; evidence?: unknown }[] = [], metrics: Record<string, unknown> = {};
const hide = (x: unknown) => JSON.parse(JSON.stringify(x ?? null).replace(/[0-9a-f]{64}/gi, "***"));
function check(id: string, name: string, ok: boolean, evidence?: unknown) {
  results.push({ id, check: name, ok, evidence: hide(evidence) });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${ok ? "" : " :: " + JSON.stringify(hide(evidence)).slice(0, 900)}`);
}
async function until<T>(fn: () => T | Promise<T>, ms = 4_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) {
    const value = await fn();
    if (value) return value;
  }
}

const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
// As in lib/tabs.ts, the regular expression for the pages uses this port.
Object.assign(process.env, { ORCA_CHAT_STATE_DIR: STATE, ORCA_CHAT_PORT: String(port), CLAUDE_CONFIG_DIR: join(OUT, "claude"), CODEX_HOME: join(OUT, "codex"), ORCA_CHAT_ORCA: "/nonexistent/orca" });
const { readTabs, selectTab } = await import("../lib/tabs");
type Tab = Awaited<ReturnType<typeof readTabs>>[number];

const slow: string[] = []; // calls that cmux did not answer
async function rpc(method: string, params: object): Promise<any> {
  const p = Bun.spawn([CMUX, "rpc", method, "-"], { stdin: Buffer.from(JSON.stringify(params)), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => (slow.push(method), p.kill(9)), 8_000);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${method}: ${err.trim()}`);
  return JSON.parse(out);
}

// ---- the agent: a script in place of claude ----
const AGENT = join(OUT, "agent.sh");
writeFileSync(AGENT, `#!/usr/bin/env bash
# agent.sh <name> <title> <wait> <mode>...: runs cmux-chat-open with each mode, then waits like an agent.
export ${["ORCA_CHAT_STATE_DIR", "ORCA_CHAT_PORT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "ORCA_CHAT_ORCA"].map((k) => `${k}='${process.env[k]}'`).join(" ")}
name="$1" title="$2"; sleep "$3"; shift 3
for mode in "$@"; do
  from=$(date +%s)
  '${ROOT}/bin/cmux-chat-open' $mode 2>>"${OUT}/$name.err"
  echo "$mode exit $? seconds $(( $(date +%s) - from ))" >>"${OUT}/$name.log"
done
printf '\\033]0;%s\\007' "$title"
echo ready >>"${OUT}/$name.log"
# A later title, as claude does: the test writes it to a file.
( while sleep 1; do [ -f "${OUT}/$name.title" ] && { printf '\\033]0;%s\\007' "$(cat "${OUT}/$name.title")"; break; }; done ) &
exec cat
`);
chmodSync(AGENT, 0o755);
const agent = (name: string, title: string, modes: string[], wait = 0) => `exec ${AGENT} ${name} '${title}' ${wait} ${modes.map((m) => `'${m}'`).join(" ")}`;
const agentLog = (name: string) => (existsSync(join(OUT, `${name}.log`)) ? readFileSync(join(OUT, `${name}.log`), "utf8") : "");
const agentErr = (name: string) => (existsSync(join(OUT, `${name}.err`)) ? readFileSync(join(OUT, `${name}.err`), "utf8") : "");
const ready = (name: string, ms = 25_000) => until(() => agentLog(name).includes("ready"), ms);

// ---- workspaces of our own ----
const made: string[] = [];
async function workspace(command: string, extra: object = {}): Promise<string> {
  const layout = { direction: "vertical", split: 0.85, children: [
    { pane: { surfaces: [{ type: "browser", name: "Chat", url: "data:text/html,empty" }] } },
    { pane: { surfaces: [{ type: "terminal", cwd: PROJECT, command, focus: true }] } },
  ] };
  const r = await rpc("workspace.create", { cwd: PROJECT, focus: false, title: "tabs e2e", title_source: "auto", layout, ...extra });
  made.push(r.workspace_id.toLowerCase());
  return made.at(-1)!;
}
async function newTerminal(ws: string, pane: string, command: string): Promise<string> {
  const p = Bun.spawn([CMUX, "new-surface", "--type", "terminal", "--workspace", ws, "--pane", pane, "--focus", "false", "--id-format", "uuids", "--command", command], { stdout: "pipe", stderr: "pipe" });
  const id = /[0-9a-f-]{36}/i.exec(await new Response(p.stdout).text())?.[0];
  if (!id) throw new Error("no terminal: " + (await new Response(p.stderr).text()));
  return id.toLowerCase();
}
const tabs = (ws: string) => readTabs(rpc, ws);
const closeTab = (ws: string, id: string) => rpc("surface.close", { workspace_id: ws, surface_id: id, force: true });
const pick = async (ws: string, id: string) => selectTab(rpc, (await tabs(ws)).find((t) => t.id === id)!);
const brief = (all: Tab[]) => all.map((t) => `${t.type[0]}${t.id.slice(0, 4)}@${t.pane.slice(0, 2)}${t.chat ? "->" + t.chat.slice(0, 4) : ""}${t.selected ? "*" : ""}${t.focused ? "F" : ""} ${t.title}`);
const order = (all: Tab[]) => all.map((t) => `${t.pane}/${t.id}`).join();
// The state that each pick must end in: terminal and page selected, the terminal has the focus.
const on = (all: Tab[], terminal: string) => {
  const t = all.find((x) => x.id === terminal), p = all.find((x) => x.chat === terminal);
  return Boolean(t?.selected && t.focused && p?.selected && p.pane !== t.pane);
};
async function settles(ws: string, terminal: string, ms = 3_000) {
  const from = Date.now();
  const ok = await until(async () => on(await tabs(ws), terminal), ms);
  return { ok: Boolean(ok), ms: Date.now() - from, want: terminal.slice(0, 4), tabs: brief(await tabs(ws)), events: ok ? undefined : lately(ws) };
}

// ---- what the user sees, all the time ----
const focusOf = async () => (await rpc("system.identify", {})).focused ?? {};
const before = await focusOf(), visited = new Set<string>(), stolen: unknown[] = [];
let watching = true;
const guard = (async () => {
  while (watching) {
    const f = await focusOf().catch(() => null);
    if (f) visited.add(f.workspace_id);
    if (f && made.includes(String(f.workspace_id).toLowerCase())) stolen.push({ at: results.length, f });
    await Bun.sleep(150);
  }
})();

// ---- the events, for the loop checks ----
const events: any[] = [];
const eventsOf = Bun.spawn([CMUX, "events", "--category", "surface", "--reconnect", "--no-heartbeat"], { stdout: "pipe", stderr: "ignore" });
(async () => {
  let rest = "";
  for await (const chunk of eventsOf.stdout) {
    const lines = (rest + new TextDecoder().decode(chunk)).split("\n");
    rest = lines.pop()!;
    for (const l of lines) try { events.push(JSON.parse(l)); } catch {}
  }
})();
const count = (ws: string, from: number) => events.slice(from).filter((e) => String(e.workspace_id).toLowerCase() === ws && /selected|focused|moved/.test(e.name)).length;

const lately = (ws: string) => events.filter((e) => String(e.workspace_id).toLowerCase() === ws && Date.now() - Date.parse(e.occurred_at) < 6_000).map((e) => `${e.occurred_at.slice(17, 23)} ${e.name.slice(8)} ${e.surface_id?.slice(0, 4)}`);
const pgrep = (pattern: string) => spawnSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map(Number);
const watchers = (state = STATE) => pgrep(`lockf.*${state}/tabs.lock`);
const childOf = (pid: number) => Number(spawnSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.trim().split("\n")[0]);
const ps = () => spawnSync("/bin/ps", ["-axww", "-o", "command"], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout;
const eventLog = join(homedir(), ".cmuxterm/events.jsonl"), eventLogFrom = existsSync(eventLog) ? statSync(eventLog).size : 0;
const cleanup: (() => void)[] = [];
let argv = "";

try {
  // ---- T16 T18 the first chat of a project ----
  const ws = await workspace(agent("a", "Alpha chat", ["--project"]));
  const aReady = await ready("a");
  let all = await tabs(ws);
  const [a] = all.filter((t) => t.type === "terminal");
  const bottom = a.pane;
  check("T15", "--project: the agent starts, exit 0", Boolean(aReady) && /exit 0/.test(agentLog("a")) && agentErr("a") === "", [agentLog("a"), agentErr("a")]);
  check("T18", "the workspace has the name of the project, and a person owns it", (await rpc("workspace.list", {})).workspaces.find((w: any) => w.id.toLowerCase() === ws)?.title === "demo-project", (await rpc("workspace.list", {})).workspaces.find((w: any) => w.id.toLowerCase() === ws));
  await until(() => watchers().length === 1);
  check("T16", "the first chat of a project starts the watcher", watchers().length === 1, watchers());
  const watcher = childOf(watchers()[0]);

  // ---- T12 --tab ----
  await Bun.sleep(1_000);
  const b = await newTerminal(ws, bottom, agent("b", "Beta chat", ["--tab"]));
  await ready("b");
  await until(async () => (await tabs(ws)).filter((t) => t.chat).length === 2);
  const c = await newTerminal(ws, bottom, agent("c", "Gamma chat", ["--tab", "--tab"])); // twice: T12
  await ready("c");
  await until(async () => (await tabs(ws)).filter((t) => t.chat).length === 3);
  await Bun.sleep(1_500);
  all = await tabs(ws);
  const top = all.find((t) => t.chat === a.id)!.pane;
  const page = (terminal: string) => all.find((t) => t.chat === terminal)!;
  check("T12", "three chats: three pages in one pane, three terminals in the other, no other tab", all.length === 6 && [a.id, b, c].every((t) => page(t)?.pane === top) && all.filter((t) => t.type === "terminal").every((t) => t.pane === bottom), brief(all));
  check("T12", "--tab two times in one terminal: one page", all.filter((t) => t.chat === c).length === 1, brief(all));
  const chosen = all.find((t) => t.type === "terminal" && t.selected)!;
  check("T12", "after --tab: page and terminal are the same chat, the terminal has the focus", on(all, chosen.id), brief(all));
  check("T15", "--tab: exit 0, no message", /exit 0/.test(agentLog("b")) && agentErr("b") === "" && agentErr("c") === "", [agentLog("b"), agentErr("b"), agentErr("c")]);
  metrics.launchSeconds = { project: agentLog("a"), tab: agentLog("b") };
  const bars = [];
  for (const t of [a.id, b, c]) bars.push(await rpc("browser.eval", { workspace_id: ws, surface_id: page(t).id, script: "window.innerHeight" }).then((r) => r.value ?? r.result ?? r, (e) => String(e)));
  metrics.pageHeights = bars;
  check("T16", "three launches: one watcher", watchers().length === 1 && childOf(watchers()[0]) === watcher, watchers());

  // ---- T18 names ----
  const names = await until(async () => { const x = await tabs(ws); return ["Alpha", "Beta", "Gamma"].every((n) => x.filter((t) => t.title === `${n} chat`).length === 2) && x; }, 12_000);
  check("T18", "each page tab has the name of its terminal tab, which is the title of the agent", Boolean(names), brief(await tabs(ws)));
  const auto = await rpc("workspace.set_auto_title", { workspace_id: ws, title: "Taken by a chat", panel_id: a.id }).catch((e) => String(e));
  check("T18", "the auto-naming of cmux does not take the name of the project", (await rpc("workspace.list", {})).workspaces.find((w: any) => w.id.toLowerCase() === ws)?.title === "demo-project", auto);
  check("T18", "and it skips a workspace with a name of a person", (await rpc("workspace.set_auto_title", { probe: true, workspace_id: ws })).workspace_user_owned === true);

  // ---- T23 names of the user ----
  const rename = (id: string, title: string) => rpc("surface.action", { action: "rename", workspace_id: ws, surface_id: id, title });
  const called = async (terminal: string, title: string) => (await tabs(ws)).filter((t) => (t.id === terminal || t.chat === terminal) && t.title === title).length === 2;
  await Bun.sleep(4_000);
  await rename(page(b).id, "My beta");
  check("T23", "a page tab that the user renames gives its name to the terminal tab", Boolean(await until(() => called(b, "My beta"), 14_000)), brief(await tabs(ws)));
  writeFileSync(join(OUT, "b.title"), "Beta works on it");
  await Bun.sleep(13_000);
  check("T23", "and both keep it when the agent changes its title", await called(b, "My beta"), brief(await tabs(ws)));
  await rename(b, "Beta again");
  check("T23", "a terminal tab that the user renames gives its name to the page tab", Boolean(await until(() => called(b, "Beta again"), 14_000)), brief(await tabs(ws)));
  writeFileSync(join(OUT, "c.title"), "Gamma works on it");
  check("T23", "a chat without a name of the user still follows its agent", Boolean(await until(() => called(c, "Gamma works on it"), 30_000)), brief(await tabs(ws)));
  check("T23", "the other chat does not get a name of this one", (await tabs(ws)).filter((t) => (t.id === a.id || t.chat === a.id) && !/beta|gamma/i.test(t.title)).length === 2, brief(await tabs(ws)));

  // ---- T01 T02 T03 T04 T06 picks ----
  // The events say when cmux did it. A read of the tabs shows it later.
  const times: number[] = [], done: number[] = [], was = order(await tabs(ws));
  const took = (from: number) => { const all = events.slice(from).filter((e) => String(e.workspace_id).toLowerCase() === ws && /selected|focused/.test(e.name)).map((e) => Date.parse(e.occurred_at)); return Math.max(...all) - Math.min(...all); };
  const stat = (all: number[], ms = all.filter(Number.isFinite)) => ({ n: ms.length, min: Math.min(...ms), median: [...ms].sort((x, y) => x - y)[ms.length >> 1], max: Math.max(...ms) });
  for (const t of [a.id, b, c, a.id, c, b]) {
    await Bun.sleep(400);
    const first = events.length;
    await pick(ws, t);
    const r = await settles(ws, t);
    times.push(r.ms), done.push(took(first));
    check("T01 T03", "a terminal tab is picked: its page is selected, the terminal has the focus", r.ok, r);
  }
  for (const t of [a.id, c, b, a.id]) {
    await Bun.sleep(400);
    const first = events.length;
    await pick(ws, page(t).id);
    const r = await settles(ws, t);
    times.push(r.ms), done.push(took(first));
    check("T02 T03", "a page tab is picked: its terminal is selected and has the focus", r.ok, r);
  }
  metrics.pickToPartnerEventsMs = stat(done);
  metrics.pickToShownInReadMs = stat(times);
  check("T06", "the order of the tabs is the same", order(await tabs(ws)) === was, brief(await tabs(ws)));
  await Bun.sleep(1_000);
  let from = events.length;
  await pick(ws, b);
  await settles(ws, b);
  await Bun.sleep(1_500);
  const n = count(ws, from);
  from = events.length;
  await Bun.sleep(6_000);
  metrics.eventsPerPick = n;
  check("T04", "one pick: at most 12 events, then none for 6 seconds", n > 0 && n <= 12 && count(ws, from) === 0, [n, count(ws, from)]);

  // ---- T05 fast picks ----
  let good = 0;
  const fast: unknown[] = [];
  for (let round = 0; round < 8; round++) {
    const rows = [a.id, b, c], list = Array.from({ length: 6 }, (_, i) => rows[(i + round) % 3]), now = await tabs(ws);
    for (const t of list) {
      // As ctrl+tab, or a click on a page tab: the tab only, no wait for the partner.
      const target = round % 2 ? now.find((x) => x.chat === t)! : now.find((x) => x.id === t)!;
      await selectTab(rpc, target);
      await Bun.sleep([0, 60, 120, 250][round >> 1]);
    }
    const r = await settles(ws, list.at(-1)!);
    await Bun.sleep(500);
    const stays = on(await tabs(ws), list.at(-1)!);
    if (r.ok && stays) good++;
    else fast.push({ round, want: list.at(-1)!.slice(0, 4), tabs: r.tabs });
  }
  check("T05", "8 rounds of 6 fast picks: the last pick wins, and both panes show it", good === 8, { good, fast });
  check("T06", "the order is the same after that too", order(await tabs(ws)) === was, brief(await tabs(ws)));

  // ---- T07 other workspaces ----
  const ws2 = await workspace(agent("d", "Delta chat", ["--project"]));
  await ready("d");
  const d = (await tabs(ws2)).find((t) => t.type === "terminal")!;
  const plain = await newTerminal(ws2, d.pane, "exec cat"); // a terminal with no chat
  await Bun.sleep(800);
  from = events.length;
  const still = JSON.stringify(await tabs(ws));
  await pick(ws2, plain);
  await Bun.sleep(700);
  let two = await tabs(ws2);
  check("T07", "one chat page: nothing is selected for it", two.find((t) => t.id === plain)!.selected && two.find((t) => t.chat === d.id)!.selected, brief(two));
  check("T07", "a pick there changes nothing in the first workspace", JSON.stringify(await tabs(ws)) === still && count(ws, from) === 0);
  const e = await newTerminal(ws2, d.pane, agent("e", "Epsilon chat", ["--tab"]));
  await ready("e");
  await Bun.sleep(800);
  await pick(ws2, d.id);
  const rd = await settles(ws2, d.id);
  check("T07", "two chat pages: it works there too", rd.ok, rd);
  check("T07", "and the first workspace is the same", order(await tabs(ws)) === was && on(await tabs(ws), (await tabs(ws)).find((t) => t.type === "terminal" && t.selected)!.id), brief(await tabs(ws)));
  await pick(ws2, plain);
  await Bun.sleep(600);
  two = await tabs(ws2);
  check("T07", "a terminal with no chat stays selected and has the focus", two.find((t) => t.id === plain)!.focused, brief(two));

  // ---- T13 --tab from a tab that is not selected any more ----
  const late = await newTerminal(ws2, d.pane, agent("late", "Late chat", ["--tab"], 2));
  await Bun.sleep(500);
  await pick(ws2, e);
  await settles(ws2, e);
  await ready("late");
  await Bun.sleep(1_500);
  two = await tabs(ws2);
  check("T13", "--tab in a tab that is not selected: the user stays on the chat that is", on(two, e) && two.some((t) => t.chat === late), brief(two));

  // ---- T14 the new tab is made in the page pane ----
  const top2 = two.find((t) => t.chat === d.id)!.pane;
  const high = await newTerminal(ws2, top2, agent("high", "High chat", ["--tab"]));
  await ready("high");
  await until(async () => on(await tabs(ws2), high), 8_000);
  two = await tabs(ws2);
  check("T14", "a chat tab made in the page pane goes to the terminal pane", two.find((t) => t.id === high)?.pane === d.pane && two.find((t) => t.chat === high)?.pane === top2 && on(two, two.find((t) => t.type === "terminal" && t.selected)!.id), brief(two));

  // ---- T10 T11 pages that must stay ----
  const token = readFileSync(join(STATE, "token"), "utf8").trim();
  const add = async (url: string) => String((await rpc("surface.create", { workspace_id: ws, pane_id: top, type: "browser", url, focus: false })).surface_id).toLowerCase();
  const strange = [
    await add("data:text/html,mine"),
    await add(`http://127.0.0.1:${port}/${token}/follow?cmux=${crypto.randomUUID()}`), // never seen
    await add(`http://localhost:${port}/${token}/follow?cmux=${c}`), // another host
    await add(`http://127.0.0.1:${port}/${token}/follow?worktree=id%3Ax`),
  ];
  await Bun.sleep(6_500);
  check("T10", "a page of another kind, of another host, or of a terminal that was never seen stays", (await tabs(ws)).filter((t) => strange.includes(t.id)).length === 4, brief(await tabs(ws)));

  // ---- T09 a terminal closes ----
  await pick(ws, b);
  await settles(ws, b);
  const pc = (await tabs(ws)).find((t) => t.chat === c)!.id;
  from = Date.now();
  await closeTab(ws, c); // not the selected one
  const gone = await until(async () => !(await tabs(ws)).some((t) => t.id === pc), 5_000);
  metrics.closeToPageGoneMs = Date.now() - from;
  all = await tabs(ws);
  check("T09", "a terminal closes: its page closes, the selected chat stays", Boolean(gone) && on(all, b) && [a.id, b].every((t) => all.some((x) => x.chat === t)), brief(all));
  check("T10", "the other pages stay, the one of the closed terminal on another host too", strange.every((id) => all.some((t) => t.id === id)), brief(all));
  for (const id of strange) await closeTab(ws, id);
  await Bun.sleep(1_000);
  const f = await newTerminal(ws, bottom, agent("f", "Phi chat", ["--tab"]));
  await ready("f");
  await Bun.sleep(1_200);
  await pick(ws, f);
  await settles(ws, f);
  const pf = (await tabs(ws)).find((t) => t.chat === f)!.id;
  await closeTab(ws, f); // the selected one
  await until(async () => !(await tabs(ws)).some((t) => t.id === pf), 5_000);
  await Bun.sleep(1_000);
  all = await tabs(ws);
  const now = all.find((t) => t.type === "terminal" && t.selected)!;
  check("T09", "the selected terminal closes: both panes show the same other chat", !all.some((t) => t.id === pf) && on(all, now.id), brief(all));

  // ---- T11 a terminal moves to another workspace and back ----
  const ph = (await tabs(ws2)).find((t) => t.chat === high)!.id;
  await rpc("surface.move", { surface_id: high, workspace_id: ws, pane_id: bottom, focus: false });
  await Bun.sleep(6_500);
  check("T11", "a terminal that moved to another workspace: its page stays", (await tabs(ws2)).some((t) => t.id === ph), brief(await tabs(ws2)));
  await rpc("surface.move", { surface_id: high, workspace_id: ws2, pane_id: d.pane, focus: false });
  await Bun.sleep(1_000);
  await pick(ws2, d.id);
  await settles(ws2, d.id);
  await pick(ws2, high);
  const rh = await settles(ws2, high);
  check("T11", "back again: it is paired again", rh.ok, rh);

  // ---- T15 T19 the launcher ----
  const ws3 = await workspace(agent("none", "No chat", ["--tab"]));
  await ready("none");
  let three = await tabs(ws3);
  check("T15", "--tab with no chat page: a message, exit 0, nothing was added", /exit 0/.test(agentLog("none")) && /no chat page/.test(agentErr("none")) && three.length === 2, [agentErr("none"), brief(three)]);
  const old = await newTerminal(ws, bottom, agent("old", "Old mode", ["", "--new"]));
  await ready("old");
  check("T19", "no flag and --new with more than one page: they refuse as before", (agentErr("old").match(/needs exactly one/g) ?? []).length === 2 && !(await tabs(ws)).some((t) => t.chat === old), agentErr("old"));
  const fake = join(OUT, "fake");
  mkdirSync(fake, { recursive: true });
  const env = { ...process.env, CMUX_WORKSPACE_ID: ws, CMUX_SURFACE_ID: a.id, CMUX_BUNDLED_CLI_PATH: join(fake, "hang") } as Record<string, string>;
  writeFileSync(join(fake, "hang"), "#!/bin/bash\nexec sleep 120\n");
  chmodSync(join(fake, "hang"), 0o755);
  for (const mode of ["--tab", "--project"]) {
    const at = Date.now(), x = spawn(join(ROOT, "bin/cmux-chat-open"), [mode], { env, stdio: "ignore" });
    const code = await new Promise((r) => x.once("exit", r));
    check("T15", `${mode} when cmux hangs: exit 0 in 17 seconds`, code === 0 && Date.now() - at < 17_000, [code, Date.now() - at]);
  }

  // ---- T16 the watcher and the terminal that started it ----
  const keep = (await tabs(ws)).find((t) => t.type === "terminal" && t.id !== a.id && (t.id === b))!.id;
  await closeTab(ws, a.id);
  await Bun.sleep(2_000);
  check("T16", "the terminal that started the watcher closes: the watcher is the same process", watchers().length === 1 && childOf(watchers()[0]) === watcher && spawnSync("/bin/ps", ["-o", "ppid=,tty=", "-p", String(watchers()[0])], { encoding: "utf8" }).stdout.trim().split(/\s+/).join() === "1,??", [keep.slice(0, 4), watchers(), watcher]);
  await pick(ws2, d.id);
  const ra = await settles(ws2, d.id);
  check("T16", "and it still works", ra.ok, ra);

  // ---- T21 cost ----
  const cpu = (pid: number) => { const [m, s] = spawnSync("/bin/ps", ["-o", "cputime=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().split(":"); return Number(m) * 60 + Number(s); };
  const c0 = cpu(watcher), b0 = Date.now();
  argv += ps();
  await Bun.sleep(20_000);
  metrics.watcherCpuPercentIdle = Math.round(((cpu(watcher) - c0) / ((Date.now() - b0) / 1000)) * 10000) / 100;
  check("T21", "under 2 percent of a core when nothing happens (its own process)", (metrics.watcherCpuPercentIdle as number) < 2, metrics.watcherCpuPercentIdle);

  // ---- T17 cmux goes away: a CLI that can fail ----
  const up = join(fake, "up"), bootFile = join(fake, "boot");
  writeFileSync(up, "");
  writeFileSync(join(fake, "cmux"), `#!/bin/bash
# The real cmux while the file is there. The event stream stays open, as --reconnect does.
if [ "$1" = events ]; then
  if [ -e '${bootFile}' ]; then echo '{"type":"ack","boot_id":"one"}'; while [ -e '${bootFile}' ]; do sleep 0.2; done; echo '{"type":"ack","boot_id":"two"}'; exec sleep 600; fi
  exec '${CMUX}' "$@"
fi
[ -e '${up}' ] || { echo 'Error: no socket' >&2; exit 1; }
exec '${CMUX}' "$@"
`);
  chmodSync(join(fake, "cmux"), 0o755);
  const run = async (state: string) => {
    mkdirSync(state, { recursive: true });
    const log = openSync(join(state, "out.log"), "a", 0o600);
    const x = spawn("/usr/bin/lockf", ["-k", "-s", "-t", "0", join(state, "tabs.lock"), process.execPath, join(ROOT, "lib/tabs.ts")], { env: { ...process.env, ORCA_CHAT_STATE_DIR: state, CMUX_BUNDLED_CLI_PATH: join(fake, "cmux") }, stdio: ["ignore", log, log] });
    const end = { at: 0, child: x };
    x.once("exit", () => (end.at = Date.now()));
    cleanup.push(() => { if (!end.at && x.pid) { const k = childOf(x.pid); if (k) process.kill(k); } });
    await Bun.sleep(3_000);
    return end;
  };
  const w1 = await run(join(OUT, "state-gone"));
  check("T17", "with a cmux that answers it stays", w1.at === 0, readFileSync(join(OUT, "state-gone/out.log"), "utf8"));
  const down = Date.now();
  renameSync(up, up + ".off");
  await until(() => w1.at, 160_000);
  metrics.cmuxGoneToExitMs = w1.at ? w1.at - down : -1;
  check("T17", "cmux does not answer: it ends by itself in 150 seconds", w1.at > 0 && w1.at - down < 150_000, readFileSync(join(OUT, "state-gone/out.log"), "utf8"));
  renameSync(up + ".off", up);
  writeFileSync(bootFile, "");
  const w2 = await run(join(OUT, "state-boot"));
  const stays = w2.at === 0;
  renameSync(bootFile, bootFile + ".off");
  await until(() => w2.at, 5_000);
  check("T17", "another cmux: it ends at once", stays && w2.at > 0, readFileSync(join(OUT, "state-boot/out.log"), "utf8"));
  await Bun.sleep(500);
  check("T17", "and no event reader of it is left", !ps().split("\n").some((l) => l.includes(join(fake, "cmux")) && l.includes("events")), ps().split("\n").filter((l) => l.includes(fake)));

  // ---- T20 the token ----
  argv += ps();
  const logs = [readFileSync(join(STATE, "tabs.log"), "utf8"), ...["a", "b", "c", "none", "old"].map(agentErr)].join("\n");
  const newEvents = existsSync(eventLog) && statSync(eventLog).size >= eventLogFrom ? readFileSync(eventLog).subarray(eventLogFrom).toString() : "";
  // The tabs of T10 are ours: this test made them with the URL. They are not a part of it.
  const leaks = newEvents.split("\n").filter((l) => l.includes(token) && !l.includes("surface.create"));
  check("T20", "the token is in no argv, no log of the watcher, and no event of cmux", !argv.includes(token) && !logs.includes(token) && leaks.length === 0, { argv: argv.includes(token), logs: logs.includes(token), events: leaks.map((l) => l.slice(0, 300)) });
  metrics.eventLogBytesChecked = newEvents.length;
  metrics.watcherLog = logs.split("\n").slice(0, 20);
} catch (err: any) {
  check("ERR", "the test ran to its end", false, err?.stack ?? String(err));
}

// ---- the end: only what is ours ----
watching = false;
await guard;
const after = await focusOf();
check("T08", "the user never had one of these workspaces in front", stolen.length === 0, stolen);
metrics.callsThatCmuxDidNotAnswer = slow;
metrics.focus = { before: { workspace: before.workspace_id, surface: before.surface_id }, after: { workspace: after.workspace_id, surface: after.surface_id }, workspacesSeen: [...visited] };
for (const fn of cleanup) fn();
for (const pid of watchers()) { const k = childOf(pid); if (k) process.kill(k); }
for (const id of made) {
  const w = (await rpc("workspace.list", {})).workspaces.find((x: any) => x.id.toLowerCase() === id);
  if (w) await rpc("workspace.close", { workspace_id: id, force: true }).catch((e) => console.log(String(e)));
}
const stopped = spawnSync(process.execPath, [join(ROOT, "lib/chat.ts"), "stop"], { env: process.env, encoding: "utf8" }).stdout.trim();
await Bun.sleep(1_000);
check("END", "no workspace, watcher, or server of the test is left", !(await rpc("workspace.list", {})).workspaces.some((w: any) => made.includes(w.id.toLowerCase())) && watchers().length === 0 && /stopped server|no server/.test(stopped), [stopped, watchers()]);
eventsOf.kill();
const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(OUT, "result.json"), JSON.stringify(hide({ at: new Date().toISOString(), cmux: spawnSync(CMUX, ["--version"], { encoding: "utf8" }).stdout.trim(), port, passed: results.length - failed, failed, metrics, results }), null, 1));
console.log(`${JSON.stringify(hide(metrics))}\n${results.length - failed} passed, ${failed} failed\n${OUT}/result.json`);
process.exit(failed ? 1 : 0);
