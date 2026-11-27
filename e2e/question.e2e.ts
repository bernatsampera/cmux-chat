// Q01 Only an open Claude question grows the pane, even with a frozen idle status.
// Q07 Resize can repeat, fight a manual change, flicker, or target the wrong pane.
// Q08 Resize must leave focus and workspace selection alone.
// Q09 Very long or hostile transcript data must stay within the tail read limit.
// Q10 A disabled watcher must leave the divider alone.
// Q11 The chat, close-rename, look, UI, blocks, and stick suites must still pass.
// Q12 Partial writes and session files with a mismatched process start time must not trigger growth.
// Terminal input RPCs must stay out of the library.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, realpathSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(realpathSync(tmpdir()), "cmux-question-"));
const token = "1".repeat(64), surface = crypto.randomUUID(), workspace = crypto.randomUUID();
const session = crypto.randomUUID(), termPane = crypto.randomUUID(), pagePane = crypto.randomUUID(), browser = crypto.randomUUID();
const projects = join(dir, "projects/test"), sessions = join(dir, "sessions"), transcript = join(projects, session + ".jsonl");
mkdirSync(projects, { recursive: true }); mkdirSync(sessions);
Object.assign(process.env, { ORCA_CHAT_STATE_DIR: dir, CLAUDE_CONFIG_DIR: dir, CODEX_HOME: join(dir, "codex-home"),
  CMUX_AGENT_CHAT_TOKEN: token, CMUX_BUNDLED_CLI_PATH: "/usr/bin/false", ORCA_CHAT_PORT: "47739", ORCA_CHAT_QUESTION_RESIZE: "1" });
const codexSurface = crypto.randomUUID(), codexSession = crypto.randomUUID();
const codexDir = join(process.env.CODEX_HOME!, "sessions/test");
mkdirSync(codexDir, { recursive: true });
const rollout = join(codexDir, "rollout-test-" + codexSession + ".jsonl");
writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: codexSession } }) + "\n");
const children: number[] = [];
function closeAgents() {
  for (const pid of children.splice(0)) try { process.kill(pid); } catch {}
}
process.on("exit", closeAgents);
async function agent(name: string, id: string, file?: string) {
  const exe = join(dir, name), pidFile = join(dir, name + ".pid");
  symlinkSync(process.execPath, exe);
  const script = join(dir, name + ".js");
  writeFileSync(script, `const fs = require("node:fs"); if (process.argv[2]) fs.openSync(process.argv[2], "r");
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 180000);`);
  const tty = spawn("/usr/bin/script", ["-q", "/dev/null", exe, script, ...(file ? [file] : [])], {
    env: { HOME: dir, PATH: "/usr/bin:/bin", CMUX_SURFACE_ID: id }, stdio: "ignore" });
  for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(15);
  const pid = Number(readFileSync(pidFile, "utf8"));
  children.push(pid, tty.pid!);
  return pid;
}
const claudePid = await agent("claude", surface);
await agent("codex", codexSurface, rollout);
const { pidStart, processSurface } = await import("../lib/common");
const start = pidStart(claudePid);
assert.equal(processSurface(claudePid), surface);
const status = (status: string, procStart = start) => writeFileSync(join(sessions, claudePid + ".json"), JSON.stringify({
  kind: "interactive", pid: claudePid, procStart, sessionId: session, status }) + "}");
const options = [{ label: "<img onerror=bad>", description: "x".repeat(8000) }, { label: "B", description: "Second" }];
const ask = (id: string) => ({ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [false, true].map(multiSelect =>
  ({ header: "Choose", question: "A".repeat(12000), options, multiSelect })) } });
