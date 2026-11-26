// Moves Claude Code chats from Orca panes to cmux workspaces, one at a time.
// "chats" lists them, and with --go makes the workspaces. "one <id>" runs in the
// workspace: on Enter it stops the idle chat in Orca with one SIGTERM to one pid,
// then prints the folder and the arguments for claude (cmux/move-one runs it).
import { config } from "./config";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CLAUDE_DIR, Refusal, UUID, claudeLive, listTerminals, pidStart, processLeaf, processSurface, ps, refuse, run, sh } from "./common";

const CMUX_DIR = join(import.meta.dir, "../cmux");
const MARK = "Moved from Orca: "; // the description of a workspace, so a second run finds it
const clean = (s: unknown) => String(s ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").replace(/^[\s-]+/, "").trim().slice(0, 80);

// ---- processes ----
interface Row { pid: number; ppid: number; start: string; comm: string }
// All live claude processes with their session file, and the children of all processes.
function processes() {
  const out = Bun.spawnSync(["/bin/ps", "-axww", "-o", "pid=,ppid=,lstart=,comm="], { env: { LC_ALL: "C", TZ: "UTC0", PATH: "/bin:/usr/bin" } });
  const rows: Row[] = [...String(out.stdout).matchAll(/^ *(\d+) +(\d+) +(\S+ +\S+ +\d+ +[\d:]+ +\d+) +(.*)$/gm)].map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3], comm: m[4] }));
  if (!rows.some((r) => r.pid === process.pid)) refuse("ps is not usable here, so no process can be checked");
  return { rows, claudes: rows.filter((r) => /^claude(\.exe)?$/.test(basename(r.comm))).map((row) => ({ row, live: claudeLive(row.pid) as any })) };
}
// Every process that has the session, or can have it: in doubt it counts.
const holders = (id: string, { claudes } = processes()) => claudes.filter(({ row, live }) =>
  live ? live.sessionId === id : existsSync(join(CLAUDE_DIR, "sessions", `${row.pid}.json`)) || ps(row.pid, "args").includes(id));

const VALUES: Record<string, RegExp> = { "--permission-mode": /^[a-zA-Z]{1,20}$/, "--model": /^[\w.:@/[\]-]{1,80}$/, "--effort": /^[a-z]{1,12}$/ };
// ps joins argv with spaces, so this stops at the first word that can be the first prompt.
function launchFlags(args: string[]) {
  const keep = new Map<string, string[]>(), dropped = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const [, name, value] = /^(--?[a-z][a-z-]*)(?:=(.*))?$/s.exec(args[i]) ?? [];
    if (name === "--dangerously-skip-permissions") keep.set(name, [name]);
    else if (name && VALUES[name]) {
      const v = value ?? args[++i] ?? "";
      if (VALUES[name].test(v)) keep.set(name, [name, v]);
    } else if (name && /^(--resume|-r|--session-id)$/.test(name)) i += value === undefined && UUID.test(args[i + 1] ?? "") ? 1 : 0;
    else if (name) dropped.add(name); // its values can follow
    else if (args[i].startsWith("-") || !dropped.size) break;
  }
  return { keep: [...keep.values()].flat(), dropped: [...dropped] };
}
// The one process that has the session, after all checks. null: no live process has it.
function find(id: string) {
  const all = processes(), hits = holders(id, all);
  if (!hits.length) return null;
  if (hits.length > 1) refuse(`${hits.length} live processes have this chat`);
  const { pid, start } = hits[0].row;
  if (processSurface(pid)) refuse("this chat runs in cmux already");
  if (!processLeaf(pid)) refuse("the process of this chat is not in an Orca pane");
  for (const child of all.rows.filter((r) => r.ppid === pid))
    if (basename(child.comm) === "caffeinate" || ps(child.pid, "args").includes("/shell-snapshots/")) refuse("this chat runs a command now");
  const flags = launchFlags(ps(pid, "args").split(/\s+/));
  const live = claudeLive(pid) as any; // last, so the status is fresh
  if (live?.pid !== pid || live.sessionId !== id || live.kind !== "interactive") refuse("the process of this chat is not an interactive Claude with this session");
  if (!start || live.procStart !== start || pidStart(pid) !== start) refuse("the start time of the process is not the one that Claude recorded");
  if (live.status !== "idle") refuse(`this chat is not idle, its status is "${clean(live.status ?? "unknown")}"`);
  return { pid, start, cwd: String(live.cwd ?? ""), ...flags };
}
// The only place that sends a signal: one SIGTERM to one positive pid.
function terminate(pid: unknown) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) refuse("this is not a pid that can get a signal");
  const only = process.env.ORCA_CHAT_MOVE_ONLY_PIDS; // set by the test: it can only narrow
  if (only !== undefined && !only.split(",").includes(String(pid))) refuse("the pid is not in ORCA_CHAT_MOVE_ONLY_PIDS");
  try { process.kill(pid, "SIGTERM"); } catch (err: any) { if (err?.code !== "ESRCH") refuse(`the signal was not sent: ${err?.code}`); }
}

