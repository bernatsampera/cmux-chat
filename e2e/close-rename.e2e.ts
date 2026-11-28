// Ways the helper can fail (written before the code).
// H01 A leftover survives startup or a close event, closes before two reads 1.5 s apart, or is not logged.
// H02 A terminal moved across windows, another URL, a markdown surface, or a terminal is lost.
// H03 The workspace changes during the delay and is closed anyway.
// H05 A page whose terminal this helper never saw alive (after a restart of cmux the id can be new) is closed.
// H06 cmux does not answer for 15 s: the helper stops, so the strip of every page goes away.
// H07 Closing a known chat page leaves its lone terminal behind, closes too soon, or closes twice.
// H07 The helper mistakes its own page close for a user close, or closes a workspace that had extra tabs.
// H07 A replacement page in another window, a missing workspace, or a changed workspace is overlooked.
// H07 A terminal never seen with its page, or a helper with close-with-page disabled, triggers a close.
// H04 Rename targets an unlisted workspace, loses user ownership, or changes quotes, shell text or newlines.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const write = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data));
const pageClosed = (workspace_id: string, surface_id: string) => ({
  boot_id: "test", name: "surface.closed", workspace_id, surface_id, payload: { kind: "browser", origin: "tab_close" },
});

async function fake(dir: string) {
  const [verb, method] = process.argv.slice(2);
  if (verb === "events") {
    if (method === "--snapshot") return console.log('{"boot_id":"test"}');
    let sent = "";
    setInterval(() => {
      if (!existsSync(join(dir, "event"))) return;
      const event = readFileSync(join(dir, "event"), "utf8");
      if (event !== sent) console.log(sent = event);
    }, 30);
    return;
  }
  const params = JSON.parse(await Bun.stdin.text());
  if (existsSync(join(dir, "slow"))) process.exit(1);
  const treeFile = join(dir, "tree"), windows = read(treeFile);
  const spaces = windows.flatMap((w: any) => w.workspaces);
  appendFileSync(join(dir, "calls"), JSON.stringify({ method, params, at: Date.now() }) + "\n");
  const delayFile = join(dir, "delay-" + method);
  if (existsSync(delayFile)) {
    renameSync(delayFile, delayFile + ".used");
    await Bun.sleep(4500);
  }
  const hold = join(dir, "hold-pipe");
  if (method === "surface.move" && existsSync(hold)) {
    renameSync(hold, hold + ".used");
    Bun.spawn(["/bin/sleep", "12"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }).unref();
    process.exit(0);
  }
  switch (method) {
    case "surface.move": return console.log("{}");
    case "workspace.create": return console.log(JSON.stringify({ workspace_id: "old-pick" }));
    case "workspace.select":
      write(join(dir, "selected"), params.workspace_id);
      return console.log("{}");
    case "surface.list": return console.log(JSON.stringify({ workspace_id: params.workspace_id,
      surfaces: spaces.find((w: any) => w.id === params.workspace_id).panes.flatMap((p: any) => p.surfaces) }));
    case "surface.close": {
      const w = spaces.find((w: any) => w.id === params.workspace_id);
      for (const p of w.panes) p.surfaces = p.surfaces.filter((s: any) => s.id !== params.surface_id);
      write(treeFile, windows);
      write(join(dir, "event"), pageClosed(w.id, params.surface_id));
      return console.log("{}");
    }
    case "system.tree": return console.log(JSON.stringify({ windows: params.all_windows ? windows : [] }));
    case "workspace.list": return console.log(JSON.stringify({ workspaces: windows.find((w: any) => w.id === params.window_id).workspaces }));
    case "workspace.group.list": return console.log(JSON.stringify({ groups: [{ id: "g", idempotency_key: "project:/tmp/fake", member_workspace_ids: spaces.filter((w: any) => w.title !== "ungrouped" && !w.ungrouped).map((w: any) => w.id) }] }));
    case "notification.list": return console.log('{"notifications":[]}');
    case "workspace.close":
      // Like cmux: a workspace with a terminal (a running process) closes only with force.
      if (!params.force && spaces.find((w: any) => w.id === params.workspace_id)?.panes.some((p: any) => p.surfaces.some((s: any) => s.type === "terminal"))) process.exit(1);
      for (const w of windows) w.workspaces = w.workspaces.filter((s: any) => s.id !== params.workspace_id);
      break;
    case "workspace.rename": spaces.find((w: any) => w.id === params.workspace_id).title = params.title; break;
    default: throw Error(method);
  }
  write(treeFile, windows);
  console.log("{}");
}

