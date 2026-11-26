#!/usr/bin/env bun
// E2E of cmux/move-chats and cmux/move-one (lib/move.ts).
//
// Ways it can fail (written before the code).
//
// The wrong process gets a signal
//   S01 The pid is undefined, NaN, 0, 1, negative, or a string: the signal goes to a process group.
//   S02 A reused pid: the session file is old, another program has the pid.
//   S03 The start time differs (reused by another claude): it is signaled, or it counts as gone and is resumed twice.
//   S04 The session id moved to another process between the read and the signal (/clear, resume, exit).
//   S05 A process in cmux, or with no ORCA_PANE_KEY, is signaled.
//   S06 A nested or background claude, or a program that is not claude, is signaled.
//   S07 More than one live process has the session: it picks one.
//   S08 SIGKILL, or the process group, is used. A neighbor or a child of the target gets the signal.
//   S09 The test guard (ORCA_CHAT_MOVE_ONLY_PIDS) widens, or an empty value means "all".
//   S10 Text in argv that looks like ORCA_PANE_KEY counts as the variable.
// Work is lost
//   W01 busy, shell, waiting, or an unknown or missing status is stopped.
//   W02 The status changes from idle to busy between Enter and the signal.
//   W03 A Bash tool process or caffeinate is a child, but the status says idle.
//   W04 The folder or the transcript is gone, or claude is not on PATH, and this is found after the signal.
//   W05 The process does not stop in 15 s, and it is resumed anyway (two writers of one transcript) or killed.
//   W06 The message says "nothing was changed" after the signal was sent.
//   W07 Something else starts the session again after the stop, and it is resumed anyway.
//   W08 Typed text and then Enter, or an end of input, counts as "move".
//   W09 A refusal ends the program, so Enter cannot try again.
//   W10 Ctrl-C stops the old chat.
// The resume is wrong
//   R01 It resumes in a folder where Claude cannot find the conversation (the chat did cd).
//   R02 It resumes another session id, or a new session.
//   R03 A flag is lost, a flag that is not in the list stays, or a word of the first prompt becomes a flag.
//   R04 The flags are not printed before Enter, or they change after they were printed.
//   R05 After a slow stop and a second Enter, the flags are gone.
//   R06 cmux-chat-open runs before the stop, after claude, or its failure stops claude.
//   R07 The folder has spaces, quotes, or a leading dash.
//   R08 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN is not set.
// The list is wrong
//   L01 It uses the file time, a sidechain, a meta entry, or a tool file: old chats count, or new chats do not.
//   L02 A chat in cmux, with no pane, with another kind, or of a dead process is listed.
//   L03 A title has control characters (escape codes in the terminal, an option for cmux).
//   L04 A worktree outside the projects has no group. ACME gets the chats of ACME/backend (not the longest prefix).
//   L05 "acme" is a prefix of "acme-x" as text: a wrong project. A comment line counts as a project.
//   L06 Bad options are ignored.
// cmux is wrong
//   C01 A dry run makes something. It runs outside cmux.
//   C02 A second run makes the workspaces again. A renamed workspace, or one in another window, counts as missing.
//   C03 cmux does not answer the list, and it makes duplicates.
//   C04 One failure stops the others, or looks like success.
//   C05 A chat goes to a group with a name that is only similar, or the missing group is silent.
//   C06 The layout is not the layout of cmux.json, or the focus moves.
//   C07 The order is not most recent first, or --last is ignored.
//   C08 Something is closed, deleted, or typed into.
// The test itself
//   T01 The test signals a process that is not its own child, or reads the real ~/.claude, state, cmux, or Orca.
//   T02 A fake stays alive after the test.
//
// Not possible to test here: the few milliseconds between the last read and the signal (W02, S04). R06 of a real
// cmux, and the real keyboard focus (C06). S01 is tested with bad session files, and by reading the source.
// Run: bun e2e/move.e2e.ts. Output: $ORCA_CHAT_E2E_OUT/move-<time>/result.json, events.jsonl (signals and resumes), cmux.json.
// Every fake is a child of this test. ORCA_CHAT_MOVE_ONLY_PIDS holds at most one pid, and step() checks its parent first.
import { config } from "../lib/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, ".."), OUT = join(process.env.ORCA_CHAT_E2E_OUT ?? tmpdir(), "move-" + new Date().toISOString().replace(/[:.]/g, "-"));
const HOME = join(OUT, "home"), CLAUDE = join(OUT, "claude-config"), STATE = join(OUT, "state"), BIN = join(OUT, "bin"), LIVE = join(OUT, "live"), NOCLAUDE = join(OUT, "bin-no-claude");
const EVENTS = join(OUT, "events.jsonl"), DB = join(OUT, "cmux.json"), WORK = join(OUT, "it's a work dir");
for (const d of [HOME, join(CLAUDE, "sessions"), join(CLAUDE, "projects"), STATE, BIN, LIVE, NOCLAUDE, WORK]) mkdirSync(d, { recursive: true });
const results: any[] = [];
const check = (id: string, name: string, ok: unknown, info?: unknown) => { results.push({ id, name, ok: !!ok, info }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${ok ? "" : " :: " + JSON.stringify(info)?.slice(0, 900)}`); };
const until = async (fn: () => unknown, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(30)) if (fn()) return true; return false; };
const ps = (pid: number, field: string) => spawnSync("/bin/ps", ["-ww", "-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC0" } }).stdout.trim();
const events = (): any[] => (existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const realPaths = [".claude/settings.json", ".local/state/orca-chat"].map((p) => join(homedir(), p)), snap = () => realPaths.map((p) => (existsSync(p) ? statSync(p).mtimeMs : 0)).join();
const realBefore = snap();

// ---- fakes: one program. live: waits and logs SIGTERM. Else: logs how it was started (the resumed claude). ----
writeFileSync(join(OUT, "fake.js"), `const fs=require("fs"),note=(o)=>fs.appendFileSync(${JSON.stringify(EVENTS)},JSON.stringify({pid:process.pid,...o})+"\\n");
const role=process.env.FAKE_ROLE;
if(!role){note({resumed:process.argv.slice(2),cwd:process.cwd(),alt:process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN??null});process.exit(0)}
process.stdin.on("end",()=>process.exit(0)).resume();setInterval(()=>{if(process.env.FAKE_QUIT&&fs.existsSync(process.env.FAKE_QUIT))process.exit(0)},300);
process.on("SIGTERM",()=>{note({term:role});if(role==="stubborn")return;if(role==="handover")fs.writeFileSync(process.env.FAKE_FILE,process.env.FAKE_JSON);if(role!=="child")process.exit(143)});
if(process.env.FAKE_CHILD)require("child_process").spawn(process.env.FAKE_CHILD_EXE,process.env.FAKE_CHILD.split(" "),{env:{FAKE_ROLE:"child"},stdio:["pipe","ignore","ignore"]});
note({up:role});`);
const built = spawnSync(process.execPath, ["build", "--compile", join(OUT, "fake.js"), "--outfile", join(BIN, "claude")], { encoding: "utf8" });
if (built.status !== 0) throw Error(built.stderr);
for (const name of ["live/claude", "live/vim", "live/mcp", "live/caffeinate"]) copyFileSync(join(BIN, "claude"), join(OUT, name)), chmodSync(join(OUT, name), 0o755);
writeFileSync(DB, JSON.stringify({ mode: "", calls: [], groups: [{ id: "G-ACME", ref: "workspace_group:1", name: "ACME" }, { id: "G-BACK", ref: "workspace_group:2", name: "ACME/backend" }, { id: "G-BACK2", name: "ACME/backend-2" }], workspaces: { W1: [], W2: [] } }));
writeFileSync(join(BIN, "cmux"), `#!${process.execPath}
const fs=require("fs"),F=${JSON.stringify(DB)},d=JSON.parse(fs.readFileSync(F)),a=process.argv.slice(2),v=(k)=>a[a.indexOf(k)+1];d.calls.push(a);let out="",code=0;
if(a[0]==="list-windows")out=JSON.stringify([{id:"W1"},{id:"W2"}]);
else if(a[0]==="workspace"&&a[1]==="list"){if(d.mode==="nolist"){code=1;console.error("Access denied")}else out=JSON.stringify({workspaces:d.workspaces[v("--window")]})}
else if(a[0]==="workspace-group")out=JSON.stringify({groups:d.groups});
else if(a[0]==="new-workspace"&&d.mode==="bad"&&v("--name").includes("Second")){code=1;console.error("no \\u001b[31m space")}
else if(a[0]==="new-workspace"){d.workspaces.W1.push({title:v("--name"),description:v("--description"),group:a.includes("--group")?v("--group"):null,cwd:v("--cwd"),layout:JSON.parse(v("--layout")),focus:v("--focus")});out="OK workspace:"+d.workspaces.W1.length}
else{fs.appendFileSync(${JSON.stringify(EVENTS)},JSON.stringify({cmux:a})+"\\n");code=1}
fs.writeFileSync(F,JSON.stringify(d,null,1));if(out)console.log(out);process.exit(code)`);
writeFileSync(join(BIN, "orca"), `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(EVENTS)},JSON.stringify({orca:process.argv.slice(2)})+"\\n");console.log(JSON.stringify({ok:true,result:{truncated:false,terminals:JSON.parse(require("fs").readFileSync(${JSON.stringify(join(OUT, "orca.json"))}))}}))`);
for (const f of ["cmux", "orca"]) { chmodSync(join(BIN, f), 0o755); copyFileSync(join(BIN, f), join(NOCLAUDE, f)); }
writeFileSync(join(OUT, "orca.json"), "[]");
const uuid = () => crypto.randomUUID();
const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children) if (c.pid && c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); }); // own children only

// ---- one fake chat ----
const enc = (d: string) => d.replace(/[^a-zA-Z0-9]/g, "-");
function transcript(id: string, dir: string, lines: any[]) { const p = join(CLAUDE, "projects", enc(dir)); mkdirSync(p, { recursive: true }); writeFileSync(join(p, `${id}.jsonl`), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join("")); return join(p, `${id}.jsonl`); }
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const msg = (h: number, extra = {}) => ({ type: "user", timestamp: ago(h), cwd: WORK, message: { role: "user", content: "hi" }, ...extra });
interface Opt { role?: string; exe?: string; args?: string[]; env?: Record<string, string>; live?: any; dir?: string; title?: string; id?: string; lines?: any[]; noTranscript?: boolean; leaf?: string }
async function fake(o: Opt = {}) {
  const id = o.id ?? uuid(), leaf = o.leaf ?? uuid(), dir = o.dir ?? WORK;
  const c = spawn(join(LIVE, o.exe ?? "claude"), o.args ?? ["--dangerously-skip-permissions"], { env: { FAKE_ROLE: o.role ?? "live", ORCA_PANE_KEY: `${uuid()}:${leaf}`, FAKE_CHILD_EXE: "", ...o.env } as any, stdio: ["pipe", "ignore", "ignore"], detached: true, cwd: OUT });
  children.push(c);
  const pid = c.pid!;
  await until(() => events().some((e) => e.pid === pid && e.up));
  const file = join(CLAUDE, "sessions", `${pid}.json`);
  const live = (extra = {}) => { writeFileSync(file + ".tmp", JSON.stringify({ pid, sessionId: id, cwd: dir, kind: "interactive", status: "idle", procStart: ps(pid, "lstart"), ...o.live, ...extra })); renameSync(file + ".tmp", file); };
  live();
  if (!o.noTranscript) transcript(id, dir, o.lines ?? [msg(1), { type: "ai-title", aiTitle: o.title ?? "A chat" }]);
  return { id, pid, live, file, c, alive: () => c.exitCode === null && c.signalCode === null };
}
const base = { HOME, PATH: `${BIN}:${join(homedir(), ".bun/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, CLAUDE_CONFIG_DIR: CLAUDE, ORCA_CHAT_STATE_DIR: STATE, ORCA_CHAT_DATA_DIR: join(OUT, "data"), ORCA_CLI_BIN_DIR: BIN, CMUX_WORKSPACE_ID: uuid(), CMUX_SURFACE_ID: uuid(), CMUX_BUNDLED_CLI_PATH: join(BIN, "cmux"), CMUX_CHAT_PROJECTS: join(OUT, "projects.txt") };
// Starts move-one. The only pid that it may signal is checked to be a child of this test.
function step(id: string, target: number | null, env: Record<string, string> = {}) {
  if (target !== null && (!Number.isSafeInteger(target) || target <= 1 || Number(ps(target, "ppid")) !== process.pid)) throw Error(`T01: ${target} is not a child of this test`);
  const c = spawn(join(ROOT, "cmux/move-one"), [id], { env: { ...base, ORCA_CHAT_MOVE_ONLY_PIDS: target === null ? "" : String(target), ...env }, cwd: OUT, stdio: ["pipe", "pipe", "pipe"] });
  children.push(c);
  let err = "";
  c.stderr!.on("data", (d) => (err += d));
  const asks = () => err.split("Press Enter").length - 1;
  return { text: () => err, code: () => c.exitCode, ready: (n = 1, ms = 8000) => until(() => asks() >= n || c.exitCode !== null, ms), type: (s: string) => c.stdin!.write(s), end: async () => { c.stdin!.end(); await until(() => c.exitCode !== null); },
    async enter(ms = 8000) { const n = asks(); c.stdin!.write("\n"); await until(() => asks() > n || c.exitCode !== null, ms); await Bun.sleep(80); return err; } };
}
const resumed = (id: string) => events().filter((e) => e.resumed?.includes(id)), termed = (pid: number) => events().filter((e) => e.pid === pid && e.term).length;
// One chat that must be refused: no signal, no resume, and Enter can try again.
async function refused(code: string, name: string, pattern: RegExp, f: Awaited<ReturnType<typeof fake>>, env: Record<string, string> = {}, target: number | null = f.pid) {
  const s = step(f.id, target, env); await s.ready(); await s.enter(); const text = await s.enter();
  check(code, name, pattern.test(text) && text.includes("Nothing was changed") && s.code() === null && f.alive() && !termed(f.pid) && !resumed(f.id).length, { text, alive: f.alive(), code: s.code() });
  await s.end();
}

// ---- move-one: the good case, with all flags, a child, and a neighbor ----
const neighbor = await fake();
const good = await fake({ title: "Good \u001b[31mchat\u0007", args: ["--dangerously-skip-permissions", "--dangerously-skip-permissions", "--model", "opus[1m]", "--allowed-tools", "Bash(ls:*)", "--effort=high", "--permission-mode", "plan", "--resume", uuid()], env: { FAKE_CHILD: "serve --transport http-only", FAKE_CHILD_EXE: join(LIVE, "mcp") } });
await until(() => events().some((e) => e.up === "child"));
let s = step(good.id, good.pid);
await s.ready();
let text = s.text();
check("R04", "title, folder, and flags are printed before Enter, nothing happened", text.includes("Good [31mchat") && !text.includes("\u001b") && text.includes(WORK) && text.includes("Flags: --dangerously-skip-permissions --model opus[1m] --effort high --permission-mode plan (not kept: --allowed-tools)") && good.alive() && !resumed(good.id).length, text);
await s.enter();
await until(() => resumed(good.id).length);
const child = events().find((e) => e.up === "child")?.pid;
check("S08", "one SIGTERM to the target, none to its child or its neighbor", termed(good.pid) === 1 && good.c.exitCode === 143 && !termed(child) && !termed(neighbor.pid) && neighbor.alive(), events().filter((e) => e.term));
check("R02 R03 R08", "it resumes the same id, only the four flags, with no alternate screen", JSON.stringify(resumed(good.id).map((e) => [e.resumed, e.alt])) === JSON.stringify([[["--resume", good.id, "--dangerously-skip-permissions", "--model", "opus[1m]", "--effort", "high", "--permission-mode", "plan"], "1"]]), resumed(good.id));
check("R07", "in a folder with spaces and a quote", resumed(good.id)[0]?.cwd === WORK, resumed(good.id));
const order = events(), at = (f: (e: any) => boolean) => order.findIndex(f);
check("R06", "order: SIGTERM, cmux-chat-open (it fails), claude", at((e) => e.pid === good.pid && e.term) < at((e) => e.cmux?.[1] === "surface.list") && at((e) => e.cmux?.[1] === "surface.list") < at((e) => e.resumed), order.slice(-4));
s = step(neighbor.id, neighbor.pid); await s.ready();
check("R03", "a chat with one flag keeps one flag", s.text().includes("Flags: --dangerously-skip-permissions\n"), s.text()); await s.end();
check("W08", "the end of the input does not move", neighbor.alive() && !resumed(neighbor.id).length && s.code() === 1, s.code());
s = step(neighbor.id, neighbor.pid); await s.ready(); s.type("fix the bug\n"); await s.ready(2);
check("W08", "text and then Enter does not move", /text before Enter/.test(s.text()) && neighbor.alive(), s.text()); await s.end();

const eof = await fake({ live: { status: "busy" } }); s = step(eof.id, eof.pid); await s.ready(); await s.enter(); eof.live(); await s.enter(); await s.end();
check("W08", "Enter, a refusal, then the end of the input does not move", eof.alive() && !termed(eof.pid) && !resumed(eof.id).length && s.code() === 1, s.text());
// ---- refusals ----
for (const [status, want] of [["busy", /"busy"/], ["shell", /"shell"/], ["waiting", /"waiting"/], ["later", /"later"/], [undefined, /"unknown"/], ["Idle", /"Idle"/]] as const) await refused("W01", `status ${status}`, want, await fake({ live: { status } }));
await refused("S02 S03", "another start time", /start time/, await fake({ live: { procStart: "Mon Jan  1 00:00:00 2024" } }));
await refused("S03", "no start time", /start time/, await fake({ live: { procStart: undefined } }));
for (const pid of [0, -1, 1, null, "x"]) await refused("S01", `the session file says pid ${pid}`, /not an interactive Claude/, await fake({ live: { pid } }));
await refused("S05", "no pane key", /not in an Orca pane/, await fake({ env: { ORCA_PANE_KEY: "" } }));
await refused("S05", "it runs in cmux", /cmux already/, await fake({ env: { CMUX_SURFACE_ID: uuid() } }));
await refused("S10", "the pane key is only text in argv, two values", /not in an Orca pane/, await fake({ args: [`ORCA_PANE_KEY=a:${uuid()}`] }));
await refused("S06", "a background claude", /not an interactive/, await fake({ live: { kind: "bg" } }));
for (const only of ["", "1", "0", "-1", "999999"]) await refused("S09", `the guard "${only}" lets no pid through`, /ORCA_CHAT_MOVE_ONLY_PIDS/, await fake(), { ORCA_CHAT_MOVE_ONLY_PIDS: only }, null);
const twin = await fake(); await fake({ id: twin.id });
await refused("S07", "two processes", /2 live processes/, twin);
const half = await fake(); writeFileSync(half.file, '{"pid":');
await refused("W05", "a half written session file is not \"no process\"", /not an interactive/, half); half.live({ sessionId: uuid() });
const argvOnly = uuid(), hidden = await fake({ id: argvOnly, args: ["--resume", argvOnly] });
renameSync(hidden.file, join(OUT, "moved-session.json"));
await refused("W05", "no session file, but a claude has the id in argv", /not an interactive/, hidden);
const shellChild = await fake({ env: { FAKE_CHILD: "-c /x/shell-snapshots/snap.sh", FAKE_CHILD_EXE: join(LIVE, "mcp") } }); await until(() => ps(shellChild.pid, "pid") && spawnSync("/usr/bin/pgrep", ["-P", String(shellChild.pid)]).status === 0);
await refused("W03", "a Bash tool child", /runs a command/, shellChild);
const caf = await fake({ env: { FAKE_CHILD: "-i", FAKE_CHILD_EXE: join(LIVE, "caffeinate") } }); await until(() => spawnSync("/usr/bin/pgrep", ["-P", String(caf.pid)]).status === 0);
await refused("W03", "caffeinate", /runs a command/, caf);
await refused("W04", "no transcript", /no transcript/, await fake({ noTranscript: true }));
await refused("W04", "the folder is gone", /folder is gone/, await fake({ dir: join(OUT, "gone") }));
await refused("W04", "claude is not on PATH", /claude is not on PATH/, await fake(), { PATH: base.PATH.replace(BIN, NOCLAUDE) });
const two = await fake(); transcript(two.id, OUT, [msg(1)]);
await refused("R01", "two transcripts", /more than one transcript/, two);
await refused("R01", "no known folder fits the transcript", /folder of this chat is not known/, await fake({ live: { cwd: "/tmp/other" }, lines: [msg(1, { cwd: "/tmp/third" })] }));

// ---- retry, changes, slow stop ----
const retry = await fake({ live: { status: "busy" } });
s = step(retry.id, retry.pid); await s.ready(); await s.enter(); const no = s.text();
retry.live({ status: "idle" }); await s.enter(); const look = s.text(); const stillUp = retry.alive(); await s.enter(); await until(() => resumed(retry.id).length);
check("W09 R04", "busy, then idle: the first Enter shows the flags, the next one moves", /"busy"/.test(no) && /look at the lines above/.test(look) && stillUp && termed(retry.pid) === 1 && resumed(retry.id).length === 1, s.text());
const turn = await fake(); s = step(turn.id, turn.pid); await s.ready(); turn.live({ status: "busy" }); await s.enter();
check("W02", "idle at the print, busy at Enter", /"busy"/.test(s.text()) && turn.alive(), s.text()); await s.end();
const cleared = await fake(); s = step(cleared.id, cleared.pid); await s.ready(); cleared.live({ sessionId: uuid() }); await s.enter(); text = s.text(); const pids = termed(cleared.pid); await s.end();
check("S04", "after /clear the process is not signaled, and nothing resumes before a new look", pids === 0 && cleared.alive() && !resumed(cleared.id).length && /No process has this chat now/.test(text) && /look at the lines above/.test(text), text);
const moved = await fake({ live: { cwd: "/tmp" } }); s = step(moved.id, moved.pid); await s.ready(); await s.enter(); await until(() => resumed(moved.id).length);
check("R01", "the chat did cd: it resumes in the folder of the transcript", resumed(moved.id)[0]?.cwd === WORK && termed(moved.pid) === 1, resumed(moved.id));
const prompt = await fake({ args: ["--model", "opus", "fix", "--dangerously-skip-permissions", "now"] }); s = step(prompt.id, prompt.pid); await s.ready();
check("R03", "a word of the first prompt is not a flag", s.text().includes("Flags: --model opus\n"), s.text()); await s.end();
const quit = join(OUT, "quit-now"), slow = await fake({ role: "stubborn", env: { FAKE_QUIT: quit }, args: ["--model", "haiku"] });
s = step(slow.id, slow.pid); await s.ready(); const t0 = Date.now(); await s.enter(25_000); const took = Date.now() - t0;
check("W05 W06", "it does not stop: 15 s, a clear message, no resume, no SIGKILL", took > 14_000 && took < 22_000 && /still runs after 15 seconds/.test(s.text()) && !s.text().includes("Nothing was changed") && slow.alive() && !resumed(slow.id).length, { took, text: s.text() });
slow.live({ sessionId: uuid() }); await s.enter();
check("W05", "Enter again, its session file says nothing now: no resume, no second signal", /still runs/.test(s.text()) && termed(slow.pid) === 1 && !resumed(slow.id).length, s.text());
writeFileSync(quit, ""); await until(() => !slow.alive()); await s.enter(); await until(() => resumed(slow.id).length);
check("R05", "Enter after it stopped: it resumes with its flags", resumed(slow.id)[0]?.resumed.join(" ") === `--resume ${slow.id} --model haiku`, { r: resumed(slow.id), t: s.text() });
const other = await fake(), hand = await fake({ role: "handover", env: { FAKE_FILE: other.file, FAKE_JSON: "{}" } }); other.c.unref();
const hand2 = await fake({ role: "handover", id: uuid(), env: { FAKE_FILE: other.file, FAKE_JSON: JSON.stringify({ pid: other.pid, sessionId: hand.id, kind: "interactive", status: "idle" }) } });
hand2.live({ sessionId: hand.id }); hand.live({ sessionId: uuid() });
s = step(hand.id, hand2.pid); await s.ready(); await s.enter();
check("W07", "another process has the chat after the stop: no resume", /another process has this chat now/.test(s.text()) && termed(hand2.pid) === 1 && !resumed(hand.id).length && other.alive(), s.text()); await s.end();
const dead = uuid(); transcript(dead, WORK, [msg(1)]);
const vim = await fake({ exe: "vim", noTranscript: true, id: dead });
s = step(dead, null); await s.ready(); await s.enter(); await until(() => resumed(dead).length);
check("S02 S06", "the pid belongs to another program: it only resumes, no signal", /No process has this chat now/.test(s.text()) && resumed(dead)[0]?.resumed.join(" ") === `--resume ${dead}` && vim.alive() && !termed(vim.pid), s.text());
for (const bad of ["", "x", "../x", "--go", "1;ls"]) { const r = spawnSync(join(ROOT, "cmux/move-one"), [bad], { env: { ...base, ORCA_CHAT_MOVE_ONLY_PIDS: "" }, encoding: "utf8" }); check("R02", `bad id "${bad}"`, r.status === 1 && /usage/.test(r.stderr), r.stderr); }
const out1 = spawnSync(join(ROOT, "cmux/move-one"), [neighbor.id], { env: { ...base, CMUX_WORKSPACE_ID: "", ORCA_CHAT_MOVE_ONLY_PIDS: "" }, encoding: "utf8" });
check("C01", "move-one outside cmux", out1.status === 1 && /inside cmux/.test(out1.stderr), out1.stderr);

// ---- a real terminal (private tmux): Ctrl-C, then Enter ----
const tty = async (f: Awaited<ReturnType<typeof fake>>, key: string) => {
  if (Number(ps(f.pid, "ppid")) !== process.pid) throw Error("T01");
  const sock = `move-e2e-${process.pid}-${key}`, log = join(OUT, `tty-${key}.txt`), env = { ...base, ORCA_CHAT_MOVE_ONLY_PIDS: String(f.pid), TERM: "xterm-256color" } as any;
  const tmux = (...a: string[]) => spawnSync("/opt/homebrew/bin/tmux", ["-L", sock, "-f", "/dev/null", ...a], { env, encoding: "utf8" });
  tmux("new-session", "-d", "-x", "150", "-y", "20", `/bin/bash -c '"${join(ROOT, "cmux/move-one")}" ${f.id}; echo "code $?" >> "${log}"'`);
  let pane = "";
  await until(() => (pane = tmux("capture-pane", "-p").stdout).includes("Press Enter"));
  tmux("send-keys", key);
  await until(() => tmux("has-session").status !== 0);
  await Bun.sleep(300);
  return { pane, ended: tmux("has-session").status !== 0, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
};
const ttyFake = await fake();
let tt = await tty(ttyFake, "C-c");
check("W10", "Ctrl-C in a terminal leaves the chat", tt.pane.includes("Press Enter") && tt.ended && !tt.log.includes("code 0") && ttyFake.alive() && !resumed(ttyFake.id).length, tt);
tt = await tty(ttyFake, "Enter"); await until(() => resumed(ttyFake.id).length);
check("R02", "Enter in a terminal moves it", !ttyFake.alive() && resumed(ttyFake.id).length === 1, tt);

// ---- move-chats ----
for (const f of children) if (f.pid && f.spawnfile.startsWith(LIVE) && f.exitCode === null && f.signalCode === null && Number(ps(f.pid, "ppid")) === process.pid) f.kill("SIGKILL");
await Bun.sleep(500);
const acme = join(OUT, "acme"), back = join(acme, "backend"), acmex = join(OUT, "acme-x"), wt = join(OUT, "wt");
for (const d of [join(back, "src"), acmex]) mkdirSync(d, { recursive: true });
spawnSync("/bin/bash", ["-c", `cd "$1" && git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x && git worktree add -q "$2"`, "bash", back, wt], { env: { HOME, PATH: base.PATH } });
writeFileSync(base.CMUX_CHAT_PROJECTS, `# no | ${acmex}\nACME | ${acme}\nACME/backend | ${back}\nGone/group | ${WORK}\n`);
const L = { wt: await fake({ dir: wt, title: "First worktree", lines: [{ type: "ai-title", aiTitle: "old title" }, msg(0.1, { cwd: wt }), { type: "ai-title", aiTitle: "First worktree" }] }), acme: await fake({ dir: acme, title: "--go \u001b[2JSecond\nline", lines: undefined, live: { status: "shell" } }), x: await fake({ dir: acmex, lines: [msg(3)], leaf: "aaaaaaaa-1111-4111-8111-111111111111" }), work: await fake({ lines: [msg(23.9), { type: "ai-title", aiTitle: "Fourth" }, "{broken", msg(0, { isSidechain: true }), msg(0, { isMeta: true }), { type: "system", timestamp: ago(0) }] }) };
writeFileSync(join(OUT, "orca.json"), JSON.stringify([{ leafId: "AAAAAAAA-1111-4111-8111-111111111111", title: "Orca \u0007title" }]));
const old = await fake({ lines: [msg(24.1), { type: "ai-title", aiTitle: "TOO OLD" }, msg(0, { isSidechain: true })] });
const fresh = new Date(), stale = new Date(Date.now() - 9e8);
utimesSync(join(CLAUDE, "projects", enc(WORK), `${old.id}.jsonl`), fresh, fresh); utimesSync(join(CLAUDE, "projects", enc(wt), `${L.wt.id}.jsonl`), stale, stale);
await fake({ title: "IN CMUX", env: { CMUX_SURFACE_ID: uuid() } }); await fake({ title: "NO PANE", env: { ORCA_PANE_KEY: "" } }); await fake({ title: "BG", live: { kind: "bg" } }); await fake({ title: "REUSED", live: { procStart: "x" } }); await fake({ title: "VIM", exe: "vim" }); await fake({ id: L.acme.id, dir: acme, noTranscript: true });
const list = (env: Record<string, string>, ...args: string[]) => spawnSync(join(ROOT, "cmux/move-chats"), args, { env: { ...base, ORCA_CHAT_MOVE_ONLY_PIDS: "", ...env }, encoding: "utf8", cwd: OUT });
const db = () => JSON.parse(readFileSync(DB, "utf8"));
const before = db().calls.length;
let r = list({});
const shape = r.stdout.trim().split("\n").map((l) => l.replace(/[\d.]+ h/, "h"));
check("L01 L02 L03 L04 L05 C07", "the dry list", JSON.stringify(shape) === JSON.stringify(["First worktree | ACME/backend | h | idle", "go [2JSecond line | ACME | h | shell | 2 processes", "Orca title | no project | h | idle", "Fourth | Gone/group | h | idle", "4 chats. Nothing was made. Run it with --go to make the workspaces."]), r);
check("C01", "a dry run does not call cmux", db().calls.length === before, db().calls.slice(before));
check("L01", "--hours 1 and --hours 30", list({}, "--hours", "1").stdout.includes("1 chats") && list({}, "--hours", "30").stdout.includes("TOO OLD"));
for (const bad of [["--hours", "x"], ["--hours"], ["--last", "x"], ["--all"], ["go"]]) check("L06", `bad option ${bad.join(" ")}`, list({}, ...bad).status === 1);
r = list({ CMUX_WORKSPACE_ID: "" }, "--go"); check("C01", "outside cmux", r.status === 1 && /inside cmux/.test(r.stderr) && db().calls.length === before, r);
const mode = (m: string) => writeFileSync(DB, JSON.stringify({ ...db(), mode: m }));
mode("nolist"); r = list({}, "--go"); check("C03", "cmux does not give the list: nothing is made", r.status === 1 && !db().calls.some((c: any) => c[0] === "new-workspace"), r);
mode("bad"); r = list({}, "--go", "--last", L.wt.id);
const ws = () => [...db().workspaces.W1, ...db().workspaces.W2];
check("C04", "one failure: the others are made, the exit code is 1", r.status === 1 && /FAILED: go .*no \[31m space/.test(r.stdout) && ws().length === 3, r);
check("C07", "most recent first, --last is last", JSON.stringify(ws().map((w: any) => w.title)) === '["Orca title","Fourth","First worktree"]', ws().map((w: any) => w.title));
check("C05", "exact group, or a clear message", JSON.stringify(ws().map((w: any) => w.group)) === '[null,null,"G-BACK"]' && /no group: cmux has 0 groups with the name Gone\/group/.test(r.stdout) && /Orca title \| no group: no project has this folder/.test(r.stdout), r.stdout);
const want = config("cmux.json").commands.find((c: any) => c.name === "Claude + chat").workspace.layout, got = ws()[2].layout, cmd = got.children[1].pane.surfaces[0].command;
want.children[1].pane.surfaces[0].command = cmd;
check("C06", "the layout of cmux.json, the command is move-one, no focus", JSON.stringify(want) === JSON.stringify(got) && got.split === want.split && cmd === `'${join(ROOT, "cmux/move-one")}' ${L.wt.id}` && ws().every((w: any) => w.focus === "false") && ws()[2].cwd === wt, ws()[2]);
const d = db(); d.workspaces.W2 = d.workspaces.W1.splice(0, 1); d.workspaces.W1[0].title = "renamed"; d.workspaces.W1[0].description += " | last active 2026-11-24T21:17Z"; writeFileSync(DB, JSON.stringify({ ...d, mode: "" }));
r = list({}, "--go"); check("C02", "a second run makes only the missing one, also after a rename and in another window", r.status === 0 && ws().length === 4 && (r.stdout.match(/already there/g) ?? []).length === 3, r);
r = list({}, "--go"); check("C02", "a third run makes nothing", r.status === 0 && ws().length === 4, r);
const verbs = [...new Set(db().calls.map((c: any) => c.slice(0, c[0].startsWith("workspace") ? 2 : 1).join(" ")))];
check("C08", "cmux got only these calls", verbs.every((v: any) => ["list-windows", "workspace list", "workspace-group list", "new-workspace", "rpc"].includes(v)), verbs);
check("C08", "Orca got only terminal list", events().filter((e) => e.orca).every((e) => e.orca.slice(0, 2).join(" ") === "terminal list"));
check("L02", "move-chats signaled nothing", [L.wt, L.acme, L.x, L.work, old].every((f) => f.alive() && !termed(f.pid)));
// ---- the test ----
const source = readFileSync(join(ROOT, "lib/move.ts"), "utf8");
check("S01", "the source has one process.kill, with SIGTERM, after the pid check", (source.match(/process\.kill\(/g) ?? []).length === 1 && source.includes('process.kill(pid, "SIGTERM")') && source.indexOf("Number.isSafeInteger(pid)") < source.indexOf("process.kill("));
check("T01", "every pid that got a SIGTERM is a fake of this test", events().filter((e) => e.term).every((e) => children.some((c) => c.pid === e.pid)), events().filter((e) => e.term));
check("T01", "the real settings and the real state dir did not change", snap() === realBefore);
for (const c of children) if (c.pid && c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
check("T02", "no fake stays", await until(() => !spawnSync("/bin/ps", ["-axww", "-o", "command="], { encoding: "utf8" }).stdout.includes(LIVE + "/"), 5000), spawnSync("/bin/ps", ["-axww", "-o", "command="], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes(LIVE)));
const failed = results.filter((x) => !x.ok).length;
writeFileSync(join(OUT, "result.json"), JSON.stringify({ when: new Date(), passed: results.length - failed, failed, results }, null, 1));
console.log(`${results.length - failed} passed, ${failed} failed\n${join(OUT, "result.json")}`);
process.exit(failed ? 1 : 0);
