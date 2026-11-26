#!/usr/bin/env bun
// E2E of lib/live.ts: the real pinned server with guard.ts, synthetic transcripts
// and snapshots, a WebSocket client as the page, and the real reducer of the page.
// The ways it can fail are in the header of lib/live.ts (L01 to L23).
// Not here: M01 to M03 (they need a real Claude), and a file of another owner (it needs root).
//
// Run: bun e2e/live.e2e.ts   (needs bin/install first)
// Output: $ORCA_CHAT_E2E_OUT/live-<time>/result.json, server-*.log
// Its own port, home, state, and transcripts. It starts only servers of its own.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(process.env.ORCA_CHAT_E2E_OUT ?? join(tmpdir(), "orca-chat-e2e"), `live-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const HOME = join(OUT, "home"), STATE = join(OUT, "state"), LIVE = join(STATE, "live"), CLAUDE = join(HOME, ".claude"), CODEX = join(HOME, ".codex"), PROJ = join(CLAUDE, "projects/-live");
const DATA = process.env.ORCA_CHAT_DATA_DIR ?? join(homedir(), ".local/share/orca-chat");
const SRC = join(DATA, "cmux-src/agent-chat"), BUN = join(DATA, "bun-1.3.14/package/bin/bun"), TOKEN = "e".repeat(64);
for (const dir of [PROJ, CODEX, STATE]) mkdirSync(dir, { recursive: true });
const { foldEvent } = await import(join(SRC, "src/session.ts"));
const { groupTurns } = await import(join(SRC, "src/turns.ts"));