// ---- transcripts and projects ----
function chat(id: string, liveCwd: string) {
  const root = join(CLAUDE_DIR, "projects"), files = readdirSync(root).map((d) => join(root, d, `${id}.jsonl`)).filter(existsSync);
  if (files.length !== 1) refuse(files.length ? "this chat has more than one transcript" : "this chat has no transcript, so it cannot be resumed");
  // Claude finds a conversation only from the folder that gave the transcript folder its name.
  const dir = basename(dirname(files[0])), name = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const fits = (cwd: unknown) => typeof cwd === "string" && cwd.startsWith("/") && (cwd.length > 200 ? dir.startsWith(name(cwd).slice(0, 200)) : dir === name(cwd));
  let at = 0, title = "", cwd = fits(liveCwd) ? liveCwd : "";
  for (const text of readFileSync(files[0], "utf8").split("\n").reverse()) {
    let e: any;
    try { e = JSON.parse(text); } catch { continue; }
    if (!at && (e.type === "user" || e.type === "assistant") && !e.isSidechain && !e.isMeta) at = Date.parse(e.timestamp) || 0;
    if (!title && e.type === "ai-title") title = clean(e.aiTitle);
    if (!cwd && fits(e.cwd)) cwd = e.cwd;
    if (at && title && cwd) break;
  }
  return { cwd, title, at };
}
function project(cwd: string): string {
  const file = process.env.CMUX_CHAT_PROJECTS || join(homedir(), ".config/cmux-chat/projects.txt");
  const all = readFileSync(file, "utf8").split("\n").map((l) => l.split("|").map((s) => s.trim())).filter(([n, p]) => n && p && !n.startsWith("#")).map(([n, p]) => ({ n, p: p.replace(/^~/, homedir()) }));
  const under = (dir: string) => all.filter(({ p }) => dir === p || dir.startsWith(p + "/")).sort((a, b) => b.p.length - a.p.length)[0]?.n ?? "";
  const common = sh("git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  return under(cwd) || (common && under(dirname(common)));
}

// ---- move-chats ----
async function cmux(...args: string[]): Promise<string> {
  const cli = process.env.CMUX_BUNDLED_CLI_PATH || Bun.which("cmux") || refuse("the cmux CLI is not on PATH");
  const proc = Bun.spawn([cli, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CMUX_QUIET: "1" } });
  const timer = setTimeout(() => proc.kill(9), 15_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return code === 0 ? out : refuse(clean(err) || "cmux did not answer");
}
async function chats(argv: string[]) {
  let hours = 24, last = "", go = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--go") go = true;
    else if (argv[i] === "--hours" && Number(argv[i + 1]) > 0) hours = Number(argv[++i]);
    else if (argv[i] === "--last" && UUID.test(argv[i + 1] ?? "")) last = argv[++i].toLowerCase();
    else refuse("usage: move-chats [--go] [--hours N] [--last <sessionId>]");
  }
  const orca = await listTerminals().catch(() => []) as any[];
  const found = new Map<string, ReturnType<typeof chat> & { id: string; n: number; status: string; project: string }>();
  for (const { row, live } of processes().claudes) {
    const leaf = processLeaf(row.pid), id = live?.sessionId;
    if (live?.kind !== "interactive" || live.procStart !== row.start || !UUID.test(id) || !leaf || processSurface(row.pid)) continue;
    if (found.has(id)) { found.get(id)!.n++; continue; }
    try {
      const c = chat(id, live.cwd), title = c.title || clean(orca.find((t) => t.leafId?.toLowerCase() === leaf)?.title) || id;
      if (c.at >= Date.now() - hours * 3_600_000) found.set(id, { ...c, title, id, n: 1, status: clean(live.status ?? "unknown"), project: c.cwd && project(c.cwd) });
    } catch (err: any) { console.error(`${id}: not listed, ${err.message}`); }
  }
  const list = [...found.values()].sort((a, b) => Number(a.id === last) - Number(b.id === last) || b.at - a.at);
  if (!go) {
    for (const c of list) console.log(`${c.title} | ${c.project || "no project"} | ${((Date.now() - c.at) / 3_600_000).toFixed(1)} h | ${c.status}${c.n > 1 ? ` | ${c.n} processes` : ""}`);
    return console.log(`${list.length} chats. Nothing was made. Run it with --go to make the workspaces.`);
  }
  const windows = JSON.parse(await cmux("list-windows", "--json")) as any[], have = new Set<string>();
  for (const w of windows) for (const s of JSON.parse(await cmux("workspace", "list", "--window", w.id, "--json")).workspaces) have.add(String(s.description).split(" | ")[0]); // the sidebar adds " | last active <time>"
  const groups = JSON.parse(await cmux("workspace-group", "list", "--json")).groups as any[];
  const layout = config("cmux.json").commands.find((c: any) => c.name === "Claude + chat").workspace.layout;
  const terminal = layout.children.flatMap((n: any) => n.pane.surfaces).find((s: any) => s.type === "terminal");
  const script = `'${join(CMUX_DIR, "move-one").replaceAll("'", `'\\''`)}'`;
  let bad = 0;
  for (const c of list) {
    if (have.has(MARK + c.id)) { console.log(`already there: ${c.title}`); continue; }
    try {
      if (!c.cwd || !existsSync(c.cwd)) refuse("its folder is not there");
      const hits = groups.filter((g) => c.project && g.name === c.project), group = hits.length === 1 ? hits[0].id ?? hits[0].ref : "";
      terminal.command = `${script} ${c.id}`;
      await cmux("new-workspace", "--name", c.title, "--description", MARK + c.id, "--cwd", c.cwd, "--layout", JSON.stringify(layout), ...(group ? ["--group", group, "--group-placement", "end"] : []), "--focus", "false");
      console.log(`made: ${c.title} | ${group ? c.project : c.project ? `no group: cmux has ${hits.length} groups with the name ${c.project}` : "no group: no project has this folder"}`);
      await Bun.sleep(1500); // cmux drops a typed command when the shell is not ready in 3 s
    } catch (err: any) {
      bad++;
      console.log(`FAILED: ${c.title} | ${clean(err.message)}`);
    }
  }
  console.log(`If a terminal is empty, run there: ${script} <the id in the workspace description>`);
  if (bad) refuse(`${bad} failed, run it again to make only those`);
}

// ---- move-one ----
// Not the line iterator of Bun: it gives an empty line at the end of the input, and that is not an Enter.
async function* lines() {
  let rest = "";
  for await (const chunk of Bun.stdin.stream()) {
    const parts = (rest + Buffer.from(chunk).toString()).split("\n");
    rest = parts.pop()!;
    yield* parts;
  }
}
async function one(id: string) {
  if (!UUID.test(id ?? "")) refuse("usage: move-one <sessionId>");
  let shown = { cwd: "", keep: [] as string[], live: false }, old: { pid: number; start: string } | null = null;
  const runs = () => old && pidStart(old.pid) === old.start;
  // Reads everything again. true: what it printed before is still right.
  const look = () => {
    const proc = find(id), c = chat(id, proc?.cwd ?? "");
    if (!c.cwd || /\p{Cc}/u.test(c.cwd)) refuse("the folder of this chat is not known");
    if (!existsSync(c.cwd) || !statSync(c.cwd).isDirectory()) refuse(`the folder is gone: ${c.cwd}`);
    if (!Bun.which("claude")) refuse("claude is not on PATH");
    const now = { cwd: c.cwd, keep: proc?.keep ?? shown.keep, live: !!(proc || old) };
    if (Bun.deepEquals(now, shown)) return true;
    console.error(`${c.title || id}\n${c.cwd}\nFlags: ${now.keep.join(" ") || "none"}${proc?.dropped.length ? ` (not kept: ${proc.dropped.join(" ")})` : ""}${proc ? "" : "\nNo process has this chat now. Enter only resumes it here."}`);
    shown = now;
    return false;
  };
  const attempt = async (act: () => unknown) => {
    try { await act(); return true; } catch (err: any) {
      console.error(`Not moved: ${err instanceof Refusal ? err.message : `internal error: ${err?.message}`}.${old ? "" : " Nothing was changed."}`);
      return false;
    }
  };
  const ask = () => console.error("Press Enter to move this chat, Ctrl-C to leave it.");
  await attempt(look);
  ask();
  for await (const line of lines()) {
    const done = await attempt(async () => {
      if (line.trim()) refuse("there was text before Enter");
      if (runs()) refuse(`the old process ${old!.pid} still runs`);
      if (!look()) refuse("look at the lines above first");
      const proc = find(id); // again, immediately before the signal
      if (proc) {
        if (!Bun.deepEquals(proc.keep, shown.keep)) refuse("the chat changed just now");
        terminate(proc.pid);
        old = proc;
        for (let i = 0; i < 150 && runs(); i++) await Bun.sleep(100);
        if (runs()) refuse(`the signal was sent, but the process ${proc.pid} still runs after 15 seconds. It was not resumed`);
      }
      if (holders(id).length) refuse("another process has this chat now");
    });
    if (done) return console.log([shown.cwd, "--resume", id, ...shown.keep].join("\n"));
    ask();
  }
  refuse("the input ended, the chat was left as it is");
}

run(() => {
  if (!process.env.CMUX_WORKSPACE_ID) refuse("run this inside cmux");
  const [mode, ...rest] = process.argv.slice(2);
  return mode === "one" ? one(rest[0]) : chats(rest);
});
