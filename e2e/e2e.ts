#!/usr/bin/env bun
// orca-chat end to end test.
//
// Ways it can fail (written before the code). F = covered below.
//
//   F83 The native menu opens, the wrong tab gets edited, a poll replaces the editor, or a canceled or invalid edit sends a rename. A saved title flashes back or becomes HTML.
//   F84 A rename bypasses the pick route protections, changes a different project, or writes an invalid or altered title.
// The chat shows the wrong session
//   F02 After /clear or a resume (same process, new session id) the chat shows the old session.
//   F03 Two agents claim one pane and the chat guesses. The foreground one must win, or none.
//   F03 A test that runs a fake codex or claude (no session) next to the real agent hides the chat.
//   F04 A dead process, a reused pid, or a stale session file still counts.
//   F05 A session that is not interactive, or a nested codex with no tty, takes the pane of its parent.
//   F09 A tab with no agent, or a session with no transcript: the chat of another tab stays, or an error.
//   F10 The session is written after the page loads the frame: the server remembers the miss for 30 s.
//   F11 Codex has no rollout file open: the chat guesses.
//   F74 Codex keeps the old rollout open after /new or /resume: the chat stays on the old one, or is lost. A subagent of Codex takes the chat, also when it writes last. A first line that is cut or is not JSON, or a file that is gone, breaks the page. Only subagent files are open: it shows one.
//   F77 (lost) One bad read of a session file replaces the chat with "no session". A process whose first look fails is lost until it restarts. The chat app drops its session (its URL goes to the start page) and the frame stays empty, or it is loaded again all the time. A lost session leaves no line in the log, the log has a line per poll, or it has the token.
//   F78 (the state line) A long command looks done, a chat that waits looks busy, the line of the last chat stays, Codex or an unknown word shows a wrong state, or the line hides the end of the chat.
//   F79 (the strip) A chat of the project is missing, is not the marked one, has another icon, or its name becomes HTML. A mark is wrong: working, waiting, not read, read. A chat whose state is not known has a mark. Two states look the same, or differ by color only. The tooltip has not the words, or old ones. A click picks another chat, or is lost because the strip was drawn again. Two new chats for one double click.
//   F82 (Codex) A turn that runs, ended, or was interrupted shows another state. A turn of a process that is gone counts. A long turn, a cut line, a new file, or words of the task in a text break it. "Waiting" stays after the answer, or is that of another process.
//   F80 (the strip) It shows for a chat that is in no group, when the list is missing, broken, or of a helper that is gone, or it goes away after one bad poll. Then the state words must stay. The strip or the words hide a part of the chat. A line between the chat and the terminal.
//   F81 (the pick) It works without the token, for a foreign Host, Origin, or site, for a POST, for an image or a link in a chat (no header), for a terminal that is not in the list or is of another group. The file can be read by others. The page with the strip can write something else.
//   F76 (the flash) The start page of a new chat is white. The frame of a chat shows before it has loaded, the old chat goes away too early, a slow frame that is not wanted any more takes the page, a message stays hidden, or a frame is never shown.
//   F75 cmux.json: the Codex commands start Codex with the shared daemon (the daemon has the rollout, so there is no chat) or in the alternate screen, or Codex does not start when cmux-chat-open fails.
//   F13 The pane changes from Claude to Codex: both stores claim it.
// The chat can write
//   F20 The page has an input box.
//   F21 A WebSocket message (send, stop, start, fork, handoff, focus-terminal, set-option, delete) reaches an agent.
//   F22 A POST creates a session or sends a prompt.
//   F24 CMUX_BUNDLED_CLI_PATH is a command that works.
//   F25 A remote image in a reply loads (no policy), or the policy breaks the app (inline style and script, its own WebSocket).
// Server
//   F30 /follow or /follow/state answers without the token, for a foreign Host, or for a foreign Origin.
//   F31 The server binds more than 127.0.0.1, or has sockets to other hosts.
//   F32 Two runs at the same time start two servers. A second run starts a new one or changes the token.
//   F33 The port is in use by another program: orca-chat must fail.
//   F34 The token is in the log or in the output, or the state files are world-readable.
//   F35 The code changed: the old server stays, or the new one gets another port or token.
//   F36 stop, or the restart of F35, kills a process that is not the server.
//   F37 Transcript events, or new lines, do not arrive (Claude, Codex).
//   F38 The server starts an agent (claude, codex, opencode, pi), or a child process stays.
//   F40 The test touches ~/.cmuxterm, ~/.claude, or the real state dir.
// cmux: one surface, no following
//   F60 The chat of one cmux surface shows another surface or workspace. Upper and lower case differ.
//   F61 CMUX_SURFACE_ID has two values in one process: the chat guesses. A missing or invalid cmux id, or a request with worktree, gets a page.
//   F62 No agent yet, no transcript, /clear, or two agents in one surface: the chat is wrong or stays.
//   F63 The surface needs an external CLI to find its session.
//   F64 The cmux mode answers without the token, for a foreign Host, or for a foreign Origin.
//   F65 Binding one surface changes another surface's claim.
//   F66 cmux-chat-open navigates or opens something when there is no browser surface, more than one, a dock one, or another workspace answers.
//   F67 cmux-chat-open blocks claude: cmux hangs, fails, or prints no JSON, the sidecar or cmux is missing, the port is in use, or it is not in cmux.
//   F68 The token is in an argv, in what cmux gets (cmux keeps each browser.navigate in ~/.cmuxterm/events.jsonl), in the output, or in the log.
//   F69 The one-time link works twice, after a minute, for another surface, with a forged signature, for a foreign Host, or it is a POST.
//   F70 The terminal environment reaches the server or a second open replaces it.
//   F71 cmux.json: the chat is below the terminal, the default workspace changes, the schema refuses it, or claude does not start when cmux-chat-open fails. A Claude command is not in the classic mode (in a short fullscreen terminal the / menu is cut).
//   F73 (the width) A part of the chat keeps the 760 px cap of cmux, so it does not line up with the others.
//   F72 (the project group) A workspace that is in a group moves. A folder with no project gets a group. /a/b takes /a/bc. The outer project wins. Two groups with one key: it guesses. A worktree outside the folder has no group. A cmux call that hangs or fails stops the chat or claude. It calls anything other than list and add.
// Page (its script runs here on a small fake DOM, not in a browser)
//   F50 A switch makes a new frame, so the scroll is lost. More than 5 frames stay.
//   F51 It polls while hidden, polls twice at the same time, or stops after an error.
//   F52 A title or a message from a terminal becomes HTML.
//
// Run: bun e2e/e2e.ts   (needs bin/install first)
// Output: $ORCA_CHAT_E2E_OUT/<time>/result.json, server.log, page-follow.html, page-chat.html, cmux-calls.json
// The fake cmux CLI records its calls. The
// home, the state, and the transcripts are synthetic, in the output dir.
import { config } from "../lib/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BASE = process.env.ORCA_CHAT_E2E_OUT ?? realpathSync(tmpdir());
const OUT = join(BASE, new Date().toISOString().replace(/[:.]/g, "-"));
const HOME = join(OUT, "home"), STATE = join(OUT, "state"), CLAUDE = join(HOME, ".claude"), CODEX = join(HOME, ".codex");
const DATA = process.env.ORCA_CHAT_DATA_DIR ?? join(homedir(), ".local/share/orca-chat");
const PROJ = join(CLAUDE, "projects/-e2e"), DAY = join(CODEX, "sessions/2026/01/02");
for (const dir of [join(CLAUDE, "sessions"), PROJ, DAY]) mkdirSync(dir, { recursive: true });

