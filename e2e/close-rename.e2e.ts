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
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  switch (method) {
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
    case "workspace.group.list": return console.log(JSON.stringify({ groups: [{ id: "g", member_workspace_ids: spaces.map((w: any) => w.id) }] }));
    case "notification.list": return console.log('{"notifications":[]}');
    case "workspace.close":
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
  const normal = chat(), replaced = chat(), extra = chat(), gone = chat(), altered = chat(), unseen = chat(), disabled = chat();
  const manual = [normal, replaced, extra, gone, altered, unseen];
  extra.workspace.panes.push({ id: uuid(), surfaces: [term()] });
  unseen.workspace.panes[0].surfaces = [unseen.browser];
  const own = chat(), ownLeaving = term(), ownPage = page(ownLeaving.id);
  own.workspace.panes[0].surfaces.push(ownLeaving, ownPage);
  write(treeFile, [{ workspaces: [orphan, moved, live, mixed, markdown, rescued, eventSpace, own.workspace,
    disabled.workspace, ...manual.map(c => c.workspace)] }, { workspaces: [space(remote)] }]);
  const calls = () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const results: { name: string; ok: boolean }[] = [];
  const check = (name: string, ok: boolean) => { results.push({ name, ok }); console.log(ok ? "PASS" : "FAIL", name); };
  const wait = async (predicate: () => boolean, ms = 4000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(30)) if (predicate()) return true;
    return false;
  };
  const startHelper = (enabled: string) => Bun.spawn([process.execPath, join(import.meta.dir, "../lib/tabs.ts")], {
    env: { HOME: dir, PATH: "/usr/bin:/bin", ORCA_CHAT_STATE_DIR: dir, CMUX_BUNDLED_CLI_PATH: cli, FAKE_CMUX_DIR: dir, CMUX_SOCKET_PATH: join(dir, "unused.sock"), ORCA_CHAT_CLOSE_WITH_PAGE: enabled },
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
    check("H07 one logged close after two all-window reads 1.5 s apart", closes.length === 1 && reads.length >= 2 &&
      reads.at(-1).at - reads[0].at >= 1500 && lines.filter(l => l.endsWith("closed chat workspace " + normal.workspace.id + " after its page was closed")).length === 1);
    check("H07 the helper's own page close leaves the workspace open", !closed(own.workspace.id));
    check("H07 a replacement page in another window protects the terminal", !closed(replaced.workspace.id));
    check("H07 an extra pane before closure protects the workspace", !closed(extra.workspace.id));
    check("H07 a missing or changed workspace is skipped", !closed(gone.workspace.id) && !closed(altered.workspace.id));
    check("H07 an unseen terminal is skipped", !closed(unseen.workspace.id));
    helper.kill(); await helper.exited;
    helper = startHelper("0");
    if (!await wait(() => read(join(dir, "chats.json")).pid === helper.pid)) throw Error("disabled helper did not start");
    shutPages([disabled]);
    if (!await wait(() => !read(join(dir, "chats.json")).projects[0].chats.some((c: any) => c.workspace === disabled.workspace.id))) throw Error("disabled helper did not see page close");
    await Bun.sleep(2000);
    check("H07 the environment switch keeps the terminal open", !closed(disabled.workspace.id));
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
