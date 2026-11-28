// An idle session can show Done in the page and strip while its agent or MCP tool still runs.
// A partial append, duplicate notice or running notice can change the count too early.
// A terminal notification or TaskStop can leave a finished task open.
// Old launches, sidechain launches, shell commands and monitors can inflate the count.
// Background work can hide a busy, waiting, shell or asked state.
// A large transcript can block a poll, make each poll read old bytes again, or show Working while it catches up.

import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "bun:test";

const dir = fs.mkdtempSync(join(tmpdir(), "cmux-background-"));
const surface = crypto.randomUUID(), sessionId = crypto.randomUUID();
const projects = join(dir, "projects/test"), sessions = join(dir, "sessions");
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(sessions);
Object.assign(process.env, { ORCA_CHAT_STATE_DIR: dir, CLAUDE_CONFIG_DIR: dir,
  CODEX_HOME: join(dir, "codex"), CMUX_BUNDLED_CLI_PATH: "/usr/bin/false" });
const transcript = join(projects, sessionId + ".jsonl");
fs.writeFileSync(transcript, "");
const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 180000)"], { env: { CMUX_SURFACE_ID: surface } });
const results: string[] = [], reads: { offset: number; bytes: number }[] = [];
const read = fs.readSync;
let inode = fs.statSync(transcript).ino;
mock.module("node:fs", () => ({ ...fs, readSync(fd, buffer, start, length, offset) {
  const bytes = read(fd, buffer, start, length, offset);
  if (fs.fstatSync(fd).ino === inode) reads.push({ offset, bytes });
  return bytes;
} }));
try {
  const common = await import("../lib/common");
  const { pidStart, CHATS_FILE } = common;
  let timeout = false, attempts = 0;
  mock.module("../lib/common", () => ({ ...common, pidStart(pid: number) {
    if (pid === child.pid) { attempts++; if (timeout) return ""; }
    return pidStart(pid);
  } }));
  const { followSurface, backgroundTerminals } = await import("../lib/follow");
  const procStart = pidStart(child.pid);
  assert.ok(procStart);
  const status = (status: string) => fs.writeFileSync(join(sessions, child.pid + ".json"),
    JSON.stringify({ kind: "interactive", pid: child.pid, sessionId, procStart, status }));
  status("idle");
  fs.writeFileSync(CHATS_FILE, JSON.stringify({ pid: process.pid, projects: [{ id: "test", chats: [
    { terminal: surface, title: "Test", unread: true, workspace: crypto.randomUUID() }] }] }));
  const append = (row: object) => fs.appendFileSync(transcript, JSON.stringify(row) + "\n");
  const launch = (content: unknown, extra = {}, name = typeof content === "string" && content.startsWith("MCP tool") ? "mcp__brain__exec" : "Agent") => {
    const id = crypto.randomUUID();
    append({ type: "assistant", message: { content: [{ type: "tool_use", id, name }] } });
    append({ type: "user", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, ...extra });
  };
  const agent = "Async agent launched successfully.\nagentId: abc123 (use this ID to resume)";
  const mcp = 'MCP tool "brain-live/exec" is still running after 120s. It was moved to the background as task ktyap7ywa and keeps running; ...';
  const notice = (id: string, status: string) => '<task-notification>\n<task-id>' + id +
    '</task-id>\n<status>' + status + '</status>\n</task-notification>';
  async function expectState(expected: string, background?: object) {
    const state = await followSurface(surface);
    assert.equal(state.status, expected);
    assert.equal(state.chats?.[0]?.status, expected);
    assert.deepEqual(state.background, background);
    assert.deepEqual(state.chats?.[0]?.background, background);
    assert.equal(backgroundTerminals(new Set([surface])).get(surface), expected === "idle" ? false : expected === "shell" || expected === "background" ? true : undefined);
  }
  const pass = (name: string) => { results.push(name); console.log("PASS", name); };
  timeout = true;
  backgroundTerminals(new Set([surface]));
  const firstTry = attempts;
  timeout = false;
  assert.equal((await followSurface(surface)).session, sessionId);
  assert.ok(attempts > firstTry);
  await Bun.sleep(5050);
  timeout = true;
  assert.equal((await followSurface(surface)).session, sessionId);
  const timedOut = attempts;
  timeout = false;
  assert.equal((await followSurface(surface)).session, sessionId);
  assert.ok(attempts > timedOut);
  pass("retry an empty process start immediately and keep the last good session during a timeout");
  launch(agent, {}, "Bash"); launch(mcp, {}, "Bash");
  launch(mcp, {}, "Agent"); launch(agent, {}, "mcp__brain__exec");
  await expectState("idle");
  pass("quotes and results from the wrong tool cannot open background tasks");
  launch(agent, { timestamp: "2000-01-01T00:00:00Z" });
  launch(agent, { isSidechain: true });
  launch("Monitor started (task watcher, command...)");
  launch("Command running in background with ID: cmd1.");
  await expectState("idle");
  pass("ignore old launches, sidechains, monitors and shell commands");
  launch([{ type: "text", text: agent }], {}, "Task");
  await expectState("background", { agents: 1, mcp: 0 });
  append({ type: "user", message: { content: notice("abc123", "running") } });
  launch(mcp);
  await expectState("background", { agents: 1, mcp: 1 });
  for (const value of ["busy", "waiting", "asked", "shell"]) {
    status(value);
    await expectState(value);
  }
  status("idle");
  append({ type: "user", message: { content: [{ type: "text", text: notice("abc123", "completed") }] } });
  await expectState("background", { agents: 0, mcp: 1 });
  for (const end of ["killed", "stopped", "failed"]) {
    launch(mcp);
    await expectState("background", { agents: 0, mcp: 1 });
    append({ type: "queue-operation", content: notice("ktyap7ywa", end) });
    await expectState("idle");
  }
  pass("track agent and MCP counts in page and strip through status changes and notifications");
  launch(agent);
  const stop = JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", name: "TaskStop", input: { task_id: "abc123" } }] } });
  fs.appendFileSync(transcript, stop.slice(0, -3));
  await expectState("background", { agents: 1, mcp: 0 });
  fs.appendFileSync(transcript, stop.slice(-3) + "\n");
  await expectState("idle");
  pass("apply TaskStop once the appended row is complete");
  const before = fs.statSync(transcript).size, first = reads.length;
  const filler = JSON.stringify({ type: "progress", data: "x".repeat(8192) }) + "\n";
  fs.appendFileSync(transcript, filler.repeat(640));
  launch(agent);
  const size = fs.statSync(transcript).size;
  assert.equal((await followSurface(surface)).status, "idle"); // while it catches up, Claude own status
  assert.ok(reads.at(-1)!.offset + reads.at(-1)!.bytes < size);
  for (let i = 0; i < 100 && reads.at(-1)!.offset + reads.at(-1)!.bytes < size; i++) await followSurface(surface);
  await expectState("background", { agents: 1, mcp: 0 });
  let offset = before;
  for (const r of reads.slice(first)) { assert.equal(r.offset, offset); offset += r.bytes; }
  assert.equal(offset, size);
  const count = reads.length;
  await expectState("background", { agents: 1, mcp: 0 });
  assert.equal(reads.length, count);
  fs.appendFileSync(transcript, filler.repeat(1200));
  const pending = await followSurface(surface);
  assert.equal(pending.pending, true);
  assert.equal(pending.status, "background");
  assert.equal(pending.chats?.[0]?.status, "background");
  assert.deepEqual(pending.chats?.[0]?.background, { agents: 1, mcp: 0 });
  assert.equal(backgroundTerminals(new Set([surface])).get(surface), undefined);
  pass("an unfinished scan preserves page and strip counts and leaves the marker undecided");
  append({ type: "user", message: { content: notice("abc123", "completed") } });
  await expectState("idle");
  pass("read large transcripts in bounded polls without rereading old bytes");
  fs.renameSync(transcript, transcript + ".old");
  launch(agent);
  fs.appendFileSync(transcript, filler.repeat(1280));
  inode = fs.statSync(transcript).ino;
  let recovered = false;
  const cold = reads.length;
  for (let i = 0; i < 10; i++) {
    const before = reads.length, state = await followSurface(surface);
    assert.ok(reads.slice(before).reduce((n, r) => n + r.bytes, 0) <= 4 << 20);
    if (state.status === "background") {
      assert.deepEqual(state.background, { agents: 1, mcp: 0 });
      recovered = true;
      break;
    }
    assert.equal(state.status, "idle");
  }
  assert.ok(recovered && reads[cold].offset > reads[cold + 1].offset);
  const done = reads.length;
  await expectState("background", { agents: 1, mcp: 0 });
  assert.equal(reads.length, done);
  pass("cold scan recovers an open task before the last 8 MiB");
} finally {
  child.kill();
  await child.exited;
  fs.writeFileSync(join(dir, "result.json"), JSON.stringify({ results, reads }, null, 2));
  console.log(results.length + " checks passed. Artifact " + join(dir, "result.json"));
}
