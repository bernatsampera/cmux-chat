// Show the live session and project tabs for one cmux surface.
import { closeSync, fstatSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS, CHATS_FILE, CLOSE_FILE, MENUS_FILE, CLAUDE_DIR, CODEX_DIR, PICK_FILE, RENAME_FILE, validTitle, Refusal, SESSION_ID, UUID, claudeLive, pidStart, processSurface, ps, readStore, sh, writePrivate, writeStore, type Agent, type Project } from "./common";

interface Claim { leaf: string; agent: Agent; sessionId: string; pid: number; start: string; cwd: string; path?: string; status?: string; since?: number }

// An environment never changes, so it is read once per process. A look that found
// nothing can be a failed one (a busy machine), so it is done again after 10 s.
const leaves = new Map<string, { leaf?: string; at: number }>();
function leafOf(pid: number, start: string) {
  const key = `${pid} ${start}`;
  let known = leaves.get(key);
  if (!known || (!known.leaf && Date.now() - known.at > 10_000)) leaves.set(key, (known = { leaf: processSurface(pid), at: Date.now() }));
  return known.leaf ?? "";
}

const ROLLOUT = /\/rollout-[^/]*-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/;
let codexPids: number[] = [], codexAt = 0;

// A subagent of Codex has its own rollout file, and the process of its parent has it open.
const kinds = new Map<string, boolean>();
function isSubagent(path: string): boolean {
  if (!kinds.has(path)) {
    const fd = openSync(path, "r"), buffer = Buffer.alloc(256 << 10);
    const text = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
    closeSync(fd);
    let meta: any;
    try { meta = JSON.parse(text.split("\n")[0]); } catch {}
    if (!meta) return false; // not complete yet: read it again
    kinds.set(path, Boolean(meta.payload?.source?.subagent));
  }
  return kinds.get(path)!;
}
// After /new and /resume Codex keeps the old file open: the last written one is in use.
function currentRollout(files: string[]): string | undefined {
  const at = (f: string) => { try { return isSubagent(f) ? -1 : statSync(f).mtimeMs; } catch { return -1; } };
  return files.map((f) => ({ f, t: at(f) })).filter((x) => x.t >= 0).sort((a, b) => b.t - a.t)[0]?.f;
}

// Codex has no status file, but its rollout has the start and the end of each turn. Only
// the new part is read. A turn that is older than the process ended with the one before it.
const TURNS = ["task_started", "task_complete", "turn_aborted"].map((t) => `"type":"event_msg","payload":{"type":"${t}"`);
const turns = new Map<string, { at: number; status?: string; since?: number }>();
function codexTurn(path: string, pid: number, start: string): { status?: string; since?: number } {
  const size = statSync(path).size;
  let t = turns.get(path);
  if (!t || size < t.at) turns.set(path, (t = { at: Math.max(0, size - (32 << 20)) }));
  const fd = openSync(path, "r"), buffer = Buffer.alloc(size - t.at);
  const read = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, t.at)), text = read.subarray(0, read.lastIndexOf(10) + 1); // whole lines
  closeSync(fd);
  t.at += text.length;
  const hits = TURNS.map((x) => text.lastIndexOf(x)), last = Math.max(...hits);
  if (last >= 0) {
    t.status = hits[0] === last ? "busy" : "idle";
    t.since = Date.parse(/"timestamp":"([^"]+)"/.exec(text.toString("utf8", text.lastIndexOf(10, last) + 1, last))?.[1] ?? "");
  }
  const { status, since } = t;
  if (status !== "busy") return { status, since };
  if (!(since! > Date.parse(`${start} UTC`))) return {};
  return { status: asked(path.match(ROLLOUT)![1], pid, since!) ? "asked" : status, since };
}
// The hooks of cmux see that Codex asks for something, but not always that it got the
// answer. So "asked" counts only as long as the user has not looked (the page knows).
function asked(sessionId: string, pid: number, since: number): boolean {
  try {
    const x = JSON.parse(readFileSync(join(homedir(), ".cmuxterm/codex-hook-sessions.json"), "utf8")).sessions[sessionId];
    return x.pid === pid && x.updatedAt * 1000 > since && [x.runtimeStatus, x.agentLifecycle].includes("needsInput");
  } catch {
    return false;
  }
}

// Polls share the start time from ps for five seconds. A dead process loses
// its entry immediately. Each session record still has to match the start time.
const starts = new Map<number, { start: string; until: number }>();
function cachedStart(pid: number): string {
  try { process.kill(pid, 0); }
  catch { starts.delete(pid); return ""; }
  const now = Date.now(), cached = starts.get(pid);
  if (cached && now < cached.until) return cached.start;
  const start = pidStart(pid);
  if (!start) return cached?.start ?? "";
  if (starts.size >= 256) starts.delete(starts.keys().next().value!);
  starts.set(pid, { start, until: now + 5000 });
  return start;
}