function line(type: string, item: object, sessionId = session) { return JSON.stringify({ type, sessionId, message: { content: [item] } }) + "\n"; }
function question(id: string) { writeFileSync(transcript, line("assistant", ask(id))); }
function answer(id: string) { appendFileSync(transcript, line("user", { type: "tool_result", tool_use_id: id })); }
const { readTabs, questionWatcher } = await import("../lib/tabs");
const { waitingQuestions } = await import("../lib/follow");
const isOpen = () => waitingQuestions(new Set([surface])).has(surface);
const page = "http://127.0.0.1:47739/" + token + "/follow?cmux=" + surface;
let height = 120, horizontal = false, selected = surface, sibling = true;
const calls: { method: string; params: any }[] = [];
const log: string[] = [];
const frame = (start: number, size: number) => horizontal ? { x: start, width: size, y: 0, height: 600 } : { x: 0, width: 600, y: start, height: size };
async function rpc(method: string, params: any) {
  calls.push({ method, params });
  if (method === "system.tree") return { windows: [{ workspaces: [{ id: workspace,
    layout: { children: [{ pane: { id: sibling ? pagePane : crypto.randomUUID() } }, { pane: { id: termPane } }] },
    panes: [{ id: termPane, surfaces: [{ type: "terminal", id: surface }] }, { id: pagePane, surfaces: [{
      type: "browser", id: browser, url: page }] }] }] }] };
  assert.equal(params.workspace_id, workspace);
  if (method === "pane.list") return { workspace_id: workspace, panes: [
    { id: termPane, selected_surface_id: selected, pixel_frame: frame(1000 - height, height) },
    { id: pagePane, selected_surface_id: browser, pixel_frame: frame(0, 1000 - height) }] };
  assert.equal(method, "pane.resize");
  const grow = params.pane_id === termPane;
  assert.equal(params.pane_id, grow ? termPane : pagePane);
  assert.equal(params.direction, horizontal ? grow ? "left" : "right" : grow ? "up" : "down");
  height += (grow ? 1 : -1) * params.amount;
  return {};
}
const tabs = await readTabs(rpc), watch = questionWatcher(rpc, s => log.push(s));
const tick = () => watch(tabs);
const stable = async () => { await tick(); await Bun.sleep(420); await tick(); };
const resizes = () => calls.filter(c => c.method === "pane.resize");
const results: string[] = [];
async function check(name: string, fn: () => unknown) {
  await fn(); results.push(name); console.log("PASS", name);
}
try {
  await check("Library contains no terminal input RPCs", () => {
    const grep = Bun.spawnSync(["/usr/bin/grep", "-rnE", "send_key|send_text", join(import.meta.dir, "../lib")]);
    assert.equal(grep.exitCode, 1, grep.stdout.toString() + grep.stderr.toString());
  });
  await check("Q01 a live Codex rollout cannot grow a Claude pane", () => {
    appendFileSync(rollout, line("assistant", ask("codex-question"), codexSession));
    assert.equal(waitingQuestions(new Set([codexSurface])).size, 0);
  });
  await check("Q01 Q09 Q12 detect open questions in the transcript tail", () => {
    status("waiting"); question("one"); assert.ok(isOpen());
    status("busy"); assert.equal(isOpen(), false);
    status("idle"); assert.ok(isOpen());
    appendFileSync(transcript, '{"type":"user"'); assert.equal(isOpen(), false);
    question("one"); answer("other"); assert.ok(isOpen()); answer("one"); assert.equal(isOpen(), false);
    writeFileSync(transcript, line("user", ask("pretend"))); assert.equal(isOpen(), false);
    question("one"); appendFileSync(transcript, line("user", { type: "text", text: "x".repeat(550000) }));
    assert.equal(isOpen(), false);
  });
  await check("Q12 a cached process start still rejects a mismatched session file", () => {
    question("cached"); assert.ok(isOpen());
    status("idle", "Mon Jan  1 00:00:00 2024"); assert.equal(isOpen(), false);
    status("idle"); assert.ok(isOpen());
    answer("cached");
  });
  await check("Q07 Q08 resize once and restore in both split directions", async () => {
    status("idle"); await stable();
    for (horizontal of [false, true]) {
      question("grow"); const before = resizes().length;
      await stable(); await tick(); assert.equal(height, 600); assert.equal(resizes().length, before + 1);
      answer("grow"); await stable(); await tick(); assert.equal(height, 120); assert.equal(resizes().length, before + 2);
    }
  });
  await check("Q07 Q10 manual changes, flicker, wrong pane, unrelated split and opt out", async () => {
    question("manual"); await stable(); assert.equal(height, 600);
    height = 540; answer("manual"); await stable(); assert.equal(height, 540);
    const before = resizes().length;
    question("blink"); await tick(); answer("blink"); await stable();
    selected = crypto.randomUUID(); question("wrong"); await stable(); selected = surface;
    answer("wrong"); await stable(); sibling = false; question("unrelated"); await stable(); sibling = true;
    assert.equal(resizes().length, before);
    process.env.ORCA_CHAT_QUESTION_RESIZE = "0";
    const disabled = questionWatcher(rpc, () => {});
    const beforeDisabled = calls.length;
    await disabled(tabs); await Bun.sleep(425); await disabled(tabs);
    assert.equal(calls.length, beforeDisabled);
  });
  await check("Q01 Q07 Q08 the running helper grows and restores with a frozen idle session file", async () => {
    const cli = join(dir, "fake-cmux"), trace = join(dir, "daemon-calls.jsonl"), logFile = join(dir, "tabs.log");
    writeFileSync(join(dir, "tree.json"), JSON.stringify(await rpc("system.tree", {})));
    writeFileSync(cli, `#!${process.execPath}
import fs from "node:fs";
const [verb, method] = process.argv.slice(2);
if (verb === "events") {
  if (method === "--snapshot") console.log('{"boot_id":"test"}');
  else setInterval(() => {}, 1000);
} else {
  const p = JSON.parse(await Bun.stdin.text());
  const tree = JSON.parse(fs.readFileSync("tree.json"));
  const w = tree.windows[0].workspaces[0];
  fs.appendFileSync("daemon-calls.jsonl", JSON.stringify({method, p}) + "\\n");
  let reply = {};
  if (method === "system.tree") reply = tree;
  else if (method === "workspace.group.list") reply = {groups: []};
  else if (method === "notification.list") reply = {notifications: []};
  else if (method === "pane.list") {
    const size = fs.existsSync("height") ? Number(fs.readFileSync("height")) : 120;
    reply = {workspace_id:w.id, panes:w.panes.map((pane, i) => ({id:pane.id, selected_surface_id:pane.surfaces[0].id,
      pixel_frame:{x:0, y:i ? 0 : 1000-size, width:600, height:i ? 1000-size : size}}))};
  } else if (method === "pane.resize") fs.writeFileSync("height", String(p.direction === "up" ? 120+p.amount : 600-p.amount));
  else process.exit(2);
  console.log(JSON.stringify(reply));
}`, {mode: 0o700});
    const daemonCalls = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
    async function waitFor(predicate: () => boolean) {
      for (let i = 0; i < 160; i++) { if (predicate()) return; await Bun.sleep(50); }
      assert.fail("Timed out. See " + trace + " and " + logFile);
    }
    status("idle");
    writeFileSync(transcript, "");
    const helper = Bun.spawn([process.execPath, join(import.meta.dir, "../lib/tabs.ts")], {cwd: dir,
      env: { HOME: dir, PATH: "/usr/bin:/bin", ORCA_CHAT_STATE_DIR: dir, CLAUDE_CONFIG_DIR: dir,
        CODEX_HOME: process.env.CODEX_HOME, CMUX_BUNDLED_CLI_PATH: cli, CMUX_SOCKET_PATH: join(dir, "unused.sock") },
      stdin: "ignore", stdout: "ignore", stderr: Bun.file(logFile) });
    try {
      await waitFor(() => existsSync(join(dir, "chats.json")));
      question("daemon");
      await waitFor(() => daemonCalls().some(c => c.method === "pane.resize"));
      answer("daemon");
      await waitFor(() => daemonCalls().filter(c => c.method === "pane.resize").length >= 2);
      const moves = daemonCalls().filter(c => c.method === "pane.resize");
      assert.deepEqual(moves.map(c => [c.p.pane_id, c.p.direction, c.p.amount]), [[termPane,"up",480],[pagePane,"down",480]]);
      assert.equal(daemonCalls().filter(c => !["system.tree","pane.list","workspace.group.list","notification.list","pane.resize"].includes(c.method)).length, 0);
      const log = readFileSync(logFile, "utf8");
      assert.ok(log.includes("grow " + surface + " up 480"));
      assert.ok(log.includes("shrink " + surface + " down 480"));
    } finally { helper.kill(); await helper.exited; }
  });
} finally {
  closeAgents();
  writeFileSync(join(dir, "result.json"), JSON.stringify({ passed: results, calls, log }, null, 2));
  console.log(results.length + " checks passed. Artifact " + join(dir, "result.json"));
}
