// Live text: the page shows the answer and the thinking of Claude while they
// stream. The mod mods/live-text writes a snapshot of the running model request
// (a "step") to <state>/live/<session id>.json, about 10 times a second. Claude
// writes the transcript only when the whole message is complete.
//
// The history of the server (sess.events) has only events of the transcript, as
// before. Live text goes only to the open pages. All pages of a session show the
// same live blocks: `shown`. When the transcript brings a block:
//   - it is the open block on the page: "assistant" replaces it; for "thinking"
//     the page gets only the rest, because the page appends it.
//   - it is a closed block with the same text: the page gets nothing.
//   - all other cases: the pages get the history again, as after a reload, and
//     then the live blocks that are still valid.
//
// Ways it can fail (written before the code). L = covered in e2e/live.e2e.ts.
// Twice
//   L01 Text or thinking shows twice: snapshot first, transcript first, or both at once.
//   L02 A page that loads in the middle, or a second page, misses text or has it twice.
//   L03 The server restarts in the middle, or just after the final line.
//   L04 Final thinking is added to the live thinking.
// Old text
//   L05 After an interrupt, a crash, or a resume the page shows old text. Text that the transcript never gets stays.
//   L06 An old file, or a file from before the last prompt, shows when a page opens.
//   L07 A retry of the model request: the page shows the text of the first try, or both.
//   L08 A snapshot of another step, or of a second Claude with the same session, mixes in.
// Order
//   L09 A queued message, a status, an error, or a tool call closes the open block, and the final text makes a second block.
//   L10 Thinking, then text, then tools, with all lines at the end. Two text blocks in one step. Steps that follow fast.
//   L11 Thinking that the transcript keeps empty stays, or it stops the text after it.
//   L12 The final text is not the streamed text (another mod changed it).
//   L13 A transcript that is cut or replaced in the middle.
// Wrong session
//   L14 Text of a subagent or of another session. A file with another session in it.
//   L15 /clear, /new, /resume: the old page gets the new text.
// Server
//   L16 The history grows, or a new page gets many small events.
//   L17 "running" and "done" break: a turn that streams for a minute becomes idle, or a done turn runs again.
//   L18 A bad file: too big, not JSON, wrong types, a link, a pipe, another owner, an open folder, a write that is half done.
//   L19 The folder or the mod is missing, Codex: something changes.
//   L20 A new network write, or a WebSocket op that was not allowed before.
//   L21 The parser has other code in a new pin: the server does not start, or the queue part is lost too.
//   L22 Work for pages that nobody has open.
//   L23 One session that fails stops the others, or stops the transcript.
// Mod (checked by hand in a real Claude, see the report of the work)
//   M01 It slows, changes, or breaks the answer in the terminal, also on a write error.
//   M02 An old write lands on a newer one. The empty end state is lost after an interrupt.
//   M03 The text can be read by another user.
// Known: a text block after a tool call in the same message is not live, it shows when it ends.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, chmodSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, UUID, ensureStateDir } from "./common";

const DIR = join(STATE_DIR, "live");
const POLL_MS = 150;
const FRESH_MS = 10_000; // the mod writes every 3 s, also when nothing is new
const GRACE_MS = 2_000; // the last line of the transcript can be later than the end of the step
const MAX_FILE = 4 << 20, MAX_BLOCKS = 500, MAX_LINES = 64;

// The mod does not make this folder: it would be open to all users.
try {
  ensureStateDir();
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (lstatSync(DIR).isDirectory()) chmodSync(DIR, 0o700);
} catch (err: any) {
  console.log(`[orca-chat] live text is off: ${err?.message ?? err}`);
}

interface LiveBlock { i: number; kind: "text" | "thinking" | "tool"; text: string }
interface Snapshot { key: string; writer: string; startedAt: number; ended: boolean; blocks: LiveBlock[] }
interface Sock { send(text: string): void }
// The parts of the server's session that this file uses.
interface Sess {
  id: string;
  events: any[];
  internal: Record<string, any>;
  sockets?: Set<Sock>;
  emit(evt: any): void;
}
interface Tail { poll(): Promise<void>; stop(): void }
interface Live { line(raw: string): void; emit(evt: any): void; reset(): void }

