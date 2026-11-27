// Start or stop the cmux chat server.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, Refusal, STATE_DIR, ensureStateDir, pidStart, ps, refuse, run, writePrivate } from "./common";

const HERE = import.meta.dir;
const GUARD = join(HERE, "guard.ts");
const SERVER_DIR = join(DATA_DIR, "cmux-src/agent-chat");
const SERVER_BUN = join(DATA_DIR, "bun-1.3.14/package/bin/bun");
const TOKEN_FILE = join(STATE_DIR, "token");
const SERVER_FILE = join(STATE_DIR, "server.json"); // written by the server
const LAUNCH_FILE = join(STATE_DIR, "launch.json"); // written by us
const LOG_FILE = join(STATE_DIR, "server.log");
const PORT = Number(process.env.ORCA_CHAT_PORT || json(SERVER_FILE)?.port || 47739);
const CODE = new Bun.CryptoHasher("sha256").update(["chat.ts", "common.ts", "follow.ts", "guard.ts", "live.ts", "queue.ts", "page/ui.js", "page/ui.css", "page/look.js", "page/look.css"].map((file) => readFileSync(join(HERE, file), "utf8")).join("\0")).digest("hex");

function json(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// The recorded server pid, only when it is still that exact process.
function serverPid(): number | null {
  const launch = json(LAUNCH_FILE);
  if (!Number.isInteger(launch?.pid) || !launch.pidStart) return null;
  if (pidStart(launch.pid) !== launch.pidStart) return null;
  const command = ps(launch.pid, "command");
  return command.includes(GUARD) && command.includes("server.ts") ? launch.pid : null;
}

async function healthy(token: string): Promise<number | null> {
  const pid = serverPid();
  const state = json(SERVER_FILE);
  if (!pid || state?.pid !== pid || state.launchId !== json(LAUNCH_FILE)?.launchId) return null;
  const res = await fetch(`http://127.0.0.1:${state.port}/${token}/api/sessions`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
  return res?.ok && Array.isArray(await res.json().catch(() => null)) ? state.port : null;
}

function readToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const token = readFileSync(TOKEN_FILE, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(token)) refuse(`the token file is not valid: ${TOKEN_FILE}`);
    return token;
  }
  const token = randomBytes(32).toString("hex");
  writePrivate(TOKEN_FILE, token + "\n");
  return token;
}

async function ensureServer(): Promise<string> {
  const token = readToken();
  const url = (port: number) => `http://127.0.0.1:${port}/${token}`;
  if (serverPid() && json(LAUNCH_FILE).code !== CODE) await stopServer();
  const running = await healthy(token);
  if (running) return url(running);
  if (serverPid()) refuse("the server runs but does not answer, run bun lib/chat.ts stop");
  if (!existsSync(join(SERVER_DIR, "node_modules/react")) || !existsSync(SERVER_BUN)) refuse("the sidecar is not installed, run bin/install");
  if (await portInUse()) refuse(`port ${PORT} is in use by another program, set ORCA_CHAT_PORT`);
  const launchId = randomUUID();
  const env: Record<string, string> = {
    PATH: `${process.execPath.replace(/\/[^/]+$/, "")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CMUX_AGENT_CHAT_PORT: String(PORT),
    CMUX_AGENT_CHAT_TOKEN: token,
    CMUX_AGENT_CHAT_STATE_FILE: SERVER_FILE,
    CMUX_AGENT_CHAT_LAUNCH_ID: launchId,
    CMUX_AGENT_HOOK_STATE_DIR: STATE_DIR,
    CMUX_BUNDLED_CLI_PATH: "/usr/bin/false", // read-only: every call fails
    CMUX_AGENT_MODELS_URL: "http://127.0.0.1:9/off",
    DO_NOT_TRACK: "1",
    ORCA_CHAT_STATE_DIR: STATE_DIR,
  };
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "TZ", "SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const log = openSync(LOG_FILE, "w", 0o600);
  const child = spawn(SERVER_BUN, ["--preload", GUARD, "server.ts"], { cwd: SERVER_DIR, env, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  child.on("error", () => {});
  child.unref();
  if (!child.pid) refuse("the server did not start");
  writePrivate(LAUNCH_FILE, JSON.stringify({ pid: child.pid, pidStart: pidStart(child.pid), launchId, code: CODE }) + "\n");
  for (let i = 0; i < 60; i++) {
    const port = await healthy(token);
    if (port) return url(port);
    if (!serverPid()) break;
    await Bun.sleep(200);
  }
  refuse(`the server did not start, see ${LOG_FILE}`);
}

async function portInUse(): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port: PORT, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function stopServer(): Promise<number | null> {
  const pid = serverPid();
  if (!pid) return null;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 25 && serverPid() === pid; i++) await Bun.sleep(200);
  if (serverPid() === pid) throw new Refusal(`server ${pid} did not stop`);
  return pid;
}

run(async () => {
  process.umask(0o077);
  ensureStateDir();
  const [phase] = process.argv.slice(2);
  if (phase === "stop") {
    const pid = await stopServer();
    return console.log(pid ? `stopped server ${pid}` : "no server of orca-chat runs");
  }
  if (phase === "cmux") return console.log(await ensureServer());
  refuse("use the cmux or stop phase");
});