// ---- checks ----
const results: { id: string; check: string; ok: boolean; evidence?: unknown }[] = [];
function check(id: string, name: string, ok: boolean, evidence?: unknown) {
  results.push({ id, check: name, ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${ok ? "" : " :: " + JSON.stringify(evidence)?.slice(0, 600)}`);
}
async function until<T>(fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms = 10_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    const value = await fn();
    if (value) return value;
  }
}
const lstart = (pid: number) => spawnSync("/bin/ps", ["-ww", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC0" } }).stdout.trim();
const alive = (pid: number) => lstart(pid) !== "";
const children: ChildProcess[] = [];
const agents: number[] = [];
// Also after a crash: stop what this run started, and nothing else.
process.on("exit", () => {
  for (const c of children) c.kill();
  for (const pid of agents) try { process.kill(pid); } catch {}
  try {
    const { pid, pidStart } = JSON.parse(readFileSync(join(STATE, "launch.json"), "utf8"));
    if (lstart(pid) && lstart(pid) === pidStart) process.kill(pid);
  } catch {}
});
const realPaths = [".local/state/orca-chat", ".cmuxterm", ".cache/cmux-agent-chat"].map((p) => join(homedir(), p));
const snapshot = () => JSON.stringify(realPaths.map((p) => (existsSync(p) ? statSync(p).mtimeMs : null)));
const realBefore = snapshot();

const uuid = () => crypto.randomUUID();
const surface = { A: uuid(), B: uuid(), X: uuid(), SHELL: uuid() };
// ---- synthetic transcripts ----
const claudeFile = (id: string) => join(PROJ, `${id}.jsonl`);
const claudeLines = (id: string, text: string, image = "") => [
  { type: "user", uuid: uuid(), sessionId: id, cwd: OUT, timestamp: new Date().toISOString(), message: { role: "user", content: `question ${text}` } },
  { type: "assistant", uuid: uuid(), sessionId: id, cwd: OUT, timestamp: new Date().toISOString(), message: { id: `msg_${text}`, role: "assistant", content: [{ type: "text", text: `answer ${text} ${image}` }] } },
].map((l) => JSON.stringify(l) + "\n").join("");
const SA = uuid(), SA2 = uuid(), SB = uuid(), SX = uuid(), SX2 = uuid(), SP2 = uuid();
for (const [id, text] of [[SA, "A"], [SA2, "A2"], [SP2, "P2"]]) writeFileSync(claudeFile(id), claudeLines(id, text, "![x](https://evil.example/x.png)"));
const rollout = (id: string) => join(DAY, `rollout-2026-01-02T00-00-00-${id}.jsonl`);
const codexMessage = (text: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }) + "\n" + JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "agent_message", message: text } }) + "\n";
for (const id of [SX, SX2]) writeFileSync(rollout(id), JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id, cwd: OUT } }) + "\n" + codexMessage("codex answer"));

// ---- fake agents ----
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const small = { HOME, PATH: `${join(homedir(), ".bun/bin")}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, ORCA_CHAT_STATE_DIR: STATE, ORCA_CHAT_DATA_DIR: DATA, ORCA_CHAT_PORT: String(port), CLAUDE_CONFIG_DIR: CLAUDE, CODEX_HOME: CODEX };
const inCmux = (s: string) => ({ CMUX_SURFACE_ID: s.toUpperCase(), CMUX_WORKSPACE_ID: uuid().toUpperCase() });
let n = 0;
// Runs `code` in a process of its own: with a terminal (foreground) or without one.
async function agent(surfaceId: string, name: "claude" | "codex", tty: boolean, code = "", extraEnv: Record<string, string> = {}): Promise<number> {
  const id = ++n, pidFile = join(OUT, `agent-${id}.pid`), script = join(OUT, `agent-${id}.js`), dir = join(OUT, "agents");
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, name);
  if (!existsSync(exe)) symlinkSync(process.execPath, exe);
  writeFileSync(script, `const fs=require("fs");${code};fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const env = { ...small, ...inCmux(surfaceId), ...extraEnv };
  const c = tty ? spawn("/usr/bin/script", ["-q", "/dev/null", exe, script], { env, stdio: "ignore" }) : spawn(exe, [script], { env, stdio: "ignore", detached: true });
  children.push(c);
  const pid = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8")));
  agents.push(pid);
  return pid;
}
const claudeState = (pid: number, sessionId: string, extra = {}) => writeFileSync(join(CLAUDE, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: OUT, kind: "interactive", status: "idle", procStart: lstart(pid), ...extra }));
async function claude(surfaceId: string, sessionId: string, tty = false, extra = {}, extraEnv: Record<string, string> = {}) {
  const pid = await agent(surfaceId, "claude", tty, "", extraEnv);
  claudeState(pid, sessionId, extra);
  return pid;
}
const openRollouts = (...ids: string[]) => ids.map((id) => `fs.openSync(${JSON.stringify(rollout(id))},"a")`).join(";");
const PA = await claude(surface.A, SA);
await claude(surface.B, SB); // no transcript yet
const chat = (env: Record<string, string>, phase = "cmux") => exec(env, "/usr/bin/lockf", "-k", "-t", "10", join(STATE, "lock"), process.execPath, join(ROOT, "lib/chat.ts"), phase);
function exec(env: Record<string, string>, command: string, ...args: string[]) {
  return new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const c = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], cwd: OUT });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => done({ code, out: out.trim(), err: err.trim() }));
  });
}
mkdirSync(STATE, { mode: 0o700 });
const blocker = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
let r = await chat(small);
check("F33", "the port is in use: refused", r.code !== 0 && /in use/.test(r.err), r);
blocker.stop(true);
await Bun.sleep(300);
const [a, b] = await Promise.all([chat(small), chat(small)]);
check("F32", "two parallel starts return the same server", a.code === 0 && b.code === 0 && a.out === b.out, [a.err, b.err]);
const url = new URL(a.out), token = url.pathname.slice(1);
url.searchParams.set("cmux", surface.A);
const launch = () => JSON.parse(readFileSync(join(STATE, "launch.json"), "utf8"));
let serverPid = launch().pid;
r = await chat(small);
check("F32", "a second start keeps the server and token", r.out === a.out && launch().pid === serverPid);
const listen = () => spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().split("\n").slice(1);
check("F31", "one listener, on 127.0.0.1 only", listen().length === 1 && listen()[0].includes(`127.0.0.1:${port}`) && listen()[0].includes(` ${serverPid} `), listen());

// ---- http ----
const get = (path: string, headers: Record<string, string> = {}, method = "GET", body?: string) => new Promise<{ status: number; body: string; headers: any }>((done, fail) => {
  const q = request({ host: "127.0.0.1", port, path, headers, method }, (res) => { let text = ""; res.on("data", (d) => (text += d)); res.on("end", () => done({ status: res.statusCode!, body: text, headers: res.headers })); });
  q.on("upgrade", (res, sock) => { sock.destroy(); done({ status: res.statusCode!, body: "upgraded", headers: {} }); });
  q.on("error", fail);
  q.end(body);
});
const STATE_URL = `/${token}/follow/state${url.search}`;
const state = async (id: string = surface.A): Promise<{ session: string | null; title: string; message: string | null }> => JSON.parse((await get(`/${token}/follow/state?cmux=${id}`)).body);
const store = (name: string) => (existsSync(join(STATE, `${name}-hook-sessions.json`)) ? JSON.parse(readFileSync(join(STATE, `${name}-hook-sessions.json`), "utf8")) : { sessions: {}, activeSessionsBySurface: {} });
const open = async (sessionId: string) => {
  const events: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${token}/ws`);
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
  ws.send(JSON.stringify({ op: "subscribe", sessionId }));
  await until(() => events.find((e) => e.kind === "history" || e.kind === "no-session"));
  return { ws, events, op: (msg: object) => ws.send(JSON.stringify({ sessionId, ...msg })) };
};

// ---- session lookup and transcript history ----
let s = await state();
const c1 = await open(`t-${SA}`);
check("F10", "the session is in the store before the frame loads: history at once", c1.events.some((e) => e.kind === "history") && Boolean(await until(() => JSON.stringify(c1.events).includes("answer A"), 5_000)), c1.events.map((e) => e.kind));
s = await state(surface.B);
check("F09", "tab B has a session with no transcript: a message, no other chat", s.session === null && /no transcript yet/.test(s.message!), s);
writeFileSync(claudeFile(SB), claudeLines(SB, "B"));
s = await state(surface.B);
check("F09", "tab B shows its session when the transcript exists, with no command", s.session === SB, s);
s = await state(surface.SHELL);
check("F09", "a shell: a message", s.session === null && /No Claude Code or Codex/.test(s.message!), s);
claudeState(PA, SA2);
s = await state();
check("F02", "after /clear: the new session, at the next poll", s.session === SA2 && store("claude").activeSessionsBySurface[surface.A].sessionId === SA2, s);
claudeState(PA, SA);
check("F02", "after a resume: the old session again", (await state()).session === SA);

// ---- F04 F05 F03 claims ----
claudeState(PA, SA, { procStart: "Mon Jan  1 00:00:00 2024" });
check("F04", "a reused pid (other start time) does not count", (await state()).session === null);
claudeState(PA, SA, { kind: "bg" });
check("F05", "a session that is not interactive does not count", (await state()).session === null);
claudeState(PA, SA);
const twin = await claude(surface.A, SA2);
s = await state();
check("F03", "two agents, none in the foreground: a message", s.session === null && /More than one agent/.test(s.message!), s);
const front = await claude(surface.A, SP2, true);
s = await state();
check("F03", "two agents, one in the foreground: that one", s.session === SP2, { s, stat: spawnSync("/bin/ps", ["-o", "stat=,tty=", "-p", String(front)], { encoding: "utf8" }).stdout });
const fakeCodex = await agent(surface.A, "codex", true);
await Bun.sleep(1_700); // the list of codex processes is 1.5 s old at most
s = await state();
check("F03", "and a codex with no session in the foreground (a test run): still that one", s.session === SP2, s);
for (const pid of [twin, front, fakeCodex]) process.kill(pid, "SIGKILL");
await until(() => !alive(twin) && !alive(front) && !alive(fakeCodex));
s = await state();
check("F04", "dead processes do not count, their files are still there", s.session === SA && existsSync(join(CLAUDE, "sessions", `${twin}.json`)), s);

const SLOW = 2_500; // the list of codex processes is read every 1.5 s
const nested = await agent(surface.X, "codex", false, openRollouts(SX));
await Bun.sleep(SLOW);
s = await state(surface.X);
check("F05", "a codex with no tty does not count", s.session === null && /No Claude Code or Codex/.test(s.message!), s);
process.kill(nested, "SIGKILL");
const fresh = await agent(surface.X, "codex", true);
s = (await until(async () => { const x = await state(surface.X); return /no transcript/.test(x.message ?? "") && x; }, SLOW)) ?? (await state(surface.X));
check("F11", "codex with no rollout file open: a message", /no transcript yet/.test(s.message ?? ""), s);
process.kill(fresh, "SIGKILL");
const SUB = uuid(), BAD = uuid(), at = (id: string, t: number) => utimesSync(rollout(id), t, t);
writeFileSync(rollout(SUB), JSON.stringify({ type: "session_meta", payload: { id: SUB, cwd: OUT, base_instructions: { text: "x".repeat(30_000) }, source: { subagent: { other: "guardian" } } } }) + "\n");
writeFileSync(rollout(BAD), '{"type":"session_meta","payl');
at(SX, 1000); at(SX2, 2000); at(SUB, 3000); at(BAD, 500);
const two = await agent(surface.X, "codex", true, openRollouts(SX, SX2, SUB, BAD));
const shows = async (id: string | null) => (await until(async () => { const x = await state(surface.X); return x.session === id && (id || x.message) && x; }, SLOW)) ?? (await state(surface.X));
s = await shows(SX2);
check("F74", "two rollout files, a subagent, and a bad one: the one that Codex wrote last, not the subagent", s.session === SX2, s);
at(SX, 4000);
s = await shows(SX);
check("F74", "the old conversation is written again (/resume): the chat follows", s.session === SX, s);
process.kill(two, "SIGKILL");
const subOnly = await agent(surface.X, "codex", true, openRollouts(SUB));
await Bun.sleep(SLOW);
s = await state(surface.X);
check("F74", "only a subagent file: a message", s.session === null && /no transcript yet/.test(s.message ?? ""), s);
process.kill(subOnly, "SIGKILL");
const PX = await agent(surface.X, "codex", true, openRollouts(SX));
s = (await until(async () => { const x = await state(surface.X); return x.session && x; }, SLOW)) ?? (await state(surface.X));
check("F11", "codex with one rollout file open: its session", s.session === SX, s);
const c2 = await open(`t-${SX}`);
check("F37", "Codex transcript events arrive", Boolean(await until(() => JSON.stringify(c2.events).includes("codex answer"), 5_000)), c2.events.map((e) => e.kind));
const liveA = `live ${uuid()}`, liveX = `live ${uuid()}`;
appendFileSync(claudeFile(SA), claudeLines(SA, liveA));
appendFileSync(rollout(SX), codexMessage(liveX));
check("F37", "new lines arrive live (Claude, Codex)", Boolean(await until(() => JSON.stringify(c1.events).includes(liveA) && JSON.stringify(c2.events).includes(liveX))));
// The same pane: Codex ends, Claude starts.
process.kill(PX, "SIGKILL");
await until(() => !alive(PX));
await claude(surface.X, SP2);
s = await state(surface.X);
check("F13", "the pane changes from Codex to Claude: one claim in the stores", s.session === SP2 && store("claude").activeSessionsBySurface[surface.X]?.sessionId === SP2 && !store("codex").activeSessionsBySurface[surface.X], { s, codex: store("codex").activeSessionsBySurface });

// ---- F30 F20 F25 ----
const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
const without = await Promise.all([`/follow${url.search}`, `/follow/state${url.search}`, `/${"0".repeat(64)}/follow${url.search}`, `/${"0".repeat(64)}/follow/state${url.search}`, "/", `/s/t-${SA}`, "/api/sessions", "/app.js", "/ws"].map((p) => get(p, p === "/ws" ? upgrade : {})));
check("F30", "404 without the token and with a wrong token", without.every((x) => x.status === 404), without.map((x) => x.status));
for (const [name, h] of [["Host", { host: "evil.example" }], ["Origin", { origin: "https://evil.example" }], ["Origin port", { origin: "http://127.0.0.1:1" }], ["null Origin", { origin: "null" }]] as [string, Record<string, string>][]) {
  const x = await Promise.all([get(STATE_URL, h), get(`/${token}/follow${url.search}`, h), get(`/${token}/ws`, { ...upgrade, ...h })]);
  check("F30", `a foreign ${name} is refused`, x.every((y) => y.status === 403), x.map((y) => y.status));
}
check("F30", "the page's own Origin is fine", (await get(STATE_URL, { origin: `http://127.0.0.1:${port}` })).status === 200 && (await get(`/${token}/ws`, { ...upgrade, origin: `http://127.0.0.1:${port}` })).status === 101);
const followPage = await get(`/${token}/follow${url.search}`), chatPage = await get(`/${token}/s/t-${SA}`), landing = await get(`/${token}/`);
writeFileSync(join(OUT, "page-follow.html"), followPage.body);
writeFileSync(join(OUT, "page-chat.html"), chatPage.body.replaceAll(token, "<token>"));
check("F20", "the chat page hides the input card, and still has its app", [chatPage, landing].every((p) => p.status === 200 && p.body.includes("#chat-card{display:none!important}</style></head>") && p.body.includes('id="root"')));
const appCss = readFileSync(join(DATA, "cmux-src/agent-chat/public/app.css"), "utf8"), wide = chatPage.body.match(/:is\(([^)]+)\)\{max-width:none!important;/)?.[1].split(",") ?? [];
const capped = [...appCss.matchAll(/([^{}]+)\{[^{}]*max-width: 760px/g)].map((m) => m[1].replace(/\/\*[^]*?\*\//g, "").trim());
check("F73", "each part that cmux caps at 760 px is wider", capped.length > 10 && capped.every((s) => wide.includes(s)), { capped, wide });
const chatTsx = readFileSync(join(DATA, "cmux-src/agent-chat/src/components/Chat.tsx"), "utf8"), card = chatTsx.slice(chatTsx.indexOf('<div id="chat-card">'));
check("F20", "in the pinned source the input, send, and stop are inside that card", card.includes('id="chat-input"') && card.includes("{chatActions}") && !chatTsx.slice(chatTsx.indexOf("return ("), chatTsx.indexOf('<div id="chat-card">')).includes("<textarea"));
check("F20", "the follow page has no composer", !/<(input|textarea|form|button)|contenteditable/i.test(followPage.body.replace('<button id="rename" hidden>Rename</button>', "")));
const csp = (p: any) => Object.fromEntries(String(p.headers["content-security-policy"] ?? "").split("; ").map((d: string) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
check("F25", "the policy has no remote source", [followPage, chatPage, landing].every((p) => csp(p)["img-src"] === "'self' data: blob:" && csp(p)["default-src"] === "'self'" && !/https?:|\*/.test(p.headers["content-security-policy"])), csp(chatPage));
check("F25", "the policy allows what the app uses: inline style and script, its WebSocket, its base", csp(chatPage)["style-src"].includes("'unsafe-inline'") && csp(chatPage)["script-src"].includes("'unsafe-inline'") && csp(chatPage)["connect-src"] === `'self' ws://127.0.0.1:${port}` && csp(chatPage)["base-uri"] === "'self'");
const refs = [...chatPage.body.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1].replace(token, "<token>"));
const js = await get(`/${token}/app.js`), css = await get(`/${token}/app.css`);
const chunks = await Promise.all([...new Set(js.body.match(/chunk-[\w-]+\.js/g) ?? [])].map((c) => get(`/${token}/${c}`)));
const bundle = [js, ...chunks].map((c) => c.body).join("\n");
const uses = { eval: /\beval\(/.test(bundle), newFunction: /\bnew Function\(/.test(bundle), wasm: /WebAssembly\.(compile|instantiate)/.test(bundle), worker: /new Worker\(/.test(bundle), remoteCss: /@import|url\(["']?https?:/.test(css.body) };
check("F25", "the app loads only its own files, no eval, no wasm, no worker, no remote css", refs.every((x) => !/^(https?:)?\/\//.test(x)) && [js, css, ...chunks].every((x) => x.status === 200) && Object.values(uses).every((v) => !v), { refs, uses, bytes: bundle.length });
const perm = (p: string) => (statSync(p).mode & 0o777).toString(8);
check("F34", "the state dir is 0700 and its files are 0600", perm(STATE) === "700" && readdirSync(STATE).filter((f) => f !== "lock" && f !== "server.json").every((f) => perm(join(STATE, f)) === (f === "live" ? "700" : "600")), readdirSync(STATE).map((f) => [f, perm(join(STATE, f))]));

// ---- F21 F22 F24 F38 sending is impossible ----
const sessionsBefore = (await get(`/${token}/api/sessions`)).body;
for (const op of ["send", "stop", "fork", "handoff", "focus-terminal", "delete"]) for (const c of [c1, c2]) c.op({ op, prompt: "must not arrive", requestId: uuid() });
c1.op({ op: "set-option", id: "model", value: "x" });
for (const provider of ["claude", "codex", "opencode", "pi"]) c1.op({ op: "start", provider, prompt: "must not run", cwd: OUT, autoApprove: true });
for (const raw of ["", "null", "[]", "{", '{"op":["send"]}', '{"op":"Send"}', '{"op":"constructor"}', JSON.stringify({ op: "subscribe", sessionId: `t-${SA}`, prompt: "x" })]) c1.ws.send(raw);
const posts = await Promise.all([["POST", "/api/sessions"], ["PUT", "/api/sessions"], ["POST", "/api/theme"], ["POST", "/follow/state"], ["DELETE", "/api/sessions"]].map(([m, p]) => get(`/${token}${p}`, { "content-type": "application/json" }, m, JSON.stringify({ provider: "pi", prompt: "must not run", cwd: OUT }))));
check("F22", "every request that is not GET is refused", posts.every((p) => p.status === 405 || p.status === 403), posts.map((p) => p.status));
await Bun.sleep(3_000);
check("F21", "WebSocket messages create no session", (await get(`/${token}/api/sessions`)).body === sessionsBefore);
c1.op({ op: "subscribe" });
check("F21", "the server is alive and still answers the chat", (await get(`/${token}/api/sessions`)).status === 200 && launch().pid === serverPid && c1.ws.readyState === 1);
const envLine = spawnSync("/bin/ps", ["-Eww", "-o", "command=", "-p", String(serverPid)], { encoding: "utf8" }).stdout.match(/CMUX_BUNDLED_CLI_PATH=(\S+)/)?.[1] ?? "";
const bundled = spawnSync(envLine, ["rpc", "mobile.chat.send", "{}"]);
check("F24", "the bundled CLI of the server is a command that fails", envLine === "/usr/bin/false" && bundled.status === 1, { envLine, status: bundled.status });
const { cmuxRpc } = await import(join(DATA, "cmux-src/agent-chat/cmux-rpc.ts"));
process.env.CMUX_BUNDLED_CLI_PATH = envLine;
check("F24", "the server's own rpc function gets an error from it", (await cmuxRpc("mobile.chat.send", { session_id: SA, text: "x" })).ok === false);
const logFile = join(STATE, "server.log"), log = readFileSync(logFile, "utf8");
const blocked = [...new Set([...log.matchAll(/blocked (?:process|request): ([\w.-]+)/g)].map((m) => m[1]))];
check("F38", "agent launches at server start are blocked", ["claude", "codex"].every((x) => blocked.includes(x)), blocked);
const kids = spawnSync("/usr/bin/pgrep", ["-lP", String(serverPid)], { encoding: "utf8" }).stdout.trim();
check("F38", "the server has no child process", kids === "", kids);
const sockets = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(serverPid), "-i"], { encoding: "utf8" }).stdout.trim().split("\n").slice(1).map((l) => l.replace(/\s+/g, " "));
check("F31", "the server has only loopback sockets", sockets.length > 0 && sockets.every((l) => /127\.0\.0\.1:\d+(->127\.0\.0\.1:\d+)? /.test(l + " ")), sockets);
check("F34", "the token is not in the server log", log.length > 0 && !log.includes(token), { bytes: log.length });

// ---- F50 F51 F52 the page script on a fake DOM, against the real server ----
const script = followPage.body.match(/<script>([\s\S]*)<\/script>/)![1];
const frames: any[] = [], made: any[] = [], timers: Function[] = [];
const noteEl: any = { textContent: "" }, stateEl: any = { textContent: "" };
const element = () => { const e: any = { className: "", textContent: "", children: [], style: {}, setAttribute() {}, focus() {}, select() { e.selected = true; }, append: (...nodes: any[]) => nodes.forEach(c => { c.parent = e; e.children.push(c); }), insertBefore(c: any, at: any) { c.remove(); e.children.splice(at ? e.children.indexOf(at) : e.children.length, 0, c); c.parent = e; }, remove() { const i = e.parent?.children.indexOf(e) ?? -1; if (i >= 0) e.parent.children.splice(i, 1); }, scrollIntoView: () => (scrolled = e) }; return e; };
let scrolled: any;
const ids: Record<string, any> = { note: noteEl, state: stateEl, rename: element(), bar: element(), tabs: element(), plus: element() };
const doc: any = { visibilityState: "visible", title: "", getElementById: (id: string) => ids[id], createElement: (tag: string) => { if (tag !== "iframe") return element(); const f: any = { tag, className: "", src: "", remove() { frames.splice(frames.indexOf(f), 1); } }; made.push(f); return f; }, body: { append: (f: any) => (frames.push(f), f.onload()) }, addEventListener: (_: string, fn: Function) => (doc.wake = fn) };
let fetches = 0, inFlight = 0, most = 0, fake: any = null;
const sent: { path: string; init: any }[] = [];
const pageFetch = async (path: string, init: any) => {
  if (path.startsWith("follow/pick") || path.startsWith("follow/rename")) return sent.push({ path, init }), { ok: true };
  fetches++;
  most = Math.max(most, ++inFlight);
  try {
    await Bun.sleep(5);
    if (fake === "down") throw new Error("down");
    if (fake) return { ok: true, json: async () => fake };
    const x = await get(new URL(path, `http://127.0.0.1:${port}/${token}/follow`).pathname + url.search);
    return { ok: x.status === 200, json: async () => JSON.parse(x.body) };
  } finally {
    inFlight--;
  }
};
new Function("document", "location", "fetch", "setTimeout", "clearTimeout", script)(doc, { search: "?cmux=ME" }, pageFetch, (fn: Function, ms: number) => timers.push(Object.assign(fn, { ms })), () => {});
const tick = async () => { const before = timers.length; timers.at(-1)?.(); await until(() => timers.length > before, 3_000); };
await until(() => timers.length > 0);
const visible = () => frames.filter((f) => f.className === "on").map((f) => f.src);
check("F50", "the page shows the frame of the active session, next poll in 400 ms", JSON.stringify(visible()) === JSON.stringify([`s/t-${SA}`]) && (timers.at(-1) as any).ms === 400, { src: visible(), note: noteEl.textContent });
const frameA = frames[0];
fake = { ...(await state(surface.B)), title: "<img src=x onerror=alert(1)>" };
await tick();
check("F52", "a title with HTML stays text", visible()[0] === `s/t-${SB}` && doc.title === "Chat: <img src=x onerror=alert(1)>" && !/innerHTML|insertAdjacent|document\.write/.test(script), doc.title);
fake = null;
await tick();
check("F50", "back to tab A: the same frame, visible again, not a new one", visible()[0] === `s/t-${SA}` && frames.includes(frameA) && made.length === 2, made.map((f) => f.src));
fake = await state(surface.SHELL);
await tick();
check("F77", "one poll with no session: the chat stays", visible()[0] === `s/t-${SA}` && noteEl.textContent === "", noteEl.textContent);
for (let i = 0; i < 4; i++) await tick();
check("F09", "the page hides the chat and shows the text for a shell", visible().length === 0 && /No Claude Code/.test(noteEl.textContent), noteEl.textContent);
const lineOf = async (x: object) => { const keep = fake; fake = { session: SA, title: "", message: null, ...x }; await tick(); fake = keep; return stateEl.className + "|" + stateEl.textContent; };
const lines = { busy: await lineOf({ status: "busy", since: Date.now() - 999e3 }), idle: await lineOf({ status: "idle", since: Date.now() - 185e3 }), now: await lineOf({ status: "idle", since: Date.now() }), shell: await lineOf({ status: "shell" }), waiting: await lineOf({ status: "waiting" }), other: await lineOf({ status: "<b>" }), codex: await lineOf({}) };
check("F78", "the words of the page for each state, and none for an unknown word", lines.busy === "busy|Working" && lines.idle === "done|\u2713 Done, your turn, 3 min ago" && lines.now === "done|\u2713 Done, your turn, just now" && /^done\|.*background/.test(lines.shell) && /^ask\|.*Waiting/.test(lines.waiting) && lines.other === "|" && lines.codex === "|", lines);
check("F78 F80", "the strip is at the top, the words are at the bottom, and the chat is between them", /iframe\{position:fixed;inset:var\(--bar\) 0 var\(--foot\);width:100%;height:calc\(100% - var\(--bar\) - var\(--foot\)\)/.test(followPage.body) && /has\(#bar\.tabs\)\{--bar:32px\}:root:has\(#state:not\(:empty\)\)\{--foot:28px\}/.test(followPage.body) && /#bar\{position:fixed;inset:0 0 auto;height:var\(--bar\)/.test(followPage.body) && /#state\{position:fixed;inset:auto 0 0;height:var\(--foot\)/.test(followPage.body) && /<div id="plus"[^>]*>\+<\/div><\/div><div id="note"><\/div><div id="state"><\/div>/.test(followPage.body));
const barOf = async (x: object) => { fake = { session: SA, title: "", message: null, ...x }; await tick(); return ids.bar.className; };
check("F80", "no chats: no strip, and the words stay", (await barOf({})) === "" && stateEl.textContent === "" && (await barOf({ status: "busy" })) === "" && stateEl.textContent === "Working" && (await barOf({ chats: [], status: "idle" })) === "" && stateEl.textContent.includes("Done"));
{ // ---- F79 the strip ----
  const row = () => ids.tabs.children.map((t: any) => `${t.className}|${t.children[1].textContent}`);
  const c = (id: string, extra = {}) => ({ id, title: `chat ${id}`, agent: "claude", unread: false, ...extra });
  const min = Date.now() - 185e3;
  await barOf({ status: "busy", chats: [c("a", { status: "busy" }), c("b", { status: "waiting" }), c("me", { status: "busy" }), c("d", { status: "idle", unread: true, since: min }), c("e", { status: "idle", since: min }), c("f", { agent: "codex" }), c("g", { status: "asked", unread: true }), c("h", { status: "asked" }), c("i", { unread: true, status: "<b>" }), c("j", { status: "shell" })], plus: true });
  const shown = row();
  check("F79", "one tab per chat, the own one is marked, each state has its own mark, an unknown one none", JSON.stringify(shown) === JSON.stringify(["tab claude busy|chat a", "tab claude ask|chat b", "tab claude busy me|chat me", "tab claude new|chat d", "tab claude read|chat e", "tab codex |chat f", "tab claude ask|chat g", "tab claude |chat h", "tab claude |chat i", "tab claude read|chat j"]), shown);
  check("F79", "the strip, the plus, and the words of the own chat", ids.bar.className === "tabs plus" && stateEl.textContent === "Working" && scrolled === ids.tabs.children[2]);
  const tips = ids.tabs.children.map((t: any) => t.title);
  check("F79", "the tooltip has the name and the words", tips[0] === "chat a\nWorking" && tips[1] === "chat b\n? Waiting for your answer in the terminal" && tips[3] === "chat d\n\u2713 Done, your turn, 3 min ago, not read" && tips[4] === "chat e\n\u2713 Done, your turn, 3 min ago" && tips[5] === "chat f", tips);
  const css = followPage.body, dot = (k: string) => css.includes(`.tab.${k} `);
  check("F79", "the marks differ by shape too: a dot that pulses, a question mark, a bold name with a dot, a dim name", /\.tab\.busy b\{background:#ffb86c;animation:beat/.test(css) && /\.tab\.ask b::before\{content:"\?"\}/.test(css) && /\.tab\.ask b\{[^}]*color:#ff79c6/.test(css) && /\.tab\.new b\{background:#50fa7b\}\.tab\.new span\{font-weight:700/.test(css) && /\.tab\.read[^{]* span\{opacity:/.test(css) && dot("claude") && dot("codex") && (css.match(/data:image\/svg\+xml/g) ?? []).length === 2);
  const [first, second] = ids.tabs.children;
  scrolled = null;
  await barOf({ chats: [c("b", { title: "<img src=x>" }), c("a"), c("me")], plus: false });
  check("F79", "another order, a new name, chats that are gone: the same elements, the name is text", ids.tabs.children[0] === second && ids.tabs.children[1] === first && ids.tabs.children.length === 3 && second.children[1].textContent === "<img src=x>" && ids.bar.className === "tabs" && scrolled === ids.tabs.children[2], row());
  scrolled = null;
  await barOf({ chats: [c("b"), c("a", { status: "busy" }), c("me")] });
  check("F79", "a new mark does not scroll the strip", scrolled === null && first.className === "tab claude busy", row());
  const real = Date.now;
  await barOf({ chats: [c("a", { status: "idle", since: real() })] });
  Date.now = () => real() + 125e3;
  await barOf({ chats: [c("a", { status: "idle", since: real() })] });
  check("F79", "the words of a tooltip get older", first.title.endsWith("2 min ago"), first.title);
  Date.now = real;
  fake = "down";
  await tick();
  check("F80", "one bad poll: the strip stays", ids.tabs.children.length === 1 && ids.bar.className.startsWith("tabs"), ids.bar.className);
  sent.length = 0;
  first.onclick(); ids.plus.onclick(); ids.plus.onclick();
  check("F79", "a click sends the chat and the header, a double click on the plus one new chat", sent.length === 2 && sent[0].path === `follow/pick?cmux=ME&to=a` && sent[1].path.endsWith("&to=new") && sent.every((x) => x.init.headers["x-orca-chat"] === "pick"), sent);
  await barOf({ chats: [c("a", { workspace: "wa" }), c("me", { workspace: "wm" })] });
  sent.length = 0;
  let prevented = false;
  first.oncontextmenu({ preventDefault() { prevented = true; }, clientX: 25, clientY: 15 });
  check("F83", "right click opens Rename without picking", prevented && !ids.rename.hidden && sent.length === 0 && followPage.body.includes(">Rename</button>"));
  ids.rename.onclick();
  const input = first.children[3];
  check("F83", "the current name is selected in the tab", input.selected && input.value === "chat a" && input.maxLength === 80);
  const key = (field: any, key: string) => field.onkeydown({ key, preventDefault() {}, stopPropagation() {} });
  const title = "<img src=x> & hello";
  input.value = title;
  key(input, "Enter");
  const save = sent[0], query = new URLSearchParams(save?.path.split("?")[1]);
  check("F83", "save sends the workspace, exact text and rename header, and shows the title immediately", save?.path.startsWith("follow/rename?") && query.get("title") === title && query.get("workspace") === "wa" && save.init.headers["x-orca-chat"] === "rename" && first.children[1].textContent === title);
  await barOf({ chats: [c("a", { workspace: "wa", status: "busy" }), c("me", { workspace: "wm" })] });
  check("F83", "a stale poll keeps the optimistic title", first.children[1].textContent === title);
  const current = ids.tabs.children[1];
  current.ondblclick();
  current.children[3].value = "  ";
  key(current.children[3], "Enter");
  current.children[3]?.onblur();
  current.ondblclick();
  current.children[3].value = "cancel";
  key(current.children[3], "Escape");
  current.ondblclick();
  current.children[3].onblur();
  check("F83", "blank, Escape and unchanged blur leave the current title alone", sent.length === 1 && current.children.length === 3 && current.children[1].textContent === "chat me");
  await barOf({ chats: [] });
  check("F80", "the list is gone: no strip", ids.tabs.children.length === 0 && ids.bar.className === "", ids.bar.className);
  fake = null;
}
for (let i = 0; i < 8; i++) { fake = { session: `many-${i}`, title: "", message: null }; await tick(); }
check("F50", "5 frames stay, the last one is visible", frames.length === 5 && JSON.stringify(visible()) === '["s/t-many-7"]', frames.map((f) => f.src));
{ // The app of the frame lost its session, and is on its start page.
  const f = frames.at(-1), real = Date.now;
  let sets = 0, src = f.src;
  Object.defineProperty(f, "src", { get: () => src, set: (v) => { src = v; sets++; } });
  f.contentWindow = { location: { pathname: "/T/s/t-many-7" } };
  await tick();
  const healthy = sets;
  f.contentWindow.location.pathname = "/T/";
  await tick(); await tick();
  check("F77", "a frame that lost its session is loaded again, one time in 5 s", healthy === 0 && sets === 1 && src === "s/t-many-7", { healthy, sets });
  Date.now = () => real() + 6_000; await tick(); Date.now = real;
  check("F77", "and again after 5 s", sets === 2, sets);
  delete f.contentWindow;
}
fake = "down";
for (let i = 0; i < 5; i++) await tick();
check("F51", "a server that is off: a text, and the page polls again", /does not answer/.test(noteEl.textContent) && timers.length > 0, noteEl.textContent);
fake = { session: "many-7", title: "", message: null };
await tick();
check("F51", "then the chat comes back", visible()[0] === "s/t-many-7" && noteEl.textContent === "");
doc.visibilityState = "hidden";
const hiddenFrom = fetches;
await tick();
check("F51", "no request while hidden", fetches === hiddenFrom);
doc.visibilityState = "visible";
doc.wake();
doc.wake();
timers.at(-1)!();
await Bun.sleep(100);
check("F51", "it polls at once when visible, and never two at the same time", fetches === hiddenFrom + 1 && most === 1, { fetches: fetches - hiddenFrom, most });

// ---- F60 to F65 the follow mode of one cmux surface ----
const surf = { C1: uuid(), C2: uuid(), TWO: uuid(), X: uuid(), EMPTY: uuid() };
const q1 = `?cmux=${surf.C1}`;
const SC1 = uuid(), SC1b = uuid(), SC2 = uuid(), SC3 = uuid(), SC4 = uuid();
for (const [id, text] of [[SC1, "C1"], [SC1b, "C1b"], [SC3, "C3"], [SC4, "C4"]]) writeFileSync(claudeFile(id), claudeLines(id, text));
await state();
const firstClaim = JSON.stringify(store("claude").activeSessionsBySurface[surface.A]);
s = await state(surf.C1);
check("F62", "a surface with no agent: a message", s.session === null && /No Claude Code or Codex/.test(s.message!), s);
const PC1 = await claude(surf.C1, SC1, true);
await claude(surf.C2, SC2, true); // no transcript yet
s = await state(surf.C1);
const upper = await state(surf.C1.toUpperCase());
check("F60", "the surface shows its session, the id in upper or lower case", s.session === SC1 && upper.session === SC1, { s, upper });
const c3 = await open(`t-${SC1}`);
check("F60", "the server finds the transcript: its history arrives", Boolean(await until(() => JSON.stringify(c3.events).includes("answer C1"), 5_000)), c3.events.map((e) => e.kind));
c3.ws.close();
s = await state(surf.C2);
check("F62", "a session with no transcript: a message", s.session === null && /no transcript yet/.test(s.message!), s);
writeFileSync(claudeFile(SC2), claudeLines(SC2, "C2"));
check("F60", "two surfaces: each shows its own session", (await state(surf.C2)).session === SC2 && (await state(surf.C1)).session === SC1);
claudeState(PC1, SC1b);
check("F62", "after /clear: the new session", (await state(surf.C1)).session === SC1b);
claudeState(PC1, SC1);
for (const status of ["busy", "idle", "shell", "waiting"]) {
  claudeState(PC1, SC1, { status, statusUpdatedAt: 1234 });
  s = await state(surf.C1);
  check("F78", `Claude says ${status}: the state has it, with its time`, s.session === SC1 && (s as any).status === status && (s as any).since === 1234, s);
}
claudeState(PC1, SC1);
const bg = await claude(surf.C1, SC3, false, { kind: "bg" });
check("F62", "a background session in the same surface does not count", (await state(surf.C1)).session === SC1);
claudeState(bg, SC3);
check("F62", "two agents: the one in the foreground", (await state(surf.C1)).session === SC1);
const front2 = await claude(surf.C1, SC4, true);
s = await state(surf.C1);
check("F62", "two agents in the foreground of their terminals: a message, no guess", s.session === null && /More than one agent/.test(s.message!), s);
for (const pid of [bg, front2]) process.kill(pid, "SIGKILL");
await until(() => !alive(bg) && !alive(front2));
const PT = await claude(surf.TWO, SC3, false, {}, { OTHER_TEXT: `x CMUX_SURFACE_ID=${surf.EMPTY}` });
check("F61", "two values in one process: none of the two surfaces", (await state(surf.TWO)).session === null && (await state(surf.EMPTY)).session === null);
process.kill(PT, "SIGKILL");
const PCX = await agent(surf.X, "codex", true, openRollouts(SX2));
s = (await until(async () => { const x = await state(surf.X); return x.session && x; }, SLOW)) ?? (await state(surf.X));
check("F60", "Codex in a surface: its session", s.session === SX2, s);
check("F82", "Codex with no turn in its rollout: no state", (s as any).status === undefined, s);
{ // ---- F82 the state of Codex ----
  const turn = (type: string, at = Date.now()) => JSON.stringify({ timestamp: new Date(at).toISOString(), ordinal: 1, type: "event_msg", payload: { type, turn_id: uuid() } }) + "\n";
  const add = (text: string) => appendFileSync(rollout(SX2), text), codex = async () => { const x: any = await state(surf.X); return x.session === SX2 ? x.status : "other session"; };
  const record = (x: object) => { mkdirSync(join(HOME, ".cmuxterm"), { recursive: true }); writeFileSync(join(HOME, ".cmuxterm/codex-hook-sessions.json"), JSON.stringify({ sessions: { [SX2]: { pid: PCX, updatedAt: Date.now() / 1000 + 1, runtimeStatus: "needsInput", ...x } } })); };
  const seen: Record<string, unknown> = {};
  add(turn("task_started", Date.now() - 3600e3)); seen.oldProcess = await codex();
  add(turn("task_started") + codexMessage("x".repeat(900_000))); seen.long = await codex();
  add(codexMessage('a text with "type":"event_msg","payload":{"type":"task_complete" in it')); seen.text = await codex();
  add(turn("task_complete").slice(0, 60)); seen.cut = await codex();
  add(turn("task_complete").slice(60)); seen.done = await codex();
  add(turn("task_started")); record({ pid: 1 }); seen.otherPid = await codex();
  record({ updatedAt: 1 }); seen.oldRecord = await codex();
  record({}); seen.asked = await codex();
  record({ runtimeStatus: "running" }); seen.answered = await codex();
  add(turn("turn_aborted")); record({}); seen.interrupted = await codex();
  check("F82", "Codex: the state of each case", JSON.stringify(seen) === JSON.stringify({ long: "busy", text: "busy", cut: "busy", done: "idle", otherPid: "busy", oldRecord: "busy", asked: "asked", answered: "busy", interrupted: "idle" }), seen);
  record({ runtimeStatus: "running" });
  writeFileSync(rollout(SX2), readFileSync(rollout(SX2), "utf8").split("\n")[0] + "\n" + turn("task_started"));
  check("F82", "a rollout that was written new is read from its start", (await codex()) === "busy");
}
{ // ---- F79 F80 F81 the list and the pick ----
  const CHATS = join(STATE, "chats.json"), PICK = join(STATE, "pick.json"), ws = () => uuid();
  const entry = (terminal: string, title: string, extra = {}) => ({ workspace: ws(), terminal, title, unread: false, ...extra });
  const list = (extra: object = {}) => writeFileSync(CHATS, JSON.stringify({ pid: process.pid, projects: [{ id: "g1", folder: "/tmp/p", chats: [entry(surf.C1, "one"), entry(surf.X, "<b>two</b>", { unread: true }), entry(surf.EMPTY, "three", { agent: "codex" })] }, { id: "g2", folder: "", chats: [entry(surf.C2, "other project")] }], ...extra }), { mode: 0o600 });
  const chats = async (x: string) => { const y: any = await state(x); return { plus: y.plus, rows: y.chats.map((c: any) => [c.id, c.title, c.agent, c.status, c.unread]) }; };
  check("F80", "no list: no chats", JSON.stringify(await chats(surf.C1)) === '{"rows":[]}');
  list();
  let got = await until(async () => { const y = await chats(surf.C1); return y.rows[1]?.[3] === "busy" && y; }, 4_000) as any;
  check("F79", "the chats of the project, in its order, with the live agent and its state", JSON.stringify(got) === JSON.stringify({ plus: true, rows: [[surf.C1, "one", "claude", "idle", false], [surf.X, "<b>two</b>", "codex", "busy", true], [surf.EMPTY, "three", "codex", undefined, false]] }), got ?? (await chats(surf.C1)));
  check("F79", "a chat of another project has other chats, and no plus with no folder", JSON.stringify(await chats(surf.C2)) === JSON.stringify({ plus: false, rows: [[surf.C2, "other project", "claude", "idle", false]] }), await chats(surf.C2));
  check("F80", "a chat in no group: none", JSON.stringify(await chats(uuid())) === '{"rows":[]}');
  const gone = spawnSync("/usr/bin/true").pid;
  list({ pid: gone }); const dead = await chats(surf.C1);
  writeFileSync(CHATS, "{"); const broken = await chats(surf.C1);
  check("F80", "the helper is gone, or the list is broken: no chats", dead.rows.length === 0 && broken.rows.length === 0, [dead, broken]);
  list();
  const target = JSON.parse(readFileSync(CHATS, "utf8")).projects[0].chats[1].workspace;
  const title = "<b>' & $(hello)\nworld</b>", renameFile = join(STATE, "rename.json");
  const rename = (name: string, workspace = target) => `/${token}/follow/rename?cmux=${surf.C1}&workspace=${workspace}&title=${encodeURIComponent(name)}`;
  const header = { "x-orca-chat": "rename" };
  const denied = await Promise.all([get(rename(title)), get(rename(title), { ...header, "sec-fetch-site": "cross-site" }), get(rename(title), { ...header, origin: "https://evil.example" }), get(rename(title), { ...header, host: "evil.example" }), get(rename(title), header, "POST")]);
  const invalid = await Promise.all([get(rename("   "), header), get(rename("a".repeat(81)), header), get(rename(title, ws()), header)]);
  check("F84", "unsafe requests and invalid edits leave no rename file", denied.every(r => r.status === 403) && invalid.every(r => r.status === 404) && !existsSync(renameFile));
  const saved = await get(rename(title), header);
  const payload = existsSync(renameFile) && JSON.parse(readFileSync(renameFile, "utf8"));
  check("F84", "private rename file preserves title and workspace", saved.status === 204 && payload.workspace === target && payload.title === title && Math.abs(Date.now() - payload.at) < 2000 && perm(renameFile) === "600");
  const own = { "x-orca-chat": "pick" }, q = (to: string, from = surf.C1) => `/${token}/follow/pick?cmux=${from}&to=${to}`;
  const refused = await Promise.all([get(q(surf.X)), get(q(surf.X), { ...own, "sec-fetch-site": "cross-site" }), get(q(surf.X), { ...own, "sec-fetch-site": "same-site" }), get(q(surf.X), { "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" }), get(q(surf.X), { ...own, origin: "https://evil.example" }), get(q(surf.X), { ...own, host: "evil.example" }), get(q(surf.X), own, "POST"), get(q(surf.X), {}, "OPTIONS")]);
  const missing = await Promise.all([get(q(surf.C2), own), get(q(uuid()), own), get(q("nope"), own), get(q(""), own), get(q(surf.X, uuid()), own), get(q("new", surf.C2), own), get(q("../x"), own), get(`/follow/pick?cmux=${surf.C1}&to=${surf.X}`, own), get(`/${"0".repeat(64)}/follow/pick?cmux=${surf.C1}&to=${surf.X}`, own)]);
  check("F81", "no header, another site, an image, a foreign Origin or Host, a POST: 403, nothing is written", refused.every((x) => x.status === 403) && !existsSync(PICK), refused.map((x) => x.status));
  check("F81", "a terminal that is not in this project, no token: 404, nothing is written", missing.every((x) => x.status === 404) && !existsSync(PICK), missing.map((x) => x.status));
  const good = await get(q(surf.X.toUpperCase(), surf.C1.toUpperCase()), { ...own, "sec-fetch-site": "same-origin" }), picked = JSON.parse(readFileSync(PICK, "utf8"));
  check("F81", "the pick of the page is written, 0600", good.status === 204 && picked.from === surf.C1 && picked.to === surf.X && Math.abs(Date.now() - picked.at) < 2_000 && perm(PICK) === "600" && perm(CHATS) === "600", [good.status, picked]);
  check("F81", "a new chat too", (await get(q("new"), own)).status === 204 && JSON.parse(readFileSync(PICK, "utf8")).to === "new");
  check("F81", "no other request writes it", !/access-control/i.test(JSON.stringify(good.headers)) && (await get(`/${token}/follow/pick/${q1}`, own)).status !== 204);
}
process.kill(PCX, "SIGKILL");
check("F63", "the server finds the surface with its CLI disabled", (await state(surf.C1)).session === SC1 && envLine === "/usr/bin/false");
const bad = await Promise.all(["", "worktree=id:old", "cmux=", "cmux=nope", `cmux=${surf.C1}x`, `cmux=${surf.C1}&worktree=`, `cmux=${surf.C1}&worktree=id:old`].flatMap((q) => [get(`/${token}/follow?${q}`), get(`/${token}/follow/state?${q}`)]));
check("F61", "no UUID, or cmux with a worktree: refused", bad.every((x) => x.status === 400), bad.map((x) => x.status));
const closed = await Promise.all([get(`/follow/state${q1}`), get(`/follow${q1}`), get(`/${"0".repeat(64)}/follow/state${q1}`)]);
const foreign = await Promise.all([{ host: "evil.example" }, { origin: "https://evil.example" }].flatMap((h) => [get(`/${token}/follow/state${q1}`, h), get(`/${token}/follow${q1}`, h)]));
check("F64", "404 without the token, 403 for a foreign Host or Origin", closed.every((x) => x.status === 404) && foreign.every((x) => x.status === 403), [...closed, ...foreign].map((x) => x.status));
const cmuxPage = await get(`/${token}/follow${q1}`);
check("F64", "the cmux page is the same read-only page, with the same policy", cmuxPage.body === followPage.body && cmuxPage.headers["content-security-policy"] === followPage.headers["content-security-policy"]);
check("F65", "another surface keeps its claim", JSON.stringify(store("claude").activeSessionsBySurface[surface.A]) === firstClaim && (await state()).session === SA);
{
  for (let i = 0; i < 5; i++) await state(surf.EMPTY);
  const lines = readFileSync(join(STATE, "server.log"), "utf8").split("\n").filter((l) => /^\[orca-chat\] 20/.test(l)), of = (x: string) => lines.filter((l) => l.includes(`terminal ${x.slice(0, 8)}:`));
  check("F77", "the log has one line per change, with the reason, and no token", of(surf.EMPTY).length === 1 && /No Claude Code.*claude here: none/.test(of(surf.EMPTY)[0]) && of(surf.C1).some((l) => l.includes(`session ${SC1.slice(0, 8)}`)) && !lines.join().includes(token), { empty: of(surf.EMPTY), c1: of(surf.C1) });
}

// ---- F35 new code, F36 stop ----
writeFileSync(join(STATE, "launch.json"), JSON.stringify({ ...launch(), code: undefined }));
const { ORCA_CHAT_PORT: _, ...noPort } = small;
r = await chat(noPort);
check("F35", "other code: a new server, same port, same token", r.code === 0 && r.out === a.out && launch().pid !== serverPid && !alive(serverPid) && listen().length === 1, { code: r.code, err: r.err, same: r.out === a.out, pids: [serverPid, launch().pid] });
serverPid = launch().pid;
check("F35", "the new server follows at once", (await state()).session === SA);
const launchText = readFileSync(join(STATE, "launch.json"), "utf8");
writeFileSync(join(STATE, "launch.json"), JSON.stringify({ pid: PA, pidStart: lstart(PA), launchId: "x", code: "old" }));
r = await chat(small, "stop");
const r2 = await chat(small);
check("F36", "stop and the restart leave a pid that is not the server alone", alive(PA) && /no server/.test(r.out) && r2.code !== 0 && /in use/.test(r2.err) && alive(serverPid), { r, r2 });
writeFileSync(join(STATE, "launch.json"), launchText);
r = await chat(small, "stop");
check("F36", "stop stops the server", r.code === 0 && !alive(serverPid), r);

// ---- F66 to F71 cmux-chat-open, with a fake cmux CLI. No server runs now. ----
const CBIN = join(OUT, "cmux-bin"), CDB = join(OUT, "cmux-mode.json"), CCALLS = join(OUT, "cmux-calls.jsonl");
mkdirSync(CBIN, { recursive: true });
writeFileSync(join(CBIN, "cmux"), `#!${process.execPath}
const fs=require("fs");const argv=process.argv.slice(2);const stdin=fs.readFileSync(0,"utf8");
fs.appendFileSync(${JSON.stringify(CCALLS)},JSON.stringify({argv,stdin})+"\\n");
const m=JSON.parse(fs.readFileSync(${JSON.stringify(CDB)},"utf8"));
if(m.hang)setInterval(()=>{},1000);
else if(m.fail){console.error("Error: no socket");process.exit(1)}
else if(m.garbage)console.log("OK");
else if(argv[1]==="workspace.group.list"){if(m.groupHang)setInterval(()=>{},1000);else if(m.groupFail){console.error("Error: no groups");process.exit(1)}else console.log(JSON.stringify({groups:m.groups??[]}))}
else if(argv[1]==="surface.list")console.log(JSON.stringify({workspace_id:m.workspace,surfaces:m.surfaces}));
else console.log(JSON.stringify({surface_id:JSON.parse(stdin).surface_id}));`);
writeFileSync(join(CBIN, "claude"), `#!/bin/bash\necho "$CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN|$PWD|$*" >"${join(OUT, "claude-started.txt")}"\n`);
for (const f of ["cmux", "claude"]) chmodSync(join(CBIN, f), 0o755);
const WS = uuid().toUpperCase(), BROWSER = uuid().toUpperCase();
const CENV = { ...small, PATH: `${CBIN}:${small.PATH}`, CMUX_WORKSPACE_ID: WS, CMUX_SURFACE_ID: surf.C1.toUpperCase(), CMUX_BUNDLED_CLI_PATH: join(CBIN, "cmux"), CMUX_SOCKET_PATH: "/nonexistent/cmux.sock" };
const cmuxCalls = (): { argv: string[]; stdin: string }[] => (existsSync(CCALLS) ? readFileSync(CCALLS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.argv[0] !== "events") : []); // the helper asks for the events
const row = (type: string, id = uuid(), extra = {}) => ({ id, type, title: type, ...extra });
const GOOD = { workspace: WS, surfaces: [row("browser", BROWSER), row("terminal", surf.C1.toUpperCase()), row("browser", uuid(), { dock_scope: "global" })] };
const chatOpen = async (mode: object, env: Record<string, string> = CENV) => {
  writeFileSync(CDB, JSON.stringify(mode));
  const from = cmuxCalls().length, at = performance.now();
  const x = await exec(env, join(ROOT, "bin/cmux-chat-open"));
  return { ...x, ms: Math.round(performance.now() - at), calls: cmuxCalls().slice(from) };
};
const noNav = (x: { calls: { argv: string[] }[] }) => x.calls.every((c) => c.argv.join(" ") === "rpc surface.list -");
const said = /the agent starts without it/;
for (const [name, surfaces] of [["no browser surface", [row("terminal")]], ["two browser surfaces", [row("browser"), row("browser")]], ["only a dock browser", [row("terminal"), row("browser", uuid(), { dock_scope: "global" })]]] as [string, object[]][]) {
  const x = await chatOpen({ workspace: WS, surfaces });
  check("F66", `${name}: nothing is opened or navigated, a message, exit 0`, x.code === 0 && x.calls.length === 1 && noNav(x) && /exactly one/.test(x.err) && said.test(x.err), x);
}
let x = await chatOpen({ ...GOOD, workspace: uuid() });
check("F66", "another workspace answers: nothing is navigated", x.code === 0 && noNav(x) && /another workspace/.test(x.err), x);
check("F66", "no server was started for these refusals", listen().length === 0);
const { CMUX_WORKSPACE_ID: _w, ...noWs } = CENV, { CMUX_SURFACE_ID: _s, ...noSurface } = CENV;
for (const [name, mode, env, text] of [["cmux fails", { fail: true }, CENV, /no socket/], ["cmux prints no JSON", { garbage: true }, CENV, /JSON/], ["cmux is missing", GOOD, { ...CENV, CMUX_BUNDLED_CLI_PATH: "/nonexistent/cmux" }, said], ["no workspace id", GOOD, noWs, /not a cmux terminal/], ["no surface id", GOOD, noSurface, /not a cmux terminal/], ["the sidecar is missing", GOOD, { ...CENV, ORCA_CHAT_DATA_DIR: join(OUT, "no-data") }, /bin\/install/]] as [string, object, Record<string, string>, RegExp][]) {
  x = await chatOpen(mode, env);
  check("F67", `${name}: a message, exit 0, nothing navigated, under 5 s`, x.code === 0 && text.test(x.err) && said.test(x.err) && noNav(x) && x.ms < 5_000, x);
}
const blocker2 = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
x = await chatOpen(GOOD);
blocker2.stop(true);
check("F67", "the port is in use: a message, exit 0, nothing navigated", x.code === 0 && /in use/.test(x.err) && noNav(x), x);
x = await chatOpen({ hang: true });
check("F67", "cmux does not answer: it ends after 15 s, exit 0", x.code === 0 && /no answer/.test(x.err) && x.ms < 18_000 && noNav(x), x);
const cfg = config("cmux.json");
const layout = cfg.commands[0].workspace.layout, [top, bottom] = layout.children.map((c: any) => c.pane.surfaces);
check("F71", "cmux.json: in each command the browser is the first child of a vertical split at 0.88, the terminal has the focus", cfg.commands.length === 6 && cfg.commands.every((c: any) => { const l = c.workspace.layout, [t, b] = l.children.map((x: any) => x.pane.surfaces); return l.direction === "vertical" && l.split === 0.88 && l.children.length === 2 && t.length === 1 && t[0].type === "browser" && !t[0].focus && b.length === 1 && b[0].type === "terminal" && b[0].focus === true; }), cfg);
check("F71", "cmux.json: no key changes the default workspace, and each action and menu entry exists", JSON.stringify(Object.keys(cfg)) === '["app","commands","actions","workspaceGroups"]' && JSON.stringify(cfg.app) === '{"tabBarVisibility":"multiple-tabs","reorderOnNotification":false}' && Object.entries(cfg.actions).every(([k, a]: any) => k === "open-markdown" || a.type === "workspaceCommand" && cfg.commands.some((c: any) => c.name === a.commandName)) && Object.values(cfg.workspaceGroups.byCwd).every((g: any) => JSON.stringify(Object.keys(g)) === '["contextMenu"]' && g.contextMenu.every((m: any) => m.action === "newWorkspace" || cfg.actions[m.action])), Object.keys(cfg));
writeFileSync(CDB, JSON.stringify({ fail: true }));
const shell = await exec(CENV, "/bin/zsh", "-fc", bottom[0].command);
check("F71", "the command of cmux.json starts claude also when cmux-chat-open fails, in the directory of the shell", shell.code === 0 && said.test(shell.err) && readFileSync(join(OUT, "claude-started.txt"), "utf8") === `1|${OUT}|--plugin-dir ${ROOT}/mods/tall-prompt --plugin-dir ${ROOT}/mods/live-text\n`, { shell, started: existsSync(join(OUT, "claude-started.txt")) && readFileSync(join(OUT, "claude-started.txt"), "utf8") });
check("F76", "cmux.json: the start page of each command is dark", cfg.commands.every((c: any) => { const u = c.workspace.layout.children[0].pane.surfaces[0].url; return u.startsWith("data:text/html;base64,") && /background:#1d1d1d/.test(atob(u.split(",")[1])); }), cfg.commands.map((c: any) => c.workspace.layout.children[0].pane.surfaces[0].url));
{ // The script of the page with a small fake document.
  const made: any[] = [], noteEl: any = { textContent: "" }, late: Function[] = [];
  const el = () => { const f: any = { className: "", removed: false, remove() { f.removed = true; } }; made.push(f); return f; };
  const script = followPage.body.match(/<script>([^]*)<\/script>/)![1].replace(/document\.addEventListener[^]*$/, "return show;");
  const show = new Function("location", "document", "fetch", "setTimeout", "clearTimeout", script)({ search: "?cmux=x" }, { getElementById: () => noteEl, createElement: el, body: { append() {} }, visibilityState: "hidden" }, null, (fn: Function) => late.push(fn), () => {});
  const on = () => made.filter((f) => f.className === "on" && !f.removed).map((f) => f.src.slice(4)).join();
  const steps: string[] = [];
  show("A", ""); steps.push(on()); made[0].onload(); steps.push(on());
  show("B", ""); steps.push(on()); show("A", ""); steps.push(on()); made[1].onload(); steps.push(on());
  show("B", ""); steps.push(on()); show(null, "gone"); steps.push(on() + noteEl.textContent); show("C", ""); steps.push(on() + noteEl.textContent); made[2].onload(); steps.push(on() + noteEl.textContent);
  for (const x of ["D", "E", "F", "G"]) { show(x, ""); made.at(-1).onload(); } steps.push(on() + made.filter((f) => !f.removed).length);
  show("H", ""); const before = on(); late.at(-1)!();
  check("F76", "a frame that never reports its load shows after 3 s", before === "G" && on() === "H", [before, on()]);
  check("F76", "a frame shows when it has loaded, the old one stays until then", JSON.stringify(steps) === JSON.stringify(["", "A", "A", "A", "A", "B", "gone", "", "C", "G5"]), steps);
}
check("F71", "each Claude command is in the classic mode", cfg.commands.filter((c: any) => c.name.startsWith("Claude")).every((c: any) => c.workspace.layout.children[1].pane.surfaces[0].command.includes("; CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude")));
const cxCommands = cfg.commands.filter((c: any) => c.name.startsWith("Codex + chat")).map((c: any) => c.workspace.layout.children[1].pane.surfaces[0].command as string);
check("F75", "cmux.json: each Codex command has --no-daemon and --no-alt-screen, and opens the chat", cxCommands.length === 3 && cxCommands.every((c: string) => /cmux-chat-open --new; codex (resume )?--no-daemon --no-alt-screen\b/.test(c)), cxCommands);
writeFileSync(join(CBIN, "codex"), `#!/bin/sh\necho "$*|$PWD" > ${JSON.stringify(join(OUT, "codex-started.txt"))}\n`, { mode: 0o755 });
const cxShell = await exec(CENV, "/bin/zsh", "-fc", cxCommands[0]);
check("F75", "Codex starts also when cmux-chat-open fails", cxShell.code === 0 && said.test(cxShell.err) && readFileSync(join(OUT, "codex-started.txt"), "utf8") === `--no-daemon --no-alt-screen|${OUT}\n`, cxShell);
// It works: a new server, one list call, one navigation. Each 20 ms: is the token in an argv?
let sampling = true, samples = 0;
const inArgv: string[] = [];
const sampler = (async () => {
  while (sampling) {
    const p = Bun.spawn(["/bin/ps", "-Aww", "-o", "command="], { stdout: "pipe" });
    inArgv.push(...(await new Response(p.stdout).text()).split("\n").filter((l) => l.includes(token)));
    samples++;
    await Bun.sleep(20);
  }
})();
x = await chatOpen(GOOD);
sampling = false;
await sampler;
check("F66", "one list call, one navigation of the one browser surface, one group list, no output", x.code === 0 && x.out + x.err === "" && x.calls.map((c) => c.argv.join(" ")).join() === "rpc surface.list -,rpc browser.navigate -,rpc workspace.group.list -" && JSON.parse(x.calls[1].stdin).surface_id === BROWSER && JSON.parse(x.calls[1].stdin).workspace_id === WS, x);
check("F68", "the token is in no argv of any process, and not in what cmux got", inArgv.length === 0 && samples > 2 && !JSON.stringify(cmuxCalls()).includes(token), { samples, inArgv: inArgv.length });
const link = new URL(JSON.parse(x.calls[1].stdin).url), path = link.pathname + link.search;
const { signLink } = await import("../lib/common");
const ticket = (surface: string, ms: number, sig?: string) => { const t = String(Date.now() + ms); return `/cmux-open?cmux=${surface}&until=${t}&sig=${sig ?? signLink(token, surface, t)}`; };
const no = await Promise.all([get(path, { host: "evil.example" }), get(path, { origin: "https://evil.example" }), get(path, {}, "POST")]);
check("F69", "a foreign Host, a foreign Origin, or a POST: refused, and the link is not used up", no.every((r) => r.status === 403), no.map((r) => r.status));
const wrong = await Promise.all([get(path.replace(surf.C1.toUpperCase(), surf.C2)), get(ticket(surf.C1, 60_000, "0".repeat(64))), get(ticket(surf.C1, -1)), get(path.replace(/until=\d+/, "until=99999999999999")), get(ticket("nope", 60_000)), get("/cmux-open")]);
check("F69", "another surface, a forged signature, an old link, a changed time, no UUID, no parameters: 404, no token", wrong.every((r) => r.status === 404 && !r.headers.location), wrong.map((r) => r.status));
const go = await get(path), again = await get(path);
check("F69", "the link leads to the chat of this surface, one time", go.status === 302 && go.headers.location === `/${token}/follow?cmux=${surf.C1.toUpperCase()}` && again.status === 404, [go.status, again.status]);
check("F60", "the page behind the link shows the session of this terminal", (await get(go.headers.location)).status === 200 && (await state(surf.C1)).session === SC1);
const cmuxServer = launch().pid;
const serverEnv = spawnSync("/bin/ps", ["-Eww", "-o", "command=", "-p", String(cmuxServer)], { encoding: "utf8" }).stdout;
check("F70", "the server has no surface, workspace, or socket of cmux in its environment", !/CMUX_(SURFACE_ID|WORKSPACE_ID|SOCKET_PATH)=/.test(serverEnv) && /CMUX_BUNDLED_CLI_PATH=\/usr\/bin\/false/.test(serverEnv));
x = await chatOpen(GOOD);
check("F70", "a second cmux-chat-open keeps the server", x.code === 0 && launch().pid === cmuxServer && x.calls.length === 3, x);
check("F68", "the token is not in the server log", !readFileSync(logFile, "utf8").includes(token) && readFileSync(logFile, "utf8").length > 0);
const down: any = { textContent: "" };
new Function("document", "location", "fetch", "setTimeout", "clearTimeout", script)({ visibilityState: "visible", getElementById: (id: string) => (id === "note" ? down : { textContent: "" }), addEventListener() {} }, { search: q1 }, async () => { throw new Error("down"); }, () => 0, () => {});
await until(() => down.textContent);
check("F67", "the page names cmux-chat-open when the server is off", /Run cmux-chat-open/.test(down.textContent), down.textContent);
// ---- F72 the project group ----
const P = (p: string) => join(OUT, "grp", p), gid: Record<string, string> = {};
for (const d of ["a/b/sub", "a/bc", "none", "main"]) mkdirSync(P(d), { recursive: true });
const git = (...args: string[]) => spawnSync("git", ["-C", P("main"), "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
git("init", "-q"); git("commit", "-q", "--allow-empty", "-m", "x"); git("worktree", "add", "-q", P("wt"));
const grp = (dir: string, members: string[] = []) => ({ id: (gid[dir] ??= uuid().toUpperCase()), name: dir, idempotency_key: "project:" + P(dir), member_workspace_ids: [uuid().toUpperCase(), ...members] });
const GROUPS = [grp("a"), grp("a/b"), grp("main"), { id: uuid(), name: "by hand", idempotency_key: null, member_workspace_ids: [uuid()] }];
const inDir = async (dir: string, mode: object) => {
  writeFileSync(CDB, JSON.stringify({ ...GOOD, groups: GROUPS, ...mode }));
  const from = cmuxCalls().length, at = performance.now();
  const y = await exec(CENV, "/bin/bash", "-c", 'cd "$1" && "$2"', "x", dir, join(ROOT, "bin/cmux-chat-open"));
  const c = cmuxCalls().slice(from);
  return { ...y, ms: Math.round(performance.now() - at), argv: c.map((k) => k.argv[1]), added: c.filter((k) => k.argv[1] === "workspace.group.add").map((k) => JSON.parse(k.stdin)) };
};
for (const [name, dir, want] of [["the folder of a project", P("a/b"), "a/b"], ["a folder below it, the inner project wins", P("a/b/sub"), "a/b"], ["a name that starts the same", P("a/bc"), "a"], ["a worktree outside the folder", P("wt"), "main"]] as [string, string, string][]) {
  const y = await inDir(dir, {});
  check("F72", name + ": one add, to " + want + ", and only list and add", y.code === 0 && y.out + y.err === "" && y.argv.join() === "surface.list,browser.navigate,workspace.group.list,workspace.group.add" && JSON.stringify(y.added) === JSON.stringify([{ group_id: gid[want], workspace_id: WS }]), y);
}
for (const [name, dir, mode] of [["a folder with no project", "/private/tmp", {}], ["a workspace that is in a group, other case", P("a/b"), { groups: [...GROUPS, { id: uuid(), name: "mine", idempotency_key: null, member_workspace_ids: [WS.toLowerCase()] }] }], ["two groups with one folder", P("a/b"), { groups: [...GROUPS, { ...grp("a/b"), id: uuid() }] }], ["the group list fails", P("a/b"), { groupFail: true }], ["no groups", P("a/b"), { groups: [] }]] as [string, string, object][]) {
  const y = await inDir(dir, mode);
  check("F72", name + ": no add, the chat opens, no message, exit 0", y.code === 0 && y.out + y.err === "" && y.added.length === 0 && y.argv.includes("browser.navigate"), y);
}
const hung = await inDir(P("a/b"), { groupHang: true });
check("F72", "the group list hangs: the chat opens, it ends after 3 s, exit 0", hung.code === 0 && hung.err === "" && hung.ms < 6_000 && hung.argv.includes("browser.navigate") && hung.added.length === 0, hung);
r = await chat(small, "stop");
check("F36", "stop stops this server too", r.code === 0 && !alive(cmuxServer), r);

// ---- F40 ----
check("F40", "the real state dirs did not change", snapshot() === realBefore, realPaths);

writeFileSync(join(OUT, "server.log"), log);
writeFileSync(join(OUT, "cmux-calls.json"), JSON.stringify(cmuxCalls(), null, 1));
const failed = results.filter((x) => !x.ok);
writeFileSync(join(OUT, "result.json"), JSON.stringify({ when: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 1).replaceAll(token, "<token>"));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n${join(OUT, "result.json")}`);
process.exit(failed.length ? 1 : 0);
