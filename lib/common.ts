// Shared by lib/chat.ts, lib/place.ts, and lib/follow.ts.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Agent = "claude" | "codex";
export const AGENTS: Agent[] = ["claude", "codex"];
export const SESSION_ID = /^[\w-]{8,128}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STATE_DIR = process.env.ORCA_CHAT_STATE_DIR || join(homedir(), ".local/state/orca-chat");
export const DATA_DIR = process.env.ORCA_CHAT_DATA_DIR || join(homedir(), ".local/share/orca-chat");
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CODEX_DIR = process.env.CODEX_HOME || join(homedir(), ".codex");

// lib/tabs.ts writes the chats of each project here, lib/follow.ts what was picked in the strip.
export const CHATS_FILE = join(STATE_DIR, "chats.json");
export const PICK_FILE = join(STATE_DIR, "pick.json");
export interface Chat { workspace: string; terminal: string; title: string; agent?: Agent; unread: boolean }
export interface Project { id: string; folder: string; chats: Chat[] }

export class Refusal extends Error {}
export function refuse(message: string): never {
  throw new Refusal(message);
}

// Never throws a raw stack at the user, and never prints argv (it holds the text).
export function run(main: () => void | Promise<void>) {
  Promise.resolve()
    .then(main)
    .catch((err) => {
      console.error(err instanceof Refusal ? `orca-chat: ${err.message}` : `orca-chat: internal error: ${err?.message ?? err}`);
      process.exit(1);
    });
}

export interface Entry {
  sessionId: string;
  surfaceId: string;
  tabId: string;
  cwd: string;
  transcriptPath: string;
  updatedAt: number;
  agentPid: number;
  agentPidStart: string;
}
export interface Store {
  version: 1;
  sessions: Record<string, Entry>;
  activeSessionsBySurface: Record<string, { sessionId: string; updatedAt: number }>;
}

export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
}

export function writePrivate(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

const storePath = (agent: Agent) => join(STATE_DIR, `${agent}-hook-sessions.json`);

export function readStore(agent: Agent): Store {
  const path = storePath(agent);
  if (!existsSync(path)) return { version: 1, sessions: {}, activeSessionsBySurface: {} };
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    refuse(`the session store is not valid JSON: ${path}`);
  }
  return { version: 1, sessions: raw?.sessions ?? {}, activeSessionsBySurface: raw?.activeSessionsBySurface ?? {} };
}

export function writeStore(agent: Agent, store: Store) {
  writePrivate(storePath(agent), JSON.stringify(store, null, 1) + "\n");
}

// The absolute Orca CLI. ORCA_CHAT_ORCA is the path that orca-chat resolved when
// it started the server, so a later PATH change cannot swap the CLI.
export function orcaBin(): string {
  const fixed = process.env.ORCA_CHAT_ORCA;
  if (fixed) return existsSync(fixed) ? fixed : refuse(`the Orca CLI is missing: ${fixed}`);
  const dir = process.env.ORCA_CLI_BIN_DIR;
  if (dir && existsSync(join(dir, "orca"))) return join(dir, "orca");
  return Bun.which("orca", { PATH: process.env.PATH }) ?? refuse("the Orca CLI is not on PATH");
}

// Orca's own runtime client, next to its CLI. null when this Orca has none.
export function runtimeClient(): any {
  const lib = join(dirname(realpathSync(orcaBin())), "../app.asar.unpacked/out/cli/runtime-client.js");
  return existsSync(lib) ? new (require(lib).RuntimeClient)() : null;
}

export interface Terminal {
  handle: string;
  tabId: string;
  leafId: string;
  agentIdentity?: string | null;
  connected?: boolean;
  writable?: boolean;
  orphaned?: boolean;
  worktreeId?: string;
  worktreePath?: string;
}

// Async with a hard kill: spawnSync in Bun 1.1 ignores its timeout. code is null
// when Orca did not answer in time.
export async function orca(args: string[], timeout = 5_000): Promise<{ code: number | null; stdout: string }> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CMUX_")) delete env[key];
  const proc = Bun.spawn([orcaBin(), ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    proc.kill(9);
  }, timeout);
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return { code: late ? null : code, stdout };
}

export async function listTerminals(): Promise<Terminal[]> {
  const res = await orca(["terminal", "list", "--limit", "1000", "--json"], 4_000);
  if (res.code !== 0) refuse("orca terminal list failed, nothing was sent");
  let body: any;
  try {
    body = JSON.parse(res.stdout);
  } catch {
    refuse("orca terminal list did not return JSON, nothing was sent");
  }
  if (body?.ok !== true || !Array.isArray(body?.result?.terminals)) refuse("orca terminal list returned an error, nothing was sent");
  if (body.result.truncated !== false) refuse("orca terminal list is truncated, so the match is not certain, nothing was sent");
  return body.result.terminals;
}

export async function matchLeaf(leafId: string): Promise<Terminal> {
  const hits = (await listTerminals()).filter((t) => typeof t.leafId === "string" && t.leafId.toLowerCase() === leafId.toLowerCase());
  if (hits.length === 0) refuse(`no Orca terminal has the leaf ${leafId}`);
  if (hits.length > 1) refuse(`${hits.length} Orca terminals have the leaf ${leafId}`);
  const [hit] = hits;
  if (typeof hit.handle !== "string" || !/^[\w-]+$/.test(hit.handle)) refuse("the Orca terminal has no usable handle");
  if (hit.connected !== true) refuse("the Orca terminal is not connected");
  return hit;
}

export const sh = (cmd: string, ...args: string[]) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 << 20 }).stdout ?? "";

export function ps(pid: number, field: string, flag = "-ww"): string {
  const res = spawnSync("/bin/ps", [flag, "-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC0", PATH: "/bin:/usr/bin" } });
  if (res.status === null) refuse("ps is not usable here, so the agent process cannot be checked");
  return res.status === 0 ? res.stdout.trim() : "";
}
export const pidStart = (pid: number) => ps(pid, "lstart");

// The one UUID that a pattern finds in an environment text. Two different values: none.
function only(text: string, pattern: RegExp): string | undefined {
  const all = new Set([...text.matchAll(pattern)].map((m) => m[1].toLowerCase()));
  const [leaf] = all;
  return all.size === 1 && UUID.test(leaf) ? leaf : undefined;
}
export const paneLeaf = (text: string) => only(text, /(?:^|\s)ORCA_PANE_KEY=[^\s:]+:([^\s:]+)(?=\s|$)/g);
export const processLeaf = (pid: number) => paneLeaf(ps(pid, "command", "-Eww"));
export const processSurface = (pid: number) => only(ps(pid, "command", "-Eww"), /(?:^|\s)CMUX_SURFACE_ID=(\S+)/g);

// The signature of the one-time link of lib/cmux.ts. cmux keeps the URL of each
// browser.navigate call in a log file, so the token must not be in that URL.
export const signLink = (token: string, surface: string, until: string) => createHmac("sha256", token).update(`${surface} ${until}`).digest("hex");

// ~/.claude/sessions/<pid>.json: Claude Code's own record of a live process. It
// is undocumented. When it is missing or different, the bridge refuses.
export function claudeLive(pid: number): { sessionId?: string; kind?: string; status?: string } | null {
  try {
    return JSON.parse(readFileSync(join(CLAUDE_DIR, "sessions", `${pid}.json`), "utf8"));
  } catch {
    return null;
  }
}