// The live interactive agents in these panes. The session id is read each time.
function claudeClaims(wanted: Set<string>): Claim[] {
  const out: Claim[] = [];
  const dir = join(CLAUDE_DIR, "sessions");
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const pid = Number(/^(\d+)\.json$/.exec(name)?.[1]);
    const live: any = pid && claudeLive(pid);
    if (live?.kind !== "interactive" || typeof live.sessionId !== "string" || !SESSION_ID.test(live.sessionId) || typeof live.procStart !== "string") continue;
    const leaf = leafOf(pid, live.procStart);
    // procStart also shows a dead process, or a reused pid.
    const start = wanted.has(leaf) ? cachedStart(pid) : "";
    if (!start || start.replace(/\s+/g, " ") !== live.procStart.replace(/\s+/g, " ")) continue;
    out.push({ leaf, agent: "claude", sessionId: live.sessionId, pid, start, cwd: live.cwd ?? "/", status: live.status, since: live.statusUpdatedAt });
  }
  return out;
}

function codexClaims(wanted: Set<string>): Claim[] {
  const out: Claim[] = [];
  if (Date.now() - codexAt > 1_500) {
    codexPids = sh("/usr/bin/pgrep", "-ax", "codex").split("\n").map(Number).filter(Boolean);
    codexAt = Date.now();
  }
  for (const pid of codexPids) {
    const start = cachedStart(pid);
    const leaf = start && leafOf(pid, start);
    if (!leaf || !wanted.has(leaf) || ps(pid, "tty") === "??") continue;
    const open = sh("/usr/sbin/lsof", "-nP", "-p", String(pid), "-Ffn");
    const files = [...new Set([...open.matchAll(/^n(.*)$/gm)].map((m) => m[1]).filter((f) => f.startsWith(join(CODEX_DIR, "sessions") + "/") && ROLLOUT.test(f)))];
    const path = currentRollout(files);
    let turn = {};
    try { if (path) turn = codexTurn(path, pid, start); } catch {}
    out.push({ ...turn, leaf, agent: "codex", sessionId: path?.match(ROLLOUT)![1] ?? "", pid, start, cwd: open.match(/^fcwd\nn(.*)$/m)?.[1] ?? "/", path });
  }
  return out;
}

function claims(wanted: Set<string>): Claim[] {
  return [...claudeClaims(wanted), ...codexClaims(wanted)];
}

const claudePaths = new Map<string, string>();
function claudePath(sessionId: string): string | undefined {
  const known = claudePaths.get(sessionId);
  if (known && existsSync(known)) return known;
  const root = join(CLAUDE_DIR, "projects");
  const hits = existsSync(root) ? [...new Bun.Glob(`*/${sessionId}.jsonl`).scanSync({ cwd: root, absolute: true })] : [];
  if (hits.length > 1) throw new Refusal("More than one transcript has this session id.");
  if (hits.length) claudePaths.set(sessionId, hits[0]);
  return hits[0];
}

// The server finds a transcript only through these stores.
function bind(c: Claim, tabId: string, transcriptPath: string) {
  const mine = readStore(c.agent);
  const others = AGENTS.filter((a) => a !== c.agent).map((a) => [a, readStore(a)] as const);
  const same = mine.sessions[c.sessionId];
  if (same?.transcriptPath === transcriptPath && same.surfaceId === c.leaf && same.agentPid === c.pid && same.agentPidStart === c.start && mine.activeSessionsBySurface[c.leaf]?.sessionId === c.sessionId && !others.some(([, s]) => s.activeSessionsBySurface[c.leaf])) return;
  const updatedAt = Date.now() / 1000;
  for (const [leaf, active] of Object.entries(mine.activeSessionsBySurface)) if (active.sessionId === c.sessionId) delete mine.activeSessionsBySurface[leaf];
  mine.sessions[c.sessionId] = { sessionId: c.sessionId, surfaceId: c.leaf, tabId, cwd: c.cwd, transcriptPath, updatedAt, agentPid: c.pid, agentPidStart: c.start };
  mine.activeSessionsBySurface[c.leaf] = { sessionId: c.sessionId, updatedAt };
  writeStore(c.agent, mine);
  for (const [agent, store] of others) {
    if (!store.activeSessionsBySurface[c.leaf]) continue;
    delete store.activeSessionsBySurface[c.leaf];
    writeStore(agent, store);
  }
}

type Activity = { pending?: true; status?: string; background?: { agents: number; mcp: number } };
interface State extends Activity { menu?: true; session: string | null; title: string; message: string | null; since?: number; chats?: Activity[]; plus?: boolean }
const none = (message: string | null, title = ""): State => ({ session: null, title, message });