// ---- the snapshot file ----

// "wait": the write is half done, look again.
function parse(text: string, session: string): Snapshot | "wait" | null {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return "wait";
  }
  const int = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  const str = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 200;
  if (j?.v !== 1 || typeof j.session !== "string" || j.session.toLowerCase() !== session || !str(j.writer) || !str(j.turn) || !int(j.step) || !int(j.attempt) || !int(j.startedAt) || typeof j.ended !== "boolean") return null;
  if (!Array.isArray(j.blocks) || j.blocks.length > MAX_BLOCKS) return null;
  let last = -1;
  for (const b of j.blocks) {
    if (!int(b?.i) || b.i <= last || !["text", "thinking", "tool"].includes(b.kind) || typeof b.text !== "string") return null;
    last = b.i;
  }
  return { key: `${j.writer} ${j.turn} ${j.step} ${j.attempt}`, writer: j.writer, startedAt: j.startedAt, ended: j.ended, blocks: j.blocks.map(({ i, kind, text }: LiveBlock) => ({ i, kind, text })) };
}

class SnapshotFile {
  snap: Snapshot | null = null;
  private mtimeMs = 0;
  private stamp = "";
  constructor(private readonly session: string) {}

  get isFresh() {
    return Math.abs(Date.now() - this.mtimeMs) < FRESH_MS;
  }

