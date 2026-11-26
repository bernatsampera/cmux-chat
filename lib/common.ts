import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
export const RENAME_FILE = join(STATE_DIR, "rename.json");
export const validTitle = (title: unknown): title is string => typeof title === "string" && title.length <= 80 && Boolean(title.trim());
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
export const processSurface = (pid: number) => only(ps(pid, "command", "-Eww"), /(?:^|\s)CMUX_SURFACE_ID=(\S+)/g);

// The signature of the one-time link of lib/cmux.ts. cmux keeps the URL of each
// browser.navigate call in a log file, so the token must not be in that URL.
export const signLink = (token: string, surface: string, until: string) => createHmac("sha256", token).update(`${surface} ${until}`).digest("hex");

// ~/.claude/sessions/<pid>.json: Claude Code's own record of a live process. It
// is undocumented. When it is missing or different, the bridge refuses.
// A rewrite on a full disk can leave the old file's tail after the new record
// (for example "}}"), so the longest start that ends in "}" is tried too.
export function claudeLive(pid: number): { sessionId?: string; kind?: string; status?: string } | null {
  let text: string;
  try {
    text = readFileSync(join(CLAUDE_DIR, "sessions", `${pid}.json`), "utf8");
  } catch {
    return null;
  }
  for (let end = text.length, tries = 0; end > 0 && tries < 8; end = text.lastIndexOf("}", end - 2) + 1, tries++) {
    try {
      const value = JSON.parse(text.slice(0, end));
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {}
  }
  return null;
}