let menuCache: { modified: number; pid: number; terminals: Set<string> } | undefined;
function hasMenu(surface: string) {
  try {
    const modified = statSync(MENUS_FILE).mtimeMs;
    if (menuCache?.modified !== modified) {
      const { pid, terminals } = JSON.parse(readFileSync(MENUS_FILE, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Array.isArray(terminals)) return false;
      menuCache = { modified, pid, terminals: new Set(terminals) };
    }
    if (!menuCache.terminals.has(surface)) return false;
    process.kill(menuCache.pid, 0);
    return true;
  } catch { return false; }
}

const lastLog = new Map<string, string>();
export async function followSurface(surface: string): Promise<State> {
  const budget = { bytes: 4 << 20 };
  const state = settle(claims(new Set([surface])), surface, "", budget), line = state.session ?? state.message ?? "";
  if (lastLog.get(surface) !== line) {
    lastLog.set(surface, line);
    console.log(`[orca-chat] ${new Date().toISOString()} terminal ${surface.slice(0, 8)}: ${state.session ? "session " + line.slice(0, 8) : line + why(surface)}`);
  }
  if (hasMenu(surface)) state.menu = true;
  return { ...state, ...strip(surface, state, budget) };
}

// The project of this terminal. Not known when the helper that writes it (lib/tabs.ts) is gone.
function project(surface: string): Project | undefined {
  try {
    const { pid, projects } = JSON.parse(readFileSync(CHATS_FILE, "utf8"));
    process.kill(pid, 0);
    return projects.find((p: Project) => p.chats.some((c) => c.terminal === surface));
  } catch {}
}

// The tabs of the page: the chats of the project, with what their agents do.
const agents = new Map<string, { at: number; found: Claim[] }>(), FRESH_DONE = 70_000;
function strip(surface: string, state: State, budget: { bytes: number }) {
  const p = project(surface);
  if (!p) return { chats: [] };
  let now = agents.get(p.id);
  if (!now || Date.now() - now.at > 1_500) agents.set(p.id, (now = { at: Date.now(), found: claims(new Set(p.chats.map((c) => c.terminal))) }));
  const chats = p.chats.map((c) => {
    const live = active(now!.found.filter((x) => x.leaf === c.terminal));
    const activity = c.terminal === surface && live?.agent === "claude" && state.session === live.sessionId ? { status: state.status, background: state.background }
      : live && activityOf(live, budget);
    // Claude Code tells cmux "waiting for your input" only after 60 s, so a turn that just
    // ended counts as unread until that notice takes over.
    const fresh = activity?.status === "idle" && Number(live?.since) > Date.now() - FRESH_DONE;
    return { id: c.terminal, workspace: c.workspace, title: c.title, agent: live?.agent ?? c.agent, ...activity, since: live?.since, unread: c.unread || fresh };
  });
  return { chats, plus: Boolean(p.folder) };
}

// The helper does the rest: the server cannot reach cmux.
export function pickChat(from: string, to: string): boolean {
  if (from !== to) {
    const p = project(from);
    if (!p || !(to === "new" ? p.folder : p.chats.some((c) => c.terminal === to))) return false;
  } else if (!UUID.test(from)) return false;
  writePrivate(PICK_FILE, JSON.stringify({ from, to, at: Date.now() }));
  return true;
}
export function closeChat(from: string, to: string): boolean {
  const chat = project(from)?.chats.find(c => c.terminal === to);
  if (!chat) return false;
  writePrivate(CLOSE_FILE, JSON.stringify({ workspace: chat.workspace, terminal: to, at: Date.now() }));
  return true;
}
export function renameChat(from: string, workspace: string, title: string | null): boolean {
  if (!validTitle(title) || !project(from)?.chats.some(c => c.workspace === workspace)) return false;
  writePrivate(RENAME_FILE, JSON.stringify({ workspace, title, at: Date.now() }));
  return true;
}
// For the log: the Claude processes of this terminal, read again without the cache.
function why(surface: string): string {
  try {
    const pids = sh("/usr/bin/pgrep", "-x", "claude|claude.exe").split("\n").map(Number).filter(Boolean).filter((pid) => processSurface(pid) === surface);
    return ` (claude here: ${pids.map((pid) => { const l: any = claudeLive(pid); return `${pid} ${l ? `${l.kind} ${l.status} ${l.procStart === pidStart(pid) ? "same start" : `start ${l.procStart} / ${pidStart(pid)}`}` : "no session file"}`; }).join(", ") || "none"})`;
  } catch (err: any) {
    return ` (${err?.message ?? err})`;
  }
}

// The one session of a terminal.
function active(found: Claim[]) {
  const sessions = () => new Set(found.map((c) => c.agent + c.sessionId)).size;
  // A Codex with no rollout is not a session yet. Next to a real one it is often a test
  // that runs fake agents in this terminal.
  if (sessions() > 1) found = found.filter((c) => c.sessionId);
  if (sessions() > 1) {
    found = found.filter((c) => ps(c.pid, "stat").includes("+"));
    if (sessions() !== 1) return undefined;
  }
  return found[0];
}

export function claudeTerminals(terminals: Set<string>) {
  const claude = claudeClaims(terminals), leaves = new Set(claude.map(c => c.leaf));
  if (leaves.size) {
    const found = [...claude, ...codexClaims(leaves)];
    for (const leaf of leaves) if (active(found.filter(c => c.leaf === leaf))?.agent !== "claude") leaves.delete(leaf);
  }
  return leaves;
}

// An absent decision keeps the marker already in the workspace description.
export function backgroundTerminals(terminals: Set<string>) {
  const found = claims(terminals), budget = { bytes: 4 << 20 };
  const background = new Map<string, boolean>();
  for (const terminal of terminals) {
    const here = found.filter(c => c.leaf === terminal), agent = active(here);
    const activity = agent && activityOf(agent, budget);
    if (!here.length) background.set(terminal, false);
    else if (activity && !activity.pending) {
      if (activity.status === "background" || activity.status === "shell") background.set(terminal, true);
      else if (activity.status === "idle") background.set(terminal, false);
    }
  }
  return background;
}

function settle(found: Claim[], tabId: string, title: string, budget: { bytes: number }): State {
  const c = active(found);
  if (!c && found.length) return none("More than one agent runs in this terminal.", title);
  if (!c) return none("No Claude Code or Codex session in this terminal.", title);
  const path = c.path ?? (c.agent === "claude" ? claudePath(c.sessionId) : undefined);
  if (!path) return none("The session has no transcript yet. Send a message in the terminal.", title);
  bind(c, tabId, path);
  return { session: c.sessionId, title, message: null, ...activityOf(c, budget, path), since: c.since };
}

type TaskKind = "agents" | "mcp";
interface TaskScan {
  process: string; ino: number; size: number; modified: number; offset: number;
  tools: Map<string, TaskKind>; parts: Buffer[]; open: Map<string, TaskKind>; back: number;
}
const taskScans = new Map<string, TaskScan>(), TASK_TAIL = 8 << 20;

function applyTaskRow(line: Buffer, { open, tools }: TaskScan, start: number, sessionId: string) {
  if (!['"tool_use"', '"tool_result"', "<task-notification>"].some(s => line.includes(s))) return;
  let row;
  try { row = JSON.parse(line.toString()); } catch { return; }
  if (!row || (row.sessionId && row.sessionId !== sessionId)) return;
  function notice(text: string) {
    for (const [block] of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(block)?.[1];
      const status = /<status>([^<]+)<\/status>/.exec(block)?.[1];
      if (id && status && status !== "running") open.delete(id);
    }
  }
  const content = row.type === "queue-operation" ? row.content : row.message?.content;
  if (typeof content === "string" && (row.type === "queue-operation" || row.type === "user")) return notice(content);
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (row.type === "assistant" && item?.type === "tool_use" && !row.isSidechain) {
      if (item.name === "TaskStop") open.delete(item.input?.task_id);
      if (typeof item.id !== "string") continue;
      if (item.name === "Agent" || item.name === "Task") tools.set(item.id, "agents");
      else if (item.name?.startsWith("mcp__")) tools.set(item.id, "mcp");
    }
    if (row.type !== "user" && row.type !== "queue-operation") continue;
    if (item?.type === "text" && typeof item.text === "string") notice(item.text);
    if (row.type !== "user" || item?.type !== "tool_result" || row.isSidechain || !(Date.parse(row.timestamp) > start)) continue;
    const kind = tools.get(item.tool_use_id);
    tools.delete(item.tool_use_id);
    if (!kind) continue;
    const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
      ? item.content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";
    const agent = text.includes("Async agent launched successfully.") && /^agentId:\s*([a-z0-9]+) \(/m.exec(text);
    if (agent && kind === "agents") open.set(agent[1], "agents");
    const mcp = /^MCP tool "[^"\n]+" is still running[^\n]*?moved to the background as task ([a-z0-9]+)\b/m.exec(text);
    if (mcp && kind === "mcp") open.set(mcp[1], "mcp");
  }
}