  read() {
    let fd: number | undefined;
    try {
      const uid = process.getuid!();
      const path = join(DIR, `${this.session}.json`);
      const st = lstatSync(path);
      const stamp = `${st.ino} ${st.mtimeMs} ${st.size}`;
      if (stamp === this.stamp) return;
      this.stamp = stamp;
      const dir = lstatSync(DIR);
      if (!dir.isDirectory() || dir.uid !== uid || dir.mode & 0o077) throw new Error("the folder is not private");
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || info.size > MAX_FILE) throw new Error("not a file of the mod");
      const snap = parse(readFileSync(fd, "utf8"), this.session);
      if (snap === "wait" && Date.now() - info.mtimeMs < GRACE_MS) return void (this.stamp = "");
      if (snap === "wait") throw new Error("not JSON");
      // Two Claudes with one session: the first one, while it streams.
      if (snap && this.snap && snap.writer !== this.snap.writer && !this.snap.ended && this.isFresh) return;
      this.snap = snap;
      this.mtimeMs = info.mtimeMs;
    } catch (err: any) {
      this.snap = null;
      if (err?.code) this.stamp = "";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

// ---- one session ----

const sessions = new Map<string, { live: LiveSession; sess: Sess }>();
// The subscribe op of the server, for one page. It sends the history.
let subscribe: ((ws: any, raw: string) => void) | null = null;

export function liveServer(message: (ws: any, raw: string) => void) {
  subscribe = message;
}

// A page has just got the history: it needs the live blocks too.
export function liveJoin(ws: Sock, sessionId: unknown) {
  if (typeof sessionId === "string") sessions.get(sessionId)?.live.join(ws);
}

const wireEvent = (b: { kind: string; text: string }) => (b.kind === "text" ? { kind: "delta", text: b.text } : { kind: "thinking", text: b.text });
const stampOf = (raw: string): number => {
  try {
    return Date.parse(JSON.parse(raw).timestamp);
  } catch {
    return NaN;
  }
};

class LiveSession implements Live {
  private shown: LiveBlock[] = [];
  private shownKey = "";
  private lateSince = 0; // the step of `shown` has ended, but its lines are missing
  private isResync = false;
  private isBusy = false;
  private isOff = false;
  private raw = "";
  private boundary: string | number | null = null; // the last line that starts or ends a turn, or its time
  private lines: { id?: string; at: number; blocks: { kind: string; text: string }[]; raw?: string }[] = [];
  private readonly file: SnapshotFile;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly sess: Sess, session: string, private readonly tail: Tail) {
    this.file = new SnapshotFile(session);
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    const stop = tail.stop.bind(tail);
    tail.stop = () => {
      this.isOff = true;
      clearInterval(this.timer);
      if (sessions.get(sess.id)?.live === this) sessions.delete(sess.id);
      stop();
    };
  }

  // ---- what the transcript says ----

  line(raw: string) {
    this.raw = raw;
    if (!raw.includes('"type":"assistant"')) return;
    this.lines.push({ at: NaN, blocks: [], raw });
    if (this.lines.length > MAX_LINES) this.lines.shift();
  }

  reset() {
    this.shown = [];
    this.lines = [];
    this.boundary = null;
  }

  emit(evt: any) {
    if (evt.kind === "user" || evt.kind === "done") this.boundary = this.raw;
    const first = this.shown[0];
    // A tool result does not close the open block.
    if (!first || evt.kind === "tool-end") return this.sess.emit(evt);
    const isSame = (evt.kind === "assistant" && first.kind === "text") || (evt.kind === "thinking" && first.kind === "thinking");
    if (isSame && this.shown.length === 1 && evt.kind === "assistant") {
      this.shown = [];
      return this.sess.emit(evt);
    }
    this.quiet(evt);
    if (isSame && this.shown.length === 1 && evt.text.startsWith(first.text)) {
      this.shown = [];
      if (evt.text !== first.text) this.wire({ kind: "thinking", text: evt.text.slice(first.text.length) });
    } else if (isSame && evt.text === first.text) {
      this.shown.shift();
    } else {
      this.resync();
    }
  }

  // To the history, not to the pages.
  private quiet(evt: any) {
    const { sockets } = this.sess;
    this.sess.sockets = new Set();
    try {
      this.sess.emit(evt);
    } finally {
      this.sess.sockets = sockets;
    }
  }

  private wire(evt: any, to: Iterable<Sock> = this.sess.sockets ?? []) {
    const payload = JSON.stringify({ kind: "event", sessionId: this.sess.id, evt });
    for (const ws of to) ws.send(payload);
  }

  // After all events that are in work now: the pages get the history again.
  private resync() {
    this.shown = [];
    if (this.isResync) return;
    this.isResync = true;
    queueMicrotask(() => {
      this.isResync = false;
      this.shown = [];
      if (this.isOff) return;
      for (const ws of [...(this.sess.sockets ?? [])]) subscribe?.(ws, JSON.stringify({ op: "subscribe", sessionId: this.sess.id }));
      if (!this.isOff) this.show();
    });
  }

  join(ws: Sock) {
    for (const block of this.shown) this.wire(wireEvent(block), [ws]);
    void this.tick();
  }

  // ---- what the snapshot says ----

  private async tick() {
    if (this.isBusy || this.isOff || !this.sess.sockets?.size) return;
    this.isBusy = true;
    try {
      this.file.read();
      if (!this.isActive && !this.shown.length) return;
      // The transcript must not be older than the snapshot.
      await this.tail.poll().catch(() => {});
      if (!this.isOff) this.show();
    } catch (err: any) {
      console.log(`[orca-chat] live text: ${err?.name ?? "error"}`);
    } finally {
      this.isBusy = false;
    }
  }

  private get isActive() {
    return Boolean(this.file.snap && !this.file.snap.ended && this.file.isFresh);
  }

  // The blocks of the step that the transcript does not have yet, in order.
  private visible(snap: Snapshot): LiveBlock[] {
    // A prompt or an end of a turn after the start of the step: the step is over.
    if (typeof this.boundary === "string") this.boundary = stampOf(this.boundary);
    if (this.boundary !== null && this.boundary > snap.startedAt) return [];
    const done: { kind: string; text: string }[] = [];
    let id: string | undefined, count = 0;
    for (const line of this.lines) {
      if (line.raw !== undefined) {
        try {
          const ev = JSON.parse(line.raw);
          if (ev.type === "assistant" && !ev.isSidechain && Array.isArray(ev.message?.content)) {
            line.at = Date.parse(ev.timestamp);
            line.id = String(ev.message.id);
            line.blocks = ev.message.content.map((b: any) => ({ kind: String(b?.type), text: String(b?.text ?? b?.thinking ?? "").trim() }));
          }
        } catch {}
        line.raw = undefined;
      }
      if (!(line.at >= snap.startedAt)) continue;
      if (line.id !== id) count = 0;
      id = line.id;
      count += line.blocks.length;
      done.push(...line.blocks);
    }
    const out: LiveBlock[] = [];
    for (const b of snap.blocks) {
      if (b.i < count) continue;
      // Its place is after the line of the tool call, which is not here yet.
      if (b.kind === "tool") break;
      const text = b.text.trim();
      if (!text || done.some((d) => d.kind === b.kind && d.text.startsWith(text))) continue;
      // Two texts would become one on the page.
      if (b.kind === "text" && out.at(-1)?.kind === "text") break;
      out.push(b);
    }
    return out;
  }

  private show() {
    const { sess } = this, { snap } = this.file, isActive = this.isActive;
    if (this.isResync || !sess.events.length) return;
    const next = isActive ? this.visible(snap!) : [];
    if (this.shown.length) {
      const isSameStep = isActive && this.shownKey === snap!.key;
      const isLonger = this.shown.every((b, n) => next[n]?.i === b.i && (n === this.shown.length - 1 ? next[n].text.startsWith(b.text) : next[n].text === b.text));
      if (!isSameStep) {
        // The end of the step. Its lines must come now, if they come at all.
        this.lateSince ||= Date.now();
        const isRetry = isActive && snap!.key.startsWith(this.shownKey.slice(0, this.shownKey.lastIndexOf(" ") + 1));
        if (isRetry || Date.now() - this.lateSince > GRACE_MS) this.resync();
        return;
      }
      if (!isLonger) return this.resync();
    }
    this.lateSince = 0;
    if (!isActive) return;
    // A long answer writes no line: the turn still runs.
    const state = sess.internal.transcript;
    if (state && typeof state.lastWriteMs === "number") state.lastWriteMs = Math.max(state.lastWriteMs, Date.now());
    this.shownKey = snap!.key;
    next.forEach((b, n) => {
      const old = this.shown[n];
      if (old && old.text === b.text) return;
      this.wire(wireEvent({ kind: b.kind, text: old ? b.text.slice(old.text.length) : b.text }));
      this.shown[n] = { ...b };
    });
  }
}

// Called by the changed parser for each transcript that the server follows.
export function attachLive(sess: Sess, agent: string, tail: Tail): Live {
  const session = /^t-(.+)$/.exec(sess.id)?.[1]?.toLowerCase() ?? "";
  if (agent !== "claude" || !UUID.test(session) || !(sess.sockets instanceof Set)) return { line() {}, emit: (evt) => sess.emit(evt), reset() {} };
  const live = new LiveSession(sess, session, tail);
  sessions.set(sess.id, { live, sess });
  return live;
}

// ---- the parser of cmux, changed at load by lib/queue.ts ----

const CHANGES: [string, string][] = [
  [
    '  const tail = new TranscriptTail(path, (lines, mtimeMs) => {\n',
    '  let live: ReturnType<typeof attachLive>;\n  const tail = new TranscriptTail(path, (lines, mtimeMs) => {\n',
  ],
  [
    '    for (const line of lines) {\n      if (transcriptState(sess) !== st) return;\n',
    '    for (const line of lines) {\n      if (transcriptState(sess) !== st) return;\n      live.line(line);\n',
  ],
  [
    '        if (transcriptState(sess) !== st) return;\n        sess.emit(evt);\n',
    '        if (transcriptState(sess) !== st) return;\n        live.emit(evt);\n',
  ],
  [
    '      st.lastWriteMs = 0;\n      if (sess.resetHistory)',
    '      st.lastWriteMs = 0;\n      live.reset();\n      if (sess.resetHistory)',
  ],
  [
    '  sess.internal.transcriptPath = path;\n  tail.start();\n',
    '  sess.internal.transcriptPath = path;\n  live = attachLive(sess as any, agent, tail);\n  tail.start();\n',
  ],
];

export function addLive(source: string): string {
  if (!CHANGES.every(([from]) => source.split(from).length === 2)) {
    console.log("[orca-chat] live text is off: the parser has changed");
    return source;
  }
  const changed = CHANGES.reduce((text, [from, to]) => text.replace(from, () => to), source);
  return `import { attachLive } from ${JSON.stringify(import.meta.path)};\n${changed}`;
}
