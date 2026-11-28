// Run with bun e2e/commands.e2e.ts after bin/install.
import assert from "node:assert/strict";
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cmux-commands-"));
const data = process.env.ORCA_CHAT_DATA_DIR ?? join(homedir(), ".local/share/orca-chat");
const clone = join(data, "cmux-src/agent-chat"), bun = join(data, "bun-1.3.14/package/bin/bun");
const guard = join(import.meta.dir, "../lib/guard.ts");
const token = crypto.randomUUID();
const results: { name: string; evidence: unknown }[] = [];
const user = (content: string) => ({ type: "user", message: { content } });
const local = (content: string) => ({ type: "system", subtype: "local_command", content });
const command = (name: string, args = "") => `<command-name>/${name}</command-name>\n <command-message>${name}</command-message>\n <command-args>${args}</command-args>`;
const stdout = (text: string) => `<local-command-stdout>${text}</local-command-stdout>`;
const duration = { type: "system", subtype: "turn_duration", durationMs: 1200 };
const cases = [
  { name: "old clear", rows: [user("<local-command-caveat>hidden</local-command-caveat>"), user(command("clear")), local(stdout(""))],
    expected: ["/clear", "done"] },
  { name: "system effort", rows: [local(command("effort")), local(stdout("Set effort level to medium")), duration],
    expected: ["/effort", "done", "Set effort level to medium", "done"] },
  { name: "silent clear", rows: [user(command("clear"))], expected: ["/clear", "done"] },
  { name: "prompt command", rows: [user("<command-message>gcontext</command-message>\n<command-name>/gcontext</command-name>"),
    { type: "user", isMeta: true, message: { content: [{ type: "text", text: "Hidden skill instructions" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "The project history" }] } }, duration],
    expected: ["/gcontext", "The project history", "1.2s"] },
  { name: "user stdout and arguments", rows: [user(command("model", "sonnet")), user(stdout("Switched model"))],
    expected: ["/model sonnet", "done", "Switched model", "done"] },
];
const sessions: Record<string, object> = {};
const ids = cases.map(({ rows }) => {
  const id = crypto.randomUUID(), transcriptPath = join(dir, id + ".jsonl");
  writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  sessions[id] = { transcriptPath, cwd: dir };
  return "t-" + id;
});
writeFileSync(join(dir, "claude-hook-sessions.json"), JSON.stringify({ sessions }));

async function server(cwd: string, label: string, check: (url: string, log: string) => Promise<void>) {
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const port = (socket.address() as { port: number }).port;
      socket.close(() => resolve(port));
    });
  });
  const log = join(dir, label + ".log"), fd = openSync(log, "w");
  const proc = Bun.spawn([bun, "--preload", guard, "server.ts"], { cwd, stdout: fd, stderr: fd, env: {
    PATH: "/usr/bin:/bin", HOME: dir, CMUX_AGENT_CHAT_TOKEN: token, CMUX_AGENT_CHAT_PORT: String(port),
    CMUX_AGENT_CHAT_STATE_FILE: join(dir, label + ".json"), CMUX_AGENT_HOOK_STATE_DIR: dir,
    CMUX_BUNDLED_CLI_PATH: "/usr/bin/false", ORCA_CHAT_STATE_DIR: dir, CMUX_AGENT_MODELS_URL: "http://127.0.0.1:9/off",
  } });
  closeSync(fd);
  const url = `http://127.0.0.1:${port}/${token}`;
  try {
    for (let i = 0; i < 100; i++) {
      if ((await fetch(url + "/api/sessions").catch(() => null))?.ok) return await check(url, log);
      if (proc.exitCode !== null) break;
      await Bun.sleep(50);
    }
    throw new Error("Server did not start. See " + log);
  } finally { proc.kill(); await proc.exited; }
}

function history(url: string, sessionId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws");
    const timer = setTimeout(() => { ws.close(); reject(new Error("No history for " + sessionId)); }, 5000);
    const subscribe = () => ws.send(JSON.stringify({ op: "subscribe", sessionId }));
    ws.onopen = subscribe;
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(String(data));
      // The first subscription starts the tail. Read history again after it delivers events.
      if (msg.kind === "event") subscribe();
      if (msg.kind !== "history" || !msg.events.length) return;
      clearTimeout(timer);
      resolve(msg);
      ws.close();
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket failed")); };
  });
}

try {
  await server(clone, "installed", async url => {
    for (const [i, fixture] of cases.entries()) {
      const { events, session } = await history(url, ids[i]);
      results.push({ name: fixture.name, evidence: { events, status: session.status } });
      const kinds = ["user", ...(i === 3 ? ["assistant", "done"] : fixture.expected.length === 4 ? ["done", "status", "done"] : ["done"])];
      assert.deepEqual(events.map((e: any) => e.kind), kinds, fixture.name);
      assert.deepEqual(events.map((e: any) => e.text ?? e.stats ?? e.kind), fixture.expected, fixture.name);
      assert.equal(session.status, "idle");
      console.log("PASS", fixture.name);
    }
  });
  const copy = join(dir, "agent-chat");
  cpSync(clone, copy, { recursive: true, filter: p => p !== join(clone, "node_modules") });
  symlinkSync(join(clone, "node_modules"), join(copy, "node_modules"));
  symlinkSync(join(clone, "../web"), join(dir, "web")); // the app reads ../web/messages
  const parser = join(copy, "adapters/transcript.ts");
  const source = readFileSync(parser, "utf8");
  const changed = source.replace('case "turn_duration": {', 'case "turn_duration" : {');
  assert.notEqual(changed, source);
  writeFileSync(parser, changed);
  await server(copy, "changed", async (_url, log) => {
    const lines = readFileSync(log, "utf8").split("\n").filter(line => line.includes("transcript patch skipped"));
    results.push({ name: "missing anchor", evidence: lines });
    assert.deepEqual(lines, ["[orca-chat guard] transcript patch skipped: system command"]);
    console.log("PASS missing anchor");
  });
} finally {
  const artifact = join(dir, "result.json");
  writeFileSync(artifact, JSON.stringify(results, null, 2));
  console.log(artifact);
}