const results: { id: string; check: string; ok: boolean; evidence?: unknown }[] = [];
function check(id: string, name: string, ok: boolean, evidence?: unknown) {
  results.push({ id, check: name, ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${ok ? "" : " :: " + JSON.stringify(evidence)?.slice(0, 900)}`);
}
const metrics: Record<string, unknown> = {};
async function until<T>(fn: () => T | undefined | false | null, ms = 4_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) {
    const value = fn();
    if (value) return value;
  }
}
const realPaths = [".local/state/orca-chat/live", ".local/state/orca-chat/token"].map((p) => join(homedir(), p));
const touched = () => JSON.stringify(realPaths.map((p) => (existsSync(p) ? statSync(p).ino : null)));
const realBefore = touched();

// ---- the server ----
const port = await new Promise<number>((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
let child: ChildProcess, runs = 0;
process.on("exit", () => child?.kill());
const url = (path: string) => `http://127.0.0.1:${port}/${TOKEN}${path}`;
async function start(src = SRC) {
  const log = openSync(join(OUT, `server-${++runs}.log`), "w", 0o600);
  const env = {
    HOME, USER: "e2e", TMPDIR: tmpdir(), PATH: `${join(DATA, "bun-1.3.14/package/bin")}:/usr/bin:/bin`, CMUX_AGENT_CHAT_PORT: String(port), CMUX_AGENT_CHAT_TOKEN: TOKEN,
    CMUX_AGENT_CHAT_STATE_FILE: join(STATE, "server.json"), CMUX_AGENT_CHAT_LAUNCH_ID: "e2e", CMUX_AGENT_HOOK_STATE_DIR: STATE, CMUX_BUNDLED_CLI_PATH: "/usr/bin/false",
    CMUX_AGENT_MODELS_URL: "http://127.0.0.1:9/off", ORCA_CHAT_STATE_DIR: STATE, CLAUDE_CONFIG_DIR: CLAUDE, CODEX_HOME: CODEX,
  };
  child = spawn(BUN, ["--preload", join(ROOT, "lib/guard.ts"), "server.ts"], { cwd: src, env, stdio: ["ignore", log, log] });
  for (let i = 0; i < 200; i++) {
    if (await fetch(url("/api/sessions")).then((r) => r.ok, () => false)) return;
    await Bun.sleep(50);
  }
  throw new Error(`the server did not start, see ${OUT}/server-${runs}.log`);
}
async function stop() {
  const gone = new Promise((r) => child.once("exit", r));
  child.kill();
  await gone;
}
const log = () => readFileSync(join(OUT, `server-${runs}.log`), "utf8");

// ---- synthetic Claude ----
const uuid = () => crypto.randomUUID() as string;
const store: Record<string, any> = {};
let clock = 0;
const iso = (at = Date.now()) => new Date(at).toISOString();
class Claude {
  id = uuid();
  path = join(PROJ, `${this.id}.jsonl`);
  file = join(LIVE, `${this.id}.json`);
  writer = uuid();
  seq = 0;
  turn = uuid();
  step = 0;
  attempt = 0;
  startedAt = Date.now();
  blocks: any[] = [];
  msg = "";
  constructor(prompt = "question") {
    if (prompt) this.prompt(prompt);
    store[this.id] = { sessionId: this.id, surfaceId: uuid(), cwd: OUT, transcriptPath: this.path, updatedAt: Date.now() / 1000 };
    writeFileSync(join(STATE, "claude-hook-sessions.json"), JSON.stringify({ version: 1, sessions: store, activeSessionsBySurface: {} }));
  }
  write(...lines: any[]) {
    appendFileSync(this.path, lines.map((l) => JSON.stringify({ uuid: uuid(), timestamp: iso(Date.now() + clock++ % 2), sessionId: this.id, cwd: OUT, ...l }) + "\n").join(""));
  }
  prompt(text: string) { this.write({ type: "user", timestamp: iso(Date.now() - 5), message: { role: "user", content: text } }); }
  begin(step?: number) {
    if (step === undefined) this.turn = uuid();
    this.step = step ?? 0;
    this.attempt = 0;
    this.startedAt = Date.now();
    this.blocks = [];
    this.msg = `msg_${uuid()}`;
    this.snap();
  }
  retry() { this.attempt++; this.startedAt = Date.now(); this.blocks = []; this.msg = `msg_${uuid()}`; }
  json(extra: object = {}) { return JSON.stringify({ v: 1, session: this.id, writer: this.writer, seq: ++this.seq, turn: this.turn, step: this.step, attempt: this.attempt, startedAt: this.startedAt, ended: false, blocks: this.blocks, ...extra }); }
  snap(extra: object = {}) { writeFileSync(this.file, this.json(extra), { mode: 0o600 }); }
  set(...blocks: [string, string][]) { this.blocks = blocks.map(([kind, text], i) => ({ i, kind, text })); this.snap(); }
  end() { this.snap({ ended: true, blocks: [] }); }
  // One line per block, all with the stop reason, as Claude Code writes them.
  final(blocks: any[], stop: string | null = "end_turn") { this.write(...blocks.map((b) => ({ type: "assistant", message: { id: this.msg, role: "assistant", stop_reason: stop, content: [b] } }))); }
}
const text = (t: string) => ({ type: "text", text: t });
const think = (t: string) => ({ type: "thinking", thinking: t, signature: "x" });
const tool = (id: string) => ({ type: "tool_use", id, name: "Read", input: { file_path: "/x" } });
const result = (id: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

// ---- the page ----
class Page {
  blocks: any[] = [];
  raw: any[] = [];
  seen: { at: number; blocks: any[] }[] = []; // each state that the page drew
  status = "";
  ws!: WebSocket;
  constructor(readonly id: string) {}
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${TOKEN}/ws`);
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.sessionId !== `t-${this.id}`) return;
      this.raw.push(msg);
      if (msg.kind === "history") (this.blocks = msg.events.reduce(foldEvent, [])), (this.status = msg.session.status);
      else if (msg.kind === "event") this.blocks = foldEvent(this.blocks, msg.evt);
      else if (msg.kind === "session-status") this.status = msg.status;
      else return;
      this.seen.push({ at: Date.now(), blocks: this.blocks });
    };
    await new Promise((done, fail) => { this.ws.onopen = done; this.ws.onerror = fail; });
    this.ws.send(JSON.stringify({ op: "subscribe", sessionId: `t-${this.id}` }));
    await until(() => this.raw.some((e) => e.kind === "history" || e.kind === "no-session"));
    return this;
  }
  close() { this.ws.close(); }
  texts(kind = "assistant") { return this.blocks.filter((b) => b.kind === kind).map((b) => b.text); }
  has(t: string, kind = "assistant") { return this.texts(kind).some((x) => x.includes(t)); }
  ever(t: string) { return this.seen.some((s) => s.blocks.some((b) => b.text?.includes(t))); }
  histories() { return this.raw.filter((e) => e.kind === "history").length; }
}
const open = (c: Claude | { id: string }) => new Page(c.id).open();
const shape = (blocks: any[]) => JSON.stringify(blocks.map(({ open, ...b }) => b));
// The main check: after it settles, the page is the same as a page that loads now.
async function same(id: string, c: Claude, ...pages: Page[]) {
  const ok = await until(() => pages.every((p) => p.status !== "x" && !p.blocks.some((b) => b.kind === "assistant" && b.open)), 1_500);
  await Bun.sleep(300);
  const fresh = await open(c);
  await Bun.sleep(250);
  fresh.close();
  check(id, "the page is the same as after a reload", Boolean(ok) && pages.every((p) => shape(p.blocks) === shape(fresh.blocks)), { page: pages.map((p) => shape(p.blocks)), fresh: shape(fresh.blocks) });
}
const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") + " end.";
// Streams a text in pieces, with the delay from the write to the page.
async function stream(c: Claude, page: Page, before: [string, string][], kind: string, full: string, pieces = 12, pause = 100) {
  const delays: number[] = [];
  for (let n = 1; n <= pieces; n++) {
    const part = full.slice(0, Math.ceil((full.length * n) / pieces));
    c.set(...before, [kind, part]);
    const at = Date.now();
    const seen = await until(() => page.texts(kind === "text" ? "assistant" : "thinking").some((t) => t.endsWith(part)), 1_500);
    delays.push(seen ? Date.now() - at : -1);
    await Bun.sleep(Math.max(0, pause - (Date.now() - at)));
  }
  return delays;
}
const stats = (ms: number[]) => ({ n: ms.length, min: Math.min(...ms), median: [...ms].sort((a, b) => a - b)[ms.length >> 1], max: Math.max(...ms) });

await start();
check("L18", "the folder of the snapshots is private", (statSync(LIVE).mode & 0o777) === 0o700, (statSync(LIVE).mode & 0o777).toString(8));

// ---- L01 one answer ----
{
  const c = new Claude(), p = await open(c);
  await until(() => p.blocks.length === 1);
  c.begin();
  const delays = await stream(c, p, [], "text", LONG, 20);
  metrics.snapshotToPage = stats(delays);
  check("L01", "the text grows on the page while it streams", delays.every((d) => d >= 0 && d < 700) && new Set(p.seen.map((s) => s.blocks.at(-1)?.text)).size >= 15, delays);
  check("L17", "an open answer: the turn is not done", groupTurns(p.blocks, p.status).at(-1).done === false && p.texts().length === 1);
  c.final([text(LONG)]);
  await until(() => p.blocks.some((b) => b.kind === "footer"));
  check("L01", "the final text shows one time", p.texts().length === 1 && p.texts()[0] === LONG, p.texts());
  await Bun.sleep(400);
  c.snap(); // late: the transcript has it already
  await Bun.sleep(500);
  check("L01", "a late snapshot does not show it again", p.texts().length === 1 && p.histories() === 1, p.texts());
  c.end();
  check("L17", "then the turn is done", groupTurns(p.blocks, p.status).at(-1).done === true);
  await same("L01", c, p);
  // the next turn, in the same page
  c.prompt("second");
  await Bun.sleep(30);
  c.begin();
  c.set(["text", "Second answer"]);
  check("L01", "the next turn is live too", Boolean(await until(() => p.has("Second answer"))), p.texts());
  // the final line and the snapshot at the same time, 20 times
  let doubled = 0;
  for (let n = 0; n < 20; n++) {
    const t = `same time ${n}`;
    c.begin(n + 1);
    c.set(["text", t.slice(0, 6)]);
    await Bun.sleep(n * 15);
    c.set(["text", t]);
    c.final([text(t), tool(`t${n}`)], "tool_use");
    c.write(result(`t${n}`));
    await until(() => p.texts().includes(t));
    if (p.texts().filter((x) => x.startsWith(t.slice(0, 6)) && (x === t || x === t.slice(0, 6))).length !== 1) doubled++;
  }
  c.end();
  check("L01", "snapshot and transcript at the same time, 20 times: never twice", doubled === 0, doubled);
  await same("L10", c, p);
  p.close();
}

// ---- L02 L16 a second page, a page in the middle ----
{
  const c = new Claude(), p = await open(c);
  c.begin();
  for (let n = 1; n <= 30; n++) { c.set(["thinking", "deep thought"], ["text", LONG.slice(0, n * 5)]); await Bun.sleep(30); }
  await until(() => p.has(LONG.slice(0, 150)));
  const q = await open(c);
  await until(() => q.blocks.length >= 3, 1_000);
  const live = q.raw.filter((e) => e.kind === "event" && ["delta", "thinking"].includes(e.evt.kind)).length;
  check("L02", "a page in the middle has all the live text at once", shape(q.blocks) === shape(p.blocks) && q.has(LONG.slice(0, 150)), { q: shape(q.blocks), p: shape(p.blocks) });
  check("L16", "it gets one event per live block, the history has none", live === 2 && q.raw[0].events.every((e: any) => e.kind === "user"), { live, first: q.raw[0].events });
  c.set(["thinking", "deep thought"], ["text", LONG]);
  await until(() => p.has(LONG) && q.has(LONG));
  check("L02", "both pages grow", p.texts().join() === LONG && q.texts().join() === LONG, [p.texts(), q.texts()]);
  c.final([think("deep thought"), text(LONG)]);
  c.end();
  await until(() => p.blocks.some((b) => b.kind === "footer") && q.blocks.some((b) => b.kind === "footer"));
  check("L10", "thinking and text come in one go at the end: each shows once, with no reload", p.texts().length === 1 && p.texts("thinking").join() === "deep thought" && p.histories() === 1 && q.histories() === 1, { p: shape(p.blocks), h: [p.histories(), q.histories()] });
  await same("L02", c, p, q);
  // only the second page is left
  p.close();
  c.prompt("third"); await Bun.sleep(20); c.begin(); c.set(["text", "only q"]);
  check("L02", "a page that is closed does not stop the other", Boolean(await until(() => q.has("only q"))));
  c.final([text("only q")]); c.end();
  q.close();
}

// ---- L03 a restart of the server ----
{
  const c = new Claude();
  let p = await open(c);
  c.begin();
  c.set(["text", "half of the"]);
  await until(() => p.has("half of the"));
  await stop(); await start();
  p = await open(c);
  check("L03", "after a restart in the middle the live text is there, once", Boolean(await until(() => p.texts().join() === "half of the")), p.texts());
  c.set(["text", "half of the answer"]);
  await until(() => p.has("half of the answer"));
  c.final([text("half of the answer")]); // no end: the server is stopped first
  await stop(); await start();
  p = await open(c);
  await Bun.sleep(700);
  check("L03", "after a restart just after the final line it shows once", p.texts().join("|") === "half of the answer", p.texts());
  // a message with no end of the turn: only the count of the lines says it
  c.begin(1);
  c.set(["text", "Let me look"]);
  c.final([text("Let me look"), tool("r")], "tool_use");
  await stop(); await start();
  p = await open(c);
  await Bun.sleep(700);
  check("L03", "the same in the middle of a turn", p.texts().filter((t) => t === "Let me look").length === 1, p.texts());
  c.end();
  await same("L03", c, p);
  p.close();
}

// ---- L04 L12 thinking ----
for (const [name, live, final, reload] of [["the same", "I think so", "I think so", 1], ["longer", "I think", "I think so", 1], ["other", "I think no", "I reason differently", 2]] as const) {
  const c = new Claude(), p = await open(c);
  c.begin();
  await stream(c, p, [], "thinking", live, 4);
  check("L04", `thinking is live (${name})`, p.texts("thinking").join() === live, p.texts("thinking"));
  c.final([think(final), tool("a")], "tool_use");
  await until(() => p.blocks.some((b) => b.kind === "tool"));
  await Bun.sleep(100);
  check("L04", `final thinking shows once (${name})`, p.texts("thinking").join("|") === final && p.histories() <= reload, { t: p.texts("thinking"), h: p.histories() });
  c.end();
  await same("L04", c, p);
  p.close();
}
{
  const c = new Claude(), p = await open(c);
  c.begin(); c.set(["text", "the streamed text"]);
  await until(() => p.has("the streamed"));
  c.final([text("The text of another mod")]); c.end();
  await until(() => p.has("another mod"));
  check("L12", "the final text wins", p.texts().join("|") === "The text of another mod", p.texts());
  c.begin(1); c.set(["text", "streamed again"]);
  await until(() => p.has("streamed again"));
  c.final([text("changed again"), tool("k")], "tool_use");
  await until(() => p.has("changed again"));
  c.snap(); // late
  await Bun.sleep(500);
  check("L12", "a late snapshot with the streamed text does not show", !p.has("streamed again"), p.texts());
  c.end();
  await same("L12", c, p);
  // the stream has an empty block that gets no line
  c.begin(2); c.set(["text", ""], ["text", "after an empty block"]);
  await until(() => p.has("after an empty"));
  c.final([text("after an empty block")], null);
  await Bun.sleep(700);
  c.snap();
  await Bun.sleep(400);
  check("L01", "fewer lines than blocks: once", p.texts().filter((x) => x === "after an empty block").length === 1, p.texts());
  c.end();
  await same("L12", c, p);
  p.close();
}

// ---- L05 L06 interrupt, crash, resume, old files ----
{
  const c = new Claude(), p = await open(c);
  c.begin(); c.set(["text", "It starts with"]);
  await until(() => p.has("It starts"));
  c.final([text("It starts with")], null);
  c.write({ type: "user", message: { role: "user", content: [text("[Request interrupted by user]")] } });
  await Bun.sleep(600); // the end of the step is late
  check("L05", "interrupt with a partial line: once, and the turn is done", p.texts().join("|") === "It starts with" && p.blocks.at(-1).kind === "footer", shape(p.blocks));
  c.end();
  await same("L05", c, p);
  c.prompt("again"); await Bun.sleep(20); c.begin(); c.set(["text", "no line for this"]);
  await until(() => p.has("no line"));
  c.end();
  c.write({ type: "user", message: { role: "user", content: [text("[Request interrupted by user]")] } });
  check("L05", "interrupt with no line: the text goes away at once", Boolean(await until(() => !p.has("no line"), 1_500)), p.texts());
  await same("L05", c, p);
  c.prompt("third"); await Bun.sleep(20); c.begin(); c.set(["text", "ends with no line"]);
  await until(() => p.has("ends with"));
  c.end();
  const at = Date.now();
  await until(() => !p.has("ends with"), 5_000);
  metrics.endWithNoLineMs = Date.now() - at;
  check("L05", "a step that ends with no line at all: the text goes away", !p.has("ends with"), p.texts());
  c.begin(1); c.set(["text", "the crash"]);
  await until(() => p.has("the crash"));
  c.prompt("after the resume");
  check("L05", "crash, then a resume with a prompt: the old text goes away at once", Boolean(await until(() => p.has("after the resume", "user") && !p.has("the crash"), 1_500)), p.texts());
  const q = await open(c);
  await Bun.sleep(500);
  check("L06", "a page that opens then does not show it", !q.ever("the crash"), q.texts());
  q.close();
  await same("L05", c, p);
  // crash, nothing after it
  await Bun.sleep(20);
  c.begin(); c.set(["text", "a lonely crash"]);
  await until(() => p.has("a lonely"));
  const t0 = Date.now();
  await until(() => !p.has("a lonely"), 16_000);
  metrics.crashMs = Date.now() - t0;
  check("L05", "a crash and nothing after it: the text goes away", !p.has("a lonely"), p.texts());
  p.close();
  c.set(["text", "yesterday"]);
  utimesSync(c.file, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  const r = await open(c);
  await Bun.sleep(500);
  check("L06", "an old file shows nothing", !r.ever("yesterday"), r.texts());
  r.close();
}

// ---- L07 L08 retry, another step, another writer ----
{
  const c = new Claude(), p = await open(c);
  c.begin(); c.set(["thinking", "plan one"], ["text", "First try of the ans"]);
  await until(() => p.has("First try"));
  c.write({ type: "system", subtype: "api_error", content: "Overloaded" });
  c.retry(); c.set(["text", "Another"]);
  await until(() => p.has("Another"));
  check("L07", "a retry: only the new text, once", p.texts().join("|") === "Another" && !p.has("plan one", "thinking"), shape(p.blocks));
  c.set(["text", "Another answer"]);
  await until(() => p.has("Another answer"));
  c.final([text("Another answer")]); c.end();
  await same("L07", c, p);
  c.prompt("two"); await Bun.sleep(20); c.begin(); c.set(["text", "attempt with the same key"]);
  await until(() => p.has("attempt with"));
  c.set(["text", "restarted"]); // a retry that the mod did not see
  await until(() => p.has("restarted"));
  check("L07", "other text in the same step: the old text goes", !p.has("attempt with") && p.has("restarted"), p.texts());
  const old = c.json({ writer: "other-process", turn: "other", blocks: [{ i: 0, kind: "text", text: "from the second Claude" }] });
  writeFileSync(c.file, old);
  await Bun.sleep(400);
  check("L08", "a second Claude with the same session does not mix in", !p.ever("second Claude") && p.texts().at(-1) === "restarted", p.texts());
  c.set(["text", "restarted well"]);
  await until(() => p.has("restarted well"));
  c.final([text("restarted well")]); c.end();
  await same("L08", c, p);
  c.prompt("three"); await Bun.sleep(20); c.begin(); c.set(["text", "step zero"]);
  await until(() => p.has("step zero"));
  c.begin(1); c.set(["text", "step one"]);
  await until(() => p.has("step one"));
  check("L08", "the next step starts with no line of the old one: no mix", !p.texts().some((t) => t.includes("step zero") && t.includes("step one")) && !p.has("step zerostep"), p.texts());
  c.final([text("step one")]); c.end();
  await same("L08", c, p);
  p.close();
}

// ---- L09 something in the middle ----
{
  const c = new Claude(), p = await open(c);
  c.write({ type: "assistant", message: { id: "m0", role: "assistant", stop_reason: "tool_use", content: [tool("bg")] } });
  await Bun.sleep(5);
  c.begin(1); c.set(["thinking", "hm"], ["text", "Before the"]);
  await until(() => p.has("Before the"));
  const n = p.seen.length;
  c.write({ type: "queue-operation", operation: "enqueue", content: "do this next" });
  await until(() => p.has("Queued: do this next", "status"));
  c.set(["thinking", "hm"], ["text", "Before the queue"]);
  await until(() => p.has("Before the queue"));
  check("L09", "a queued message: one block, after the status", p.texts().join("|") === "Before the queue" && p.texts("thinking").join("|") === "hm", shape(p.blocks));
  check("L09", "the live text did not go away for a moment", p.seen.slice(n).filter((s) => !s.blocks.some((b) => b.text?.startsWith("Before"))).length <= 2, p.seen.slice(n).map((s) => shape(s.blocks)));
  c.write(result("bg"));
  await until(() => p.blocks.some((b) => b.kind === "tool" && b.status === "ok"));
  c.write({ type: "system", subtype: "api_error", content: "warn" });
  await until(() => p.blocks.some((b) => b.kind === "error"));
  c.set(["thinking", "hm"], ["text", "Before the queue and after"]);
  await until(() => p.has("and after"));
  c.final([think("hm"), text("Before the queue and after"), tool("z")], "tool_use");
  c.write(result("z"));
  c.end();
  await until(() => p.blocks.filter((b) => b.kind === "tool" && b.status === "ok").length === 2);
  check("L09", "a tool result and an error in the middle: still one block", p.texts().join("|") === "Before the queue and after", shape(p.blocks));
  await same("L09", c, p);
  p.close();
}

// ---- L10 L11 block orders ----
{
  const c = new Claude(), p = await open(c);
  c.begin();
  c.set(["thinking", ""], ["thinking", "A."], ["thinking", "B."], ["text", "one"]);
  await until(() => p.has("one"));
  check("L10", "two thinking blocks and a text", p.texts("thinking").join("|") === "A.B." && p.texts().join("|") === "one", shape(p.blocks));
  c.set(["thinking", ""], ["thinking", "A."], ["thinking", "B."], ["text", "one"], ["text", "two"], ["tool", ""], ["text", "three"]);
  await Bun.sleep(400);
  check("L10", "a second text, and a text after a tool, wait for their place", p.texts().join("|") === "one", p.texts());
  c.final([think(""), think("A."), think("B."), text("one"), text("two"), tool("q"), text("three")], "tool_use");
  c.end();
  await until(() => p.has("three"));
  check("L10", "then all show once, in order", p.texts().join("|") === "one|two|three", p.texts());
  await same("L10", c, p);
  // one line per block, while it streams
  c.begin(1);
  c.set(["thinking", "X"], ["text", "alpha"]);
  await until(() => p.has("alpha"));
  c.final([think("X")], null);
  c.set(["thinking", "X"], ["text", "alpha beta"]);
  await until(() => p.has("alpha beta"));
  c.final([text("alpha beta")], null);
  c.set(["thinking", "X"], ["text", "alpha beta"], ["text", "gamma"]);
  await until(() => p.has("gamma"));
  c.final([text("gamma")], null);
  c.end();
  await Bun.sleep(300);
  check("L10", "lines that come one by one", p.texts().slice(-2).join("|") === "alpha beta|gamma", p.texts());
  await same("L10", c, p);
  for (let n = 2; n < 12; n++) { c.begin(n); c.set(["text", `fast ${n}`]); await Bun.sleep(20); c.final([text(`fast ${n}`), tool(`f${n}`)], "tool_use"); c.write(result(`f${n}`)); }
  c.end();
  await until(() => p.has("fast 11"));
  await same("L10", c, p);
  // the same words in two steps
  for (let n = 12; n < 14; n++) { c.begin(n); await Bun.sleep(10); c.set(["text", "Done."]); await Bun.sleep(250); c.final([text("Done."), tool(`d${n}`)], "tool_use"); c.write(result(`d${n}`)); await Bun.sleep(10); }
  c.end();
  await until(() => p.texts().filter((t) => t === "Done.").length === 2);
  check("L10", "the same text in two steps shows two times", p.texts().filter((t) => t === "Done.").length === 2, p.texts());
  await same("L10", c, p);
  p.close();
}
{
  const c = new Claude(), p = await open(c);
  c.begin(); c.set(["thinking", "not kept"], ["text", "Hello"]);
  await until(() => p.has("Hello"));
  check("L11", "the text after it is live", p.has("not kept", "thinking"));
  c.final([think(""), text("Hello there")]); c.end();
  await until(() => p.has("Hello there"));
  await Bun.sleep(200);
  check("L11", "the transcript keeps no thinking: the page neither", p.texts("thinking").length === 0 && p.texts().join("|") === "Hello there", shape(p.blocks));
  await same("L11", c, p);
  p.close();
}

// ---- L13 the transcript is replaced ----
{
  const c = new Claude(), p = await open(c);
  c.begin(); c.set(["text", "before the cut"]);
  await until(() => p.has("before the cut"));
  writeFileSync(c.path, ""); c.prompt("new start"); // shorter
  await until(() => p.has("new start", "user"));
  c.begin(); c.set(["text", "after the cut"]);
  await until(() => p.has("after the cut"));
  check("L13", "a cut transcript: only the new text", p.texts().join("|") === "after the cut", p.texts());
  c.final([text("after the cut")]); c.end();
  await same("L13", c, p);
  p.close();
}

// ---- L14 L15 L19 L23 L18 other sessions and bad files ----
{
  const a = new Claude("a"), b = new Claude("b"), pa = await open(a), pb = await open(b);
  a.begin(); a.set(["text", "text of a"]);
  await until(() => pa.has("text of a"));
  check("L14", "another session does not get it", !pb.ever("text of a"));
  writeFileSync(b.file, a.json());
  await Bun.sleep(400);
  check("L14", "a file with another session in it shows nothing", !pb.ever("text of a"));
  a.write({ type: "assistant", isSidechain: true, message: { id: "side", role: "assistant", stop_reason: "end_turn", content: [text("subagent words")] } });
  a.set(["text", "text of a goes on"]);
  await until(() => pa.has("goes on"));
  check("L14", "a line of a subagent does not show or end the live text", !pa.ever("subagent words") && pa.texts().join() === "text of a goes on", pa.texts());
  // /clear: the same process, a new session id
  a.end();
  const n = new Claude("after clear");
  n.writer = a.writer; n.begin(); n.set(["text", "new session"]);
  const pn = await open(n);
  await until(() => pn.has("new session"));
  await Bun.sleep(2_500);
  check("L15", "/clear: the new text is on the new page only, the old text is gone", pn.has("new session") && !pa.ever("new session") && pa.texts().length === 0, [pa.texts(), pn.texts()]);

  const bad = new Claude("bad"), p = await open(bad);
  bad.begin();
  const B = [{ i: 0, kind: "text", text: "BAD" }];
  const tries: Record<string, string> = {
    "not JSON": "{", empty: "", "a number": "7", "an array": "[]", null: "null", "wrong version": bad.json({ v: 2, blocks: B }), "blocks is text": bad.json({ blocks: "BAD" }), "text is a number": bad.json({ blocks: [{ i: 0, kind: "text", text: 1 }] }),
    "other kind": bad.json({ blocks: [{ i: 0, kind: "user", text: "BAD" }] }), "index goes back": bad.json({ blocks: [{ i: 1, kind: "text", text: "BAD" }, ...B] }), "index is text": bad.json({ blocks: [{ i: "0", kind: "text", text: "BAD" }] }),
    "ended is missing": bad.json({ ended: undefined, blocks: B }), "start is text": bad.json({ startedAt: "0", blocks: B }), "too many blocks": bad.json({ blocks: Array.from({ length: 501 }, (_, i) => ({ i, kind: "text", text: "BAD" })) }), "too big": bad.json({ blocks: [{ i: 0, kind: "text", text: "BAD".padEnd(5 << 20) }] }),
  };
  const shown: string[] = [];
  const look = async (name: string) => { await Bun.sleep(330); if (p.ever("BAD")) shown.push(name), (p.seen = []); };
  for (const [name, body] of Object.entries(tries)) { writeFileSync(bad.file, body); await look(name); }
  const good = bad.json({ blocks: B }), other = join(OUT, "target.json");
  writeFileSync(other, good);
  renameSync(bad.file, bad.file + ".1"); symlinkSync(other, bad.file); await look("symlink");
  renameSync(bad.file, bad.file + ".2"); linkSync(other, bad.file); await look("hard link");
  renameSync(bad.file, bad.file + ".3"); spawnSync("/usr/bin/mkfifo", [bad.file]); await look("pipe");
  renameSync(bad.file, bad.file + ".4"); mkdirSync(bad.file); await look("folder");
  renameSync(bad.file, bad.file + ".5");
  chmodSync(LIVE, 0o755); bad.set(["text", "BAD"]); await look("open folder"); chmodSync(LIVE, 0o700);
  check("L18", `${Object.keys(tries).length + 5} bad files: nothing shows`, shown.length === 0, shown);
  bad.snap(); // half of it, then all of it
  const whole = bad.json({ blocks: [{ i: 0, kind: "text", text: "half then whole" }] });
  writeFileSync(bad.file, whole.slice(0, 60)); await Bun.sleep(200); writeFileSync(bad.file, whole);
  check("L18", "a half write, then the whole: it shows", Boolean(await until(() => p.has("half then whole"))), p.texts());
  check("L23", "and the others still work", Boolean((n.set(["text", "new session goes on"]), await until(() => pn.has("goes on")))));

  // Codex with a UUID and a snapshot of that name
  const id = uuid(), rollout = join(OUT, `rollout-${id}.jsonl`);
  const say = (t: string) => appendFileSync(rollout, JSON.stringify({ timestamp: iso(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: t }] } }) + "\n");
  writeFileSync(rollout, JSON.stringify({ timestamp: iso(), type: "session_meta", payload: { id, cwd: OUT } }) + "\n"); say("codex one");
  writeFileSync(join(STATE, "codex-hook-sessions.json"), JSON.stringify({ version: 1, sessions: { [id]: { sessionId: id, surfaceId: uuid(), cwd: OUT, transcriptPath: rollout, updatedAt: Date.now() / 1000 } }, activeSessionsBySurface: {} }));
  writeFileSync(join(LIVE, `${id}.json`), JSON.stringify({ ...JSON.parse(n.json()), session: id, blocks: B }));
  const px = await open({ id });
  await until(() => px.has("codex one")); say("codex two"); await until(() => px.has("codex two"));
  check("L19", "a Codex chat does not read the file", px.texts().join("|") === "codex one|codex two" && !px.ever("BAD"), px.texts());
  const plain = new Claude("plain"), pp = await open(plain);
  plain.msg = "m"; plain.final([think("t"), text("no mod")]);
  await until(() => pp.has("no mod"));
  check("L19", "a Claude with no mod: as before", pp.texts().join() === "no mod" && pp.histories() === 1, shape(pp.blocks));
  for (const x of [pa, pb, pn, p, px, pp]) x.close();
}

// ---- L16 L17 history and status ----
{
  const c = new Claude(), p = await open(c);
  const old = new Date(Date.now() - 60_000);
  utimesSync(c.path, old, old); // no line for a minute
  const q0 = new Claude(); // only to see the difference
  utimesSync(q0.path, old, old);
  const q = await open(q0);
  c.begin();
  for (let n = 1; n <= 300; n++) { c.set(["text", LONG.slice(0, n)]); await Bun.sleep(10); }
  await until(() => p.has(LONG.slice(0, 300)));
  const fresh = await open(c);
  await Bun.sleep(250);
  check("L16", "300 snapshots: the history has 1 event", fresh.raw.find((e) => e.kind === "history").events.length === 1, fresh.raw[0].events);
  check("L17", "no line for a minute, but it streams: running", p.status === "running" && q.status !== "running", [p.status, q.status]);
  c.final([text(LONG)]); c.end();
  await until(() => p.status === "idle", 3_000);
  check("L17", "after the end: idle, one turn, done", p.status === "idle" && groupTurns(p.blocks, p.status).length === 1 && groupTurns(p.blocks, p.status)[0].done, [p.status, shape(p.blocks)]);
  c.snap({ blocks: [{ i: 0, kind: "text", text: LONG }] });
  await Bun.sleep(2_500);
  check("L17", "a late snapshot does not make it run again", p.status === "idle", p.status);
  for (const x of [p, q, fresh]) x.close();
}

// ---- L20 read-only ----
{
  const c = new Claude("ro"), p = await open(c);
  const codes: number[] = [];
  for (const path of ["/live", `/live/${c.id}`, "/api/sessions"]) for (const method of ["POST", "PUT", "DELETE"]) codes.push(await fetch(url(path), { method, body: "{}" }).then((r) => r.status));
  check("L20", "no network write", codes.every((s) => s === 405), codes);
  p.ws.send(JSON.stringify({ op: "send", sessionId: `t-${c.id}`, prompt: "BAD" }));
  p.ws.send("not json"); p.ws.send("null"); p.ws.send("7");
  p.ws.send(JSON.stringify({ op: "subscribe", sessionId: { toString: 1 } }));
  await Bun.sleep(300);
  check("L20", "send and broken messages change nothing", !p.blocks.some((b) => b.kind === "error") && p.ws.readyState === 1 && (await fetch(url("/api/sessions"))).ok, shape(p.blocks));
  p.close();
}

// ---- L22 the cost ----
{
  const cpu = () => { const [m, s] = spawnSync("/bin/ps", ["-o", "cputime=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.trim().split(":"); return Number(m) * 60 + Number(s); };
  const all = Array.from({ length: 20 }, (_, n) => new Claude(`cost ${n}`));
  const pages = await Promise.all(all.map(open));
  await Bun.sleep(1_000);
  let at = cpu(); await Bun.sleep(5_000); const idle = cpu() - at;
  for (const c of all) c.begin();
  at = cpu();
  for (let n = 1; n <= 50; n++) { for (const c of all) c.set(["text", LONG.slice(0, n * 6)]); await Bun.sleep(100); }
  const busy = cpu() - at;
  for (const c of all) c.end();
  for (const x of pages) x.close();
  await Bun.sleep(3_000);
  at = cpu(); await Bun.sleep(5_000); const none = cpu() - at;
  metrics.cpuSecondsPer5s = { "20 open pages, nothing streams": idle, "20 pages, all stream": busy, "20 sessions, no page": none };
  check("L22", "20 sessions: cheap when idle (under 5 percent of a core), and when all stream (under 40 percent)", idle < 0.25 && busy < 2 && none < 0.25, metrics.cpuSecondsPer5s);
}
check("L18", "no text of a snapshot is in the log", !/word1|BAD|half of/.test(log()), log().slice(-500));
await stop();

// ---- L21 another pin ----
{
  const pin = join(OUT, "pin"), src = join(pin, "agent-chat");
  mkdirSync(pin);
  cpSync(SRC, src, { recursive: true, filter: (f) => !f.startsWith(join(SRC, "node_modules")) });
  symlinkSync(join(SRC, "node_modules"), join(src, "node_modules"));
  symlinkSync(join(SRC, "../web"), join(pin, "web"));
  const parser = join(src, "adapters/transcript.ts"), code = readFileSync(parser, "utf8");
  writeFileSync(parser, code.replace("        sess.emit(evt);\n", "        sess.emit( evt );\n"));
  await start(src);
  const c = new Claude("pin"), p = await open(c);
  c.begin(); c.set(["text", "LIVE"]);
  c.write({ type: "queue-operation", operation: "enqueue", content: "still works" });
  await until(() => p.has("still works", "status"));
  c.final([text("the end")]);
  await until(() => p.has("the end"));
  check("L21", "a new parser: a log line, no live text, the rest works", /live text is off: the parser has changed/.test(log()) && !p.ever("LIVE") && p.has("the end") && p.has("still works", "status"), { log: log(), b: shape(p.blocks) });
  p.close();
  await stop();
}
check("L19", "the real token and the real folder of snapshots are as before", touched() === realBefore, [realBefore, touched()]);

const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(OUT, "result.json"), JSON.stringify({ at: iso(), port, passed: results.length - failed, failed, metrics, results }, null, 1));
console.log(`${JSON.stringify(metrics)}\n${results.length - failed} passed, ${failed} failed\n${OUT}/result.json`);
process.exit(failed ? 1 : 0);