const lastActivity = new Map<string, { session: string; activity: Activity }>();
function activityOf(c: Claim, budget: { bytes: number }, path?: string): Activity {
  if (c.agent !== "claude") return { status: c.status };
  const session = [c.pid, c.start, c.sessionId].join("/");
  const previous = lastActivity.get(c.leaf);
  const pending = (): Activity => ({ ...(previous?.session === session ? previous.activity : { status: c.status }), pending: true });
  const remember = (activity: Activity) => {
    if (lastActivity.size >= 256 && !previous) lastActivity.delete(lastActivity.keys().next().value!);
    lastActivity.set(c.leaf, { session, activity });
    return activity;
  };
  if (c.status !== "idle") return remember({ status: c.status });
  let fd: number | undefined;
  try {
    path ??= claudePath(c.sessionId);
    if (!path) return pending();
    fd = openSync(path, "r");
    const { ino, size, mtimeMs } = fstatSync(fd);
    const process = c.pid + "/" + c.start;
    let scan = taskScans.get(path);
    if (!scan || scan.process !== process || scan.ino !== ino || size < scan.size || (size === scan.size && mtimeMs !== scan.modified)) {
      if (taskScans.size >= 128) taskScans.delete(taskScans.keys().next().value!);
      const back = size > TASK_TAIL ? size : 0;
      scan = { process, ino, size, modified: mtimeMs, offset: 0, back, tools: new Map(), parts: [], open: new Map() };
      taskScans.set(path, scan);
    }
    scan.size = size;
    scan.modified = mtimeMs;
    const start = Date.parse(c.start + " UTC");
    // Find where to start replaying rows in order. Skipping a split row here
    // only means replaying a little more history.
    if (scan.back > 0 && budget.bytes > 0) {
      const length = Math.min(scan.back, budget.bytes);
      const pos = scan.back - length, buf = Buffer.allocUnsafe(length);
      if (readSync(fd, buf, 0, length, pos) !== length) return pending();
      budget.bytes -= length;
      scan.back = pos;
      let end = buf.lastIndexOf(10);
      while (end > 0) {
        const prev = buf.lastIndexOf(10, end - 1);
        if (prev < 0 && pos > 0) break;
        const row = buf.subarray(prev + 1, end);
        if (row.includes('"timestamp"')) {
          let time;
          try { time = Date.parse(JSON.parse(row.toString()).timestamp); } catch {}
          if (time !== undefined && time <= start) {
            scan.offset = pos + end + 1;
            scan.back = 0;
            break;
          }
        }
        end = prev;
      }
    }
    if (scan.back) return pending();
    const length = Math.min(size - scan.offset, budget.bytes);
    if (length > 0) {
      const buffer = Buffer.allocUnsafe(length);
      const bytes = buffer.subarray(0, readSync(fd, buffer, 0, length, scan.offset));
      budget.bytes -= length;
      let from = 0;
      for (let end; (end = bytes.indexOf(10, from)) !== -1; from = end + 1) {
        const part = bytes.subarray(from, end);
        const line = scan.parts.length ? Buffer.concat([...scan.parts, part]) : part;
        scan.parts.length = 0;
        applyTaskRow(line, scan, start, c.sessionId);
      }
      if (from < bytes.length) scan.parts.push(Buffer.from(bytes.subarray(from)));
      scan.offset += bytes.length;
    }
    // Until we reach the end, a later row could still change the count.
    if (scan.offset < size) return pending();
    if (scan.open.size) {
      const background = { agents: 0, mcp: 0 };
      for (const kind of scan.open.values()) background[kind]++;
      return remember({ status: "background", background });
    }
    return remember({ status: "idle" });
  } catch { return pending(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

const questionCache = new Map<string, { stamp: string; open: boolean }>();
function questionOf(c: Claim): boolean {
  // The session file can stay idle after a failed write. The transcript records
  // when the question opens and closes. A busy session is already working.
  if (c.agent !== "claude" || c.status === "busy") return false;
  let fd: number | undefined;
  try {
    const path = claudePath(c.sessionId);
    if (!path) return false;
    fd = openSync(path, "r");
    const stat = fstatSync(fd, { bigint: true }), stamp = [stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join("/");
    const cached = questionCache.get(path);
    if (cached?.stamp === stamp) return cached.open;
    const entry = { stamp, open: false };
    if (questionCache.size >= 128) questionCache.delete(questionCache.keys().next().value!);
    questionCache.set(path, entry);
    const size = Number(stat.size), bytes = Buffer.alloc(Math.min(size, 512 << 10));
    if (readSync(fd, bytes, 0, bytes.length, size - bytes.length) !== bytes.length) return false;
    const lines = bytes.toString("utf8").split("\n");
    if (size > bytes.length) lines.shift();
    const closed = new Set<string>();
    for (const line of lines.reverse()) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.sessionId && row.sessionId !== c.sessionId) continue;
      const content = row.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content.reverse()) {
        if (row.type === "user" && item?.type === "tool_result") closed.add(item.tool_use_id);
        if (row.type !== "assistant" || item?.type !== "tool_use" || item.name !== "AskUserQuestion" || closed.has(item.id)) continue;
        const questions = item.input?.questions;
        if (typeof item.id !== "string" || !/^[\w-]{1,128}$/.test(item.id) || !Array.isArray(questions) || !questions.length) return false;
        if (!questions.every((q: any) => typeof q?.question === "string" && Array.isArray(q.options) && q.options.length &&
          q.options.every((o: any) => typeof o?.label === "string"))) return false;
        entry.open = true;
        return true;
      }
    }
  } catch { /* Wait for a complete transcript line. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return false;
}

export function waitingQuestions(surfaces: Set<string>, verifyStart = false) {
  const claude = claudeClaims(surfaces);
  const questions = new Set(claude.filter(questionOf));
  const open = new Set([...questions].map(c => c.leaf));
  if (!open.size) return open;
  // Check for competing agents only on terminals with an open Claude question.
  const found = [...claude, ...codexClaims(open)];
  for (const surface of open) {
    const agent = active(found.filter(c => c.leaf === surface));
    // Before moving the divider, check for PID reuse since the last cached poll.
    if (!agent || !questions.has(agent) || (verifyStart && pidStart(agent.pid) !== agent.start)) open.delete(surface);
  }
  return open;
}

// The shapes of ProviderIcon in agent-chat (src/components/icons.tsx).
const icon = (color: string, width: number, path: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='${path}' fill='none' stroke='${color}' stroke-width='${width}' stroke-linecap='round' stroke-linejoin='round'/></svg>`)}")`;
const CLAUDE = icon("#d97757", 1.45, "M8 1.7v12.6M1.7 8h12.6M3.5 3.5l9 9M12.5 3.5l-9 9");
const CODEX = icon("#10a37f", 1.2, "M8 1.8l4.9 2.8v5.7L8 13.2l-4.9-2.9V4.6L8 1.8zm0 0v4.1m4.9-1.3L9.3 6.7m-6.2-2.1l3.6 2.1m-3.6 3.6l3.6-2.1m6.2 2.1L9.3 8.2M8 13.2V9.1");

// visibility, not display: a hidden frame keeps its layout and its scroll. A frame
// shows after its load, and the frame before it stays until then: no white flash.
// color-scheme: a frame with another scheme than its page gets a white canvas.
// --bar is the height of the strip at the top, --foot of the state line at the bottom.
// Both documents use the same rules so selecting text keeps the keyboard in the page.
export const PLAIN_CLICK = `(focus, extra = '') => {
  const controls = 'a,button,input,textarea,select,summary,label,[contenteditable],[role=button],[tabindex],.code-copy,.cc-copy' + extra;
  const plain = e => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.target.closest(controls);
  let down, timer;
  function cancel() { clearTimeout(timer); down = null; }
  document.addEventListener('pointerdown', e => {
    cancel();
    if (plain(e)) down = e;
  }, true);
  document.addEventListener('pointerup', e => {
    if (!down || down.pointerId !== e.pointerId) return;
    const distance = Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY);
    down = null;
    if (distance < 5 && plain(e)) timer = setTimeout(() => {
      if (document.getSelection()?.isCollapsed) focus();
    }, 350);
  }, true);
  document.addEventListener('pointercancel', cancel, true);
  document.addEventListener('dblclick', cancel, true);
}`;

export const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Chat</title><style>
:root{color-scheme:dark;--page:color-mix(in srgb, #f8f8f2 9%, #212121);background:var(--page);--bar:0px;--foot:0px}:root:has(#bar.tabs){--bar:32px}:root:has(#state:not(:empty)){--foot:28px}body{margin:0;background:var(--page);color:#999;font:14px -apple-system,sans-serif}
iframe{position:fixed;inset:var(--bar) 0 var(--foot);width:100%;height:calc(100% - var(--bar) - var(--foot));border:0;visibility:hidden;color-scheme:light;background:var(--page)}iframe.on{visibility:visible}#note{padding:calc(32px + var(--bar)) 32px 32px}
#bar{position:fixed;inset:0 0 auto;height:var(--bar);box-sizing:border-box;overflow:hidden;display:flex;align-items:stretch;background:#292929;font-size:13px;cursor:default;-webkit-user-select:none}#bar.tabs{border-bottom:1px solid #6272a4}
#tabs{display:flex;min-width:0;overflow-x:auto;scrollbar-width:none}#tabs::-webkit-scrollbar{display:none}
.tab{display:flex;align-items:center;gap:7px;flex:0 1 auto;min-width:110px;max-width:340px;box-sizing:border-box;padding:0 12px;border-right:1px solid #1d1d1d}.tab,#plus{cursor:pointer;transition:background-color 120ms,color 120ms}.tab:hover,#plus:hover{background:#343434;color:#f8f8f2}.tab.me{background:var(--page);color:#f8f8f2;box-shadow:inset 0 2px #6272a4}
.tab i{flex:none;width:14px;height:14px}.tab.claude i{background:${CLAUDE}}.tab.codex i{background:${CODEX}}.tab span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tab b{flex:none;display:none;width:8px;height:8px;border-radius:50%}.tab:is(.busy,.ask,.new) b{display:block}.tab.busy b{background:#ffb86c;animation:beat 1.2s infinite}.tab.new b{background:#50fa7b}.tab.new span{font-weight:700;color:#f8f8f2}.tab.read:not(.me) span{opacity:.6}
.tab.read:not(.me):hover span{opacity:1}.tab span{transition:opacity 120ms}
.tab button{flex:none;margin-left:auto;padding:1px 4px;border:0;border-radius:3px;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:0;pointer-events:none}
.tab:hover button,.tab button:focus-visible,.tab button.confirm{opacity:1;pointer-events:auto}.tab button.confirm{background:#982f39;color:white}
.tab.ask b{width:auto;height:auto;color:#ff79c6}.tab.ask b::before{content:"?"}
#rename{position:fixed;z-index:1;background:#292929;color:#eee;border:1px solid #666;border-radius:4px;padding:5px 12px}
.tab input{min-width:0;width:100%;font:inherit;color:inherit;background:#212121;border:1px solid #6272a4}
#plus{flex:none;display:none;align-items:center;padding:0 12px;font-size:17px}#bar.plus #plus{display:flex}
#state{position:fixed;inset:auto 0 0;height:var(--foot);line-height:28px;padding:0 16px;background:var(--page);font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
#state.busy{color:#ffb86c}#state.done{color:#50fa7b}#state.ask{color:#ff79c6}#state.busy::before{content:"\\25CF  ";animation:beat 1.2s infinite}@keyframes beat{50%{opacity:.15}}
</style></head><body><div id="bar"><div id="tabs"></div><div id="plus" title="New Claude chat">+</div></div><div id="note"></div><div id="state"></div><button id="rename" hidden>Rename</button><script>
const frames = new Map(), loaded = new WeakSet(), note = document.getElementById("note");
let busy = false, timer, shown = null, wanted = null, misses = 0;
function draw(id) { for (const [key, f] of frames) f.className = key === id ? "on" : ""; }
function show(id, text) {
  if (id && !frames.has(id)) {
    const f = document.createElement("iframe");
    let check;
    function ready() {
      clearTimeout(check);
      clearTimeout(fallback);
      loaded.add(f);
      if (wanted === id && frames.get(id) === f) draw(id);
    }
    function checkMessages() {
      if (!f.isConnected || loaded.has(f)) return;
      if (f.contentDocument?.querySelector(".turn-list .turn-group")) ready();
      else check = setTimeout(checkMessages, 40);
    }
    f.onload = ready;
    check = setTimeout(checkMessages, 40);
    const fallback = setTimeout(ready, 3000);
    f.src = "s/t-" + id;
    document.body.append(f);
    frames.set(id, f);
  }
  if (id) { const f = frames.get(id); frames.delete(id); frames.set(id, f); }
  if (frames.size > 5) {
    // Keep the visible chat until its replacement is ready.
    for (const [old, f] of frames) if (f.className !== "on") {
      frames.delete(old);
      f.remove();
      break;
    }
  }
  wanted = id;
  if (!id || loaded.has(frames.get(id))) draw(id);
  note.textContent = text || "";
  shown = id || text;
}
// The app shows "running" only while its transcript grows, and a long command writes nothing.
function words(s) {
  if (s.menu) return ["ask", "? A menu is open in the terminal below"];
  if (s.status === "background") {
    const { agents, mcp } = s.background;
    const counts = [agents && agents + (agents === 1 ? " agent" : " agents"), mcp && mcp + (mcp === 1 ? " MCP task" : " MCP tasks")];
    return ["busy", "Working in the background: " + counts.filter(Boolean).join(", ")];
  }
  const min = Math.floor((Date.now() - s.since) / 60000);
  const ago = min >= 0 ? (min < 1 ? ", just now" : min < 60 ? ", " + min + " min ago" : ", " + Math.floor(min / 60) + " h ago") : "";
  return s.status === "busy" ? ["busy", "Working"] : s.status === "idle" ? ["done", "\u2713 Done, your turn" + ago] : s.status === "shell" ? ["busy", "Working in the background: a shell command"]
    : s.status === "waiting" || (s.status === "asked" && s.unread) ? ["ask", "? Waiting for your answer in the terminal"] : ["", ""];
}
function state(s) {
  const el = document.getElementById("state"), [kind, text] = s.menu || s.session ? words(s) : ["", ""];
  el.className = kind;
  if (el.textContent !== text) el.textContent = text;
}
// The other chats of the project. A tab keeps its element: a click during a change is not lost.
const me = (new URLSearchParams(location.search).get("cmux") || "").toLowerCase();
const tabs = new Map();
let chats = [], plus = false, drawn = "", order = "", started = 0;
function pick(to) { fetch("follow/pick" + location.search + "&to=" + to, { headers: { "x-orca-chat": "pick" } }).catch(() => {}); }
const menu = document.getElementById("rename"), pending = new Map();
let editing, clickTimer;
function edit(t, id) {
  const chat = chats.find(c => c.id === id);
  if (!chat || editing === t) return;
  if (editing) editing.lastElementChild.blur();
  const label = t.children[1], input = document.createElement("input"), before = label.textContent;
  editing = t;
  label.hidden = true;
  input.value = before;
  input.maxLength = 80;
  input.setAttribute("aria-label", "Chat name");
  t.append(input);
  input.focus();
  input.select();
  function finish(save) {
    if (editing !== t) return;
    editing = null;
    const title = input.value;
    input.remove();
    label.hidden = false;
    if (!save || !title.trim() || title.length > 80 || title === before) return;
    const change = { title, until: Date.now() + 5000 };
    pending.set(id, change);
    drawn = "";
    strip();
    const query = new URLSearchParams(location.search);
    query.set("workspace", chat.workspace);
    query.set("title", title);
    fetch("follow/rename?" + query, { headers: { "x-orca-chat": "rename" } }).then(r => {
      if (!r.ok) throw Error();
    }).catch(() => { if (pending.get(id) === change) { pending.delete(id); drawn = ""; strip(); } });
  }
  input.onblur = () => finish(true);
  input.onkeydown = e => {
    if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); finish(e.key === "Enter"); }
  };
}
function strip() {
  const bar = document.getElementById("bar"), row = document.getElementById("tabs");
  bar.className = (chats.length ? "tabs" : "") + (plus ? " plus" : "");
  for (const [id, change] of pending) {
    const chat = chats.find(c => c.id === id);
    if (!chat || chat.title === change.title || Date.now() >= change.until) pending.delete(id);
  }
  const now = JSON.stringify([chats, chats.map(words), [...pending]]);
  if (drawn === now) return;
  drawn = now;
  for (const [id, t] of tabs) if (!chats.some((c) => c.id === id)) {
    if (editing === t) editing = null;
    t.remove();
    tabs.delete(id);
  }
  chats.forEach((c, i) => {
    let t = tabs.get(c.id);
    if (!t) {
      t = document.createElement("div");
      const close = document.createElement("button");
      close.textContent = "×";
      close.setAttribute("aria-label", "Close chat");
      let until = 0, resetTimer;
      function resetClose() {
        until = 0;
        close.className = "";
        close.textContent = "×";
      }
      function requestClose(e) {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(clickTimer);
        clearTimeout(resetTimer);
        const now = Date.now();
        if (t.matches(".busy,.ask") && now >= until) {
          until = now + 3000;
          close.className = "confirm";
          close.textContent = "Close?";
          resetTimer = setTimeout(resetClose, 3000);
          return;
        }
        resetClose();
        fetch("follow/close" + location.search + "&to=" + c.id, { headers: { "x-orca-chat": "close" } }).catch(() => {});
      }
      close.onclick = requestClose;
      close.ondblclick = close.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); };
      t.onauxclick = e => { if (e.button === 1) requestClose(e); };
      t.append(document.createElement("i"), document.createElement("span"), document.createElement("b"), close);
      t.onclick = () => {
        if (editing === t) return;
        if (c.id !== me) return pick(c.id);
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => pick(me), 500);
      };
      t.ondblclick = () => { if (c.id === me) { clearTimeout(clickTimer); edit(t, c.id); } };
      t.oncontextmenu = e => {
        e.preventDefault();
        clearTimeout(clickTimer);
        menu.hidden = false;
        menu.style.left = "min(" + e.clientX + "px, calc(100vw - 80px))";
        menu.style.top = e.clientY + "px";
        menu.onclick = () => { menu.hidden = true; edit(t, c.id); };
        menu.focus();
      };
      tabs.set(c.id, t);
    }
    const [kind, text] = words(c);
    t.className = "tab " + (c.agent || "") + " " + (kind !== "done" ? kind : c.unread ? "new" : "read") + (c.id === me ? " me" : "");
    const title = pending.get(c.id)?.title ?? c.title;
    t.children[1].textContent = title;
    t.title = title + (text ? "\\n" + text + (kind === "done" && c.unread ? ", not read" : "") : "");
    if (row.children[i] !== t) row.insertBefore(t, row.children[i] || null);
  });
  const ids = chats.map((c) => c.id).join();
  if (order !== ids && tabs.has(me)) tabs.get(me).scrollIntoView({ block: "nearest", inline: "nearest" });
  order = ids;
}
document.getElementById("plus").onclick = () => {
  if (Date.now() - started < 3000) return; // a double click
  started = Date.now();
  pick("new");
};
// The app of a frame goes to its start page when the server does not know its session once.
function heal(id) {
  const f = frames.get(id);
  let path;
  try { path = f.contentWindow.location.pathname; } catch { return; }
  if (!loaded.has(f) || path.endsWith("/s/t-" + id) || Date.now() - (f.healed || 0) < 5000) return;
  f.healed = Date.now();
  f.src = "s/t-" + id;
}
async function poll() {
  if (busy) return;
  busy = true;
  clearTimeout(timer);
  let s;
  try {
    const res = await fetch("follow/state" + location.search, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    s = res.ok ? await res.json() : { message: "The chat server refused the request. Run cmux-chat-open in a terminal." };
  } catch { s = { message: "The chat server does not answer. Run cmux-chat-open in a terminal." }; }
  // One bad read is not the end of a session: the chat stays for 5 polls.
  misses = s.session || !wanted ? 0 : misses + 1;
  if (s.session || (s.message && (!wanted || misses > 4)) || !shown) show(s.session, s.session ? "" : s.message || "Open a terminal tab.");
  if (s.menu || s.session || misses > 4 || !wanted) state(s);
  if ("session" in s) { chats = s.chats || []; plus = s.plus; } // not after a bad poll
  strip();
  if (s.session) heal(s.session);
  if (s.title) document.title = "Chat: " + s.title;
  busy = false;
  timer = setTimeout(poll, document.visibilityState === "visible" ? 400 : 5000);
}
menu.onblur = () => { menu.hidden = true; };
menu.onkeydown = e => { if (e.key === "Escape") menu.hidden = true; };
document.addEventListener("visibilitychange", poll);
let lastFocus = -Infinity;
function focusTerminal() {
  const now = performance.now();
  if (now - lastFocus < 400) return;
  lastFocus = now;
  pick(me);
}
(${PLAIN_CLICK})(focusTerminal, ',.tab,#plus');
window.addEventListener('message', e => {
  const iframe = frames.get(wanted);
  if (iframe && iframe.className === 'on' && e.source === iframe.contentWindow &&
      e.origin === location.origin && e.data?.type === 'orca-chat-focus') focusTerminal();
});
poll();
</script></body></html>`;