async function test() {
  const dir = mkdtempSync(join(tmpdir(), "close-rename-")), uuid = () => crypto.randomUUID();
  const cli = join(dir, "cmux"), treeFile = join(dir, "tree"), log = join(dir, "helper.log");
  writeFileSync(cli, "#!" + process.execPath + "\nimport " + JSON.stringify(import.meta.path), { mode: 0o700 });
  const term = () => ({ type: "terminal", id: uuid() });
  const page = (id = uuid()) => ({ type: "browser", id: uuid(), url: "http://127.0.0.1:47739/" + "a".repeat(64) + "/follow?cmux=" + id });
  const space = (...surfaces: object[]) => ({ id: uuid(), title: "old", panes: [{ id: uuid(), surfaces }] });
  const remote = term(), local = term(), leaving = term();
  const orphan = space(page(), page()), moved = space(page(remote.id)), live = space(page(local.id), local);
  const mixed = space(page(), { ...page(), url: "https://example.org" }), markdown = space(page(), { type: "markdown", id: uuid() });
  const rescued = space(page()), eventSpace = space(page(leaving.id), leaving);
  const chat = () => {
    const terminal = term(), browser = page(terminal.id);
    return { terminal, browser, workspace: space(terminal, browser) };
  };
  const ungrouped = chat(), destination = chat(), fromTab = chat();
  ungrouped.workspace.title = "ungrouped";
  ungrouped.workspace.panes[0].surfaces.push({ ...term(), selected_in_pane: true } as any);
  const normal = chat(), replaced = chat(), extra = chat(), gone = chat(), altered = chat(), unseen = chat(), disabled = chat();
  const manual = [normal, replaced, extra, gone, altered, unseen];
  extra.workspace.panes.push({ id: uuid(), surfaces: [term()] });
  unseen.workspace.panes[0].surfaces = [unseen.browser];
  const own = chat(), ownLeaving = term(), ownPage = page(ownLeaving.id);
  own.workspace.panes[0].surfaces.push(ownLeaving, ownPage);
  write(treeFile, [{ workspaces: [orphan, moved, live, mixed, markdown, rescued, eventSpace, own.workspace,
    destination.workspace, fromTab.workspace, ungrouped.workspace, disabled.workspace, ...manual.map(c => c.workspace)] }, { workspaces: [space(remote)] }]);
  const calls = () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const results: { name: string; ok: boolean }[] = [];
  const check = (name: string, ok: boolean) => { results.push({ name, ok }); console.log(ok ? "PASS" : "FAIL", name); };
  const wait = async (predicate: () => boolean, ms = 4000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(30)) if (predicate()) return true;
    return false;
  };
  const startHelper = (enabled: string) => Bun.spawn([process.execPath, join(import.meta.dir, "../lib/tabs.ts")], {
    env: { HOME: dir, PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: join(dir, "claude"), CODEX_HOME: join(dir, "codex"), ORCA_CHAT_STATE_DIR: dir, CMUX_BUNDLED_CLI_PATH: cli, FAKE_CMUX_DIR: dir, CMUX_SOCKET_PATH: join(dir, "unused.sock"), ORCA_CHAT_CLOSE_WITH_PAGE: enabled },
    stdout: "ignore", stderr: Bun.file(log),
  });
  let helper = startHelper("1");
  const closed = (id: string) => calls().some(c => c.method === "workspace.close" && c.params.workspace_id === id);
  try {
    await wait(() => existsSync(join(dir, "chats.json")));
    const tree = read(treeFile);
    tree[0].workspaces.find((w: any) => w.id === rescued.id).panes[0].surfaces.push(term());
    write(treeFile, tree);
    await Bun.sleep(2500);
    check("H05 at start, a page whose terminal was never seen stays", !closed(orphan.id));
    const changed = read(treeFile);
    changed[0].workspaces.find((w: any) => w.id === eventSpace.id).panes[0].surfaces.pop();
    write(treeFile, changed);
    write(join(dir, "event"), { boot_id: "test", name: "surface.closed", surface_id: leaving.id });
    const shut = Date.now();
    check("H01 a close event cleans up before the periodic sweep", await wait(() => closed(eventSpace.id), 2700));
    const close = calls().find(c => c.method === "workspace.close" && c.params.workspace_id === eventSpace.id);
    check("H01 the close waits for a second all-window tree 1.5 s later", Boolean(close) && close.at >= shut + 1500 && calls().some(c => c.method === "system.tree" && c.params.all_windows && c.at >= shut + 1500 && c.at <= close.at));
    check("H02 H03 mixed, moved, live and rescued workspaces survive", [orphan, mixed, moved, live, markdown, rescued].every(w => !closed(w.id)));
    const request = (workspace: string, title: string) => write(join(dir, "rename.json"), { workspace, title, at: Date.now() });
    request(mixed.id, "unlisted");
    await Bun.sleep(350);
    const title = "Quotes '\" $(echo hi)\nsecond line";
    request(live.id, title);
    check("H04 the next chat list confirms the exact title", await wait(() => read(join(dir, "chats.json")).projects[0].chats.some((c: any) => c.workspace === live.id && c.title === title)));
    const renames = calls().filter(c => c.method === "workspace.rename");
    check("H04 only a listed workspace gets a user rename", renames.length === 1 && renames[0].params.workspace_id === live.id && renames[0].params.title === title && renames[0].params.title_source === undefined);
    const closeTab = (workspace: string, terminal: string) => write(join(dir, "close.json"), { workspace, terminal, at: Date.now() });
    for (const [workspace, terminal] of [[live.id, destination.terminal.id], [ungrouped.workspace.id, ungrouped.terminal.id]]) {
      const since = calls().length;
      closeTab(workspace, terminal);
      if (!await wait(() => calls().slice(since).some(c => c.method === "workspace.group.list"))) throw Error("close did not read project membership");
    }
    closeTab(fromTab.workspace.id, fromTab.terminal.id);
    const message = "closed chat workspace " + fromTab.workspace.id + " from its tab";
    check("H13 a tab close uses force, logs the workspace and removes it from the strip", await wait(() =>
      readFileSync(log, "utf8").includes(message) && !read(join(dir, "chats.json")).projects[0].chats.some((c: any) => c.workspace === fromTab.workspace.id)) &&
      calls().filter(c => c.method === "workspace.close" && c.params.workspace_id === fromTab.workspace.id && c.params.force === true).length === 1);
    check("H14 a mismatched terminal or an ungrouped chat stays open", !closed(live.id) && !closed(ungrouped.workspace.id) && !closed(destination.workspace.id));
    const before = read(treeFile);
    const ownPane = before[0].workspaces.find((w: any) => w.id === own.workspace.id).panes[0];
    ownPane.surfaces = ownPane.surfaces.filter((s: any) => s.id !== ownLeaving.id);
    write(treeFile, before);
    write(join(dir, "event"), { boot_id: "test", name: "surface.closed", surface_id: ownLeaving.id });
    if (!await wait(() => calls().some(c => c.method === "surface.close" && c.params.surface_id === ownPage.id))) throw Error("helper did not close its leftover page");
    await Bun.sleep(400);
    const shutPages = (chats: typeof manual) => {
      const tree = read(treeFile);
      for (const c of chats) tree[0].workspaces.find((w: any) => w.id === c.workspace.id).panes = [{ id: uuid(), surfaces: [c.terminal] }];
      write(treeFile, tree);
      writeFileSync(join(dir, "event"), chats.map(c => JSON.stringify(pageClosed(c.workspace.id, c.browser.id))).join("\n"));
    };
    const started = Date.now();
    shutPages(manual);
    if (!await wait(() => !read(join(dir, "chats.json")).projects[0].chats.some((c: any) => c.workspace === normal.workspace.id))) throw Error("page closure was not observed");
    const during = read(treeFile);
    during[1].workspaces.push(space(page(replaced.terminal.id)));
    during[0].workspaces = during[0].workspaces.filter((w: any) => w.id !== gone.workspace.id);
    during[0].workspaces.find((w: any) => w.id === altered.workspace.id).panes[0].surfaces.push(term());
    write(treeFile, during);
    await wait(() => closed(normal.workspace.id));
    writeFileSync(join(dir, "slow"), "");
    await Bun.sleep(15_000);
    const alive = helper.exitCode === null;
    renameSync(join(dir, "slow"), join(dir, "slow.off"));
    const back = Date.now();
    check("H06 after 15 s without answers the helper still runs and reads cmux again", alive && await wait(() => helper.exitCode === null && calls().some(c => c.method === "system.tree" && c.at > back), 12_000));
    const lines = readFileSync(log, "utf8").split("\n");
    check("H01 one log line per close", lines.filter(l => l.includes(eventSpace.id)).length === 1 && !lines.some(l => l.includes(orphan.id)));
    const closes = calls().filter(c => c.method === "workspace.close" && c.params.workspace_id === normal.workspace.id);
    const reads = calls().filter(c => c.method === "system.tree" && c.params.all_windows && c.at >= started && c.at <= closes[0]?.at);
    check("H07 one logged close after two all-window reads 1.5 s apart", closes.length === 1 && closes[0].params.force === true && !read(treeFile).some((w: any) => w.workspaces.some((s: any) => s.id === normal.workspace.id)) && reads.length >= 2 &&
      reads.at(-1).at - reads[0].at >= 1500 && lines.filter(l => l.endsWith("closed chat workspace " + normal.workspace.id + " after its page was closed")).length === 1);
    check("H07 the helper's own page close leaves the workspace open", !closed(own.workspace.id));
    check("H07 a replacement page in another window protects the terminal", !closed(replaced.workspace.id));
    check("H07 an extra pane before closure protects the workspace", !closed(extra.workspace.id));
    check("H07 a missing or changed workspace is skipped", !closed(gone.workspace.id) && !closed(altered.workspace.id));
    check("H07 an unseen terminal is skipped", !closed(unseen.workspace.id));
    helper.kill(); await helper.exited;
    write(join(dir, "event"), { boot_id: "test" });
    helper = startHelper("0");
    if (!await wait(() => read(join(dir, "chats.json")).pid === helper.pid)) throw Error("disabled helper did not start");
    const pick = (from: string, to: string) => write(join(dir, "pick.json"), { from, to, at: Date.now() });
    const from = live.panes[0].surfaces[1] as typeof local;
    const selected = join(dir, "selected");
    const click = calls().length;
    pick(from.id, disabled.terminal.id);
    await wait(() => existsSync(selected));
    const path = calls().slice(click);
    check("a fresh list switches directly from source to target", path.map(c => c.method).join() === "surface.move,surface.move,workspace.select" &&
      path[0].params.surface_id === from.id && path[1].params.surface_id === disabled.terminal.id && read(selected) === disabled.workspace.id);

    // Start between watchdog ticks with a cold cache. Four slow calls are each
    // within their own deadline, but together outlast the current round.
    await Bun.sleep(3000);
    for (const m of ["system.tree", "workspace.group.list", "surface.move", "workspace.create"]) writeFileSync(join(dir, "delay-" + m), "");
    pick(from.id, "new");
    if (!await wait(() => existsSync(join(dir, "delay-system.tree.used")))) throw Error("slow pick did not start");
    pick(from.id, destination.terminal.id);
    const switched = await wait(() => read(selected) === destination.workspace.id, 24000);
    await Bun.sleep(2500);
    check("watchdog lets the second pick finish and prevents a late selection", switched && read(selected) === destination.workspace.id &&
      !calls().some(c => c.method === "workspace.select" && c.params.workspace_id === "old-pick") && readFileSync(log, "utf8").includes("in pick, starting again"));

    writeFileSync(join(dir, "hold-pipe"), "");
    pick(from.id, from.id);
    if (!await wait(() => existsSync(join(dir, "hold-pipe.used")))) throw Error("pipe holder did not start");
    const held = Date.now();
    pick(ungrouped.terminal.id, ungrouped.terminal.id);
    check("an inherited pipe times out and the next ungrouped pick focuses its exact terminal",
      await wait(() => calls().some(c => c.method === "surface.move" && c.params.surface_id === ungrouped.terminal.id), 7500) &&
      Date.now() - held < 7500 && /surface.move timed out after \d+ ms/.test(readFileSync(log, "utf8")));
    shutPages([disabled]);
    if (!await wait(() => !read(join(dir, "chats.json")).projects[0].chats.some((c: any) => c.workspace === disabled.workspace.id))) throw Error("disabled helper did not see page close");
    await Bun.sleep(2000);
    check("H07 the environment switch keeps the terminal open", !closed(disabled.workspace.id));

    helper.kill(); await helper.exited;
    check("H08 sweeps and picks without project placeholders skip workspace.list", !calls().some(c => c.method === "workspace.list"));
    const claudeDir = join(dir, "claude"), codexDir = join(dir, "codex");
    mkdirSync(claudeDir); mkdirSync(codexDir);
    const stores = () => ({ sessions: {} as Record<string, object>, activeSessionsBySurface: {} as Record<string, object> });
    const store = { claude: stores(), codex: stores() };
    const fixture = (agent: "claude" | "codex", title: string, age: number | null) => {
      const { workspace, terminal } = chat(), id = uuid();
      const transcriptPath = join(agent === "claude" ? claudeDir : codexDir, id + ".jsonl");
      store[agent].activeSessionsBySurface[terminal.id] = { sessionId: id };
      store[agent].sessions[id] = { transcriptPath };
      return { id, transcriptPath, workspace: { ...workspace, title, latest_submitted_at: age === null ? null : new Date(Date.now() - age).toISOString() } };
    };
    const claude = fixture("claude", "Claude + chat", 120000), codex = fixture("codex", "Codex + chat", 120000);
    const fresh = fixture("claude", "Claude + chat", 10000), custom = fixture("claude", "My title", 120000);
    const empty = fixture("claude", "Claude + chat", null), outside = fixture("claude", "Claude + chat", 120000);
    const missing = fixture("claude", "Claude + chat", 120000), invalid = fixture("claude", "Claude + chat", 120000);
    const dots = fixture("codex", "Codex + chat", 120000), capped = fixture("codex", "Codex + chat", 120000);
    const ai = (aiTitle: string) => JSON.stringify({ type: "ai-title", aiTitle }) + "\n";
    writeFileSync(claude.transcriptPath, ai("Old name") + JSON.stringify({ text: "x".repeat(2 << 20) }) + "\n" + ai("Fix the queue"));
    for (const c of [fresh, custom, empty, outside]) writeFileSync(c.transcriptPath, ai("Should stay"));
    writeFileSync(missing.transcriptPath, ai("Outside the tail") + JSON.stringify({ text: "x".repeat(8 << 20) }) + "\n");
    writeFileSync(invalid.transcriptPath, ai("Old valid name") + ai("x".repeat(81)));
    for (const agent of ["claude", "codex"] as const) write(join(dir, agent + "-hook-sessions.json"), store[agent]);
    writeFileSync(join(codexDir, "session_index.jsonl"), [
      [codex.id, "Old name"], [codex.id, "One   two three four five six seven…"], [dots.id, "Six clean words end right here…"],
      [capped.id, "Investigate authentication failures affecting production..."],
    ].map(([id, thread_name]) => JSON.stringify({ id, thread_name })).join("\n"));
    const grouped = [claude, codex, fresh, custom, empty, missing, invalid, dots, capped].map(c => c.workspace);
    write(treeFile, [{ id: uuid(), workspaces: [...grouped, { ...outside.workspace, ungrouped: true }] }]);
    helper = startHelper("0");
    const renamed = (id: string) => calls().filter(c => c.method === "workspace.rename" && c.params.workspace_id === id);
    if (!await wait(() => readFileSync(log, "utf8").includes("named chat workspace " + capped.workspace.id))) throw Error("session title sweep did not finish");
    const sessionName = (c: typeof claude, title: string, agent: string) => renamed(c.workspace.id)[0]?.params.title === title &&
      readFileSync(log, "utf8").split("\n").filter(l => l.endsWith(`named chat workspace ${c.workspace.id} from its ${agent} session title`)).length === 1;
    check("H08 Claude uses the last aiTitle in a large transcript", sessionName(claude, "Fix the queue", "claude"));
    check("H09 Codex uses the last index row, collapses spaces and keeps six words", sessionName(codex, "One two three four five six", "codex"));
    check("H09 Codex strips the ellipsis and respects the 48 character word boundary",
      sessionName(dots, "Six clean words end right here", "codex") && sessionName(capped, "Investigate authentication failures affecting", "codex"));
    check("H10 recent and unsubmitted chats stay untouched", [fresh, empty].every(c => !renamed(c.workspace.id).length));
    check("H11 custom titles, ungrouped chats and invalid session titles stay untouched", [custom, outside, invalid].every(c => !renamed(c.workspace.id).length));
    // Leave only failed lookups eligible and make a title available before the next sweep.
    appendFileSync(missing.transcriptPath, ai("Arrived later"));
    const current = read(treeFile);
    for (const w of current[0].workspaces) if ([fresh.workspace.id, empty.workspace.id].includes(w.id)) w.title = "Named by cmux";
    write(treeFile, current);
    const since = calls().length;
    if (!await wait(() => calls().slice(since).filter(c => c.method === "workspace.group.list").length >= 2, 12000)) throw Error("two later sweeps did not finish");
    check("H12 one workspace.list for the batch and no retry on later sweeps within five minutes",
      calls().filter(c => c.method === "workspace.list").length === 1 && !renamed(missing.workspace.id).length);
  } catch (error) { check(String(error), false); }
  finally { helper.kill(); await helper.exited; }
  const failed = results.filter(r => !r.ok).length;
  write(join(dir, "result.json"), { passed: results.length - failed, failed, results });
  console.log(results.length - failed + " passed, " + failed + " failed");
  console.log(join(dir, "result.json"));
  process.exitCode = Number(failed !== 0);
}
if (process.env.FAKE_CMUX_DIR) await fake(process.env.FAKE_CMUX_DIR);
else await test();
