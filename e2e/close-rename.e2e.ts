// Ways the helper can fail (written before the code).
// H01 A leftover survives startup or a close event, closes before two reads 1.5 s apart, or is not logged.
// H02 A terminal moved across windows, another URL, a markdown surface, or a terminal is lost.
// H03 The workspace changes during the delay and is closed anyway.
// H05 A page whose terminal this helper never saw alive (after a restart of cmux the id can be new) is closed.
// H06 cmux does not answer for 15 s: the helper stops, so the strip of every page goes away.
// H04 Rename targets an unlisted workspace, loses user ownership, or changes quotes, shell text or newlines.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const write = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data));

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
  write(treeFile, [{ workspaces: [orphan, moved, live, mixed, markdown, rescued, eventSpace] }, { workspaces: [space(remote)] }]);
  const calls = () => existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const results: { name: string; ok: boolean }[] = [];
  const check = (name: string, ok: boolean) => { results.push({ name, ok }); console.log(ok ? "PASS" : "FAIL", name); };
  const wait = async (predicate: () => boolean, ms = 4000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(30)) if (predicate()) return true;
    return false;
  };
  const helper = Bun.spawn([process.execPath, join(import.meta.dir, "../lib/tabs.ts")], {
    env: { HOME: dir, PATH: "/usr/bin:/bin", ORCA_CHAT_STATE_DIR: dir, CMUX_BUNDLED_CLI_PATH: cli, FAKE_CMUX_DIR: dir, CMUX_SOCKET_PATH: join(dir, "unused.sock") },
    stdout: "ignore", stderr: Bun.file(log),
  });
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
    writeFileSync(join(dir, "slow"), "");
    await Bun.sleep(15_000);
    const alive = helper.exitCode === null;
    renameSync(join(dir, "slow"), join(dir, "slow.off"));
    const back = Date.now();
    check("H06 after 15 s without answers the helper still runs and reads cmux again", alive && await wait(() => helper.exitCode === null && calls().some(c => c.method === "system.tree" && c.at > back), 12_000));
    const lines = readFileSync(log, "utf8").split("\n");
    check("H01 one log line per close", lines.filter(l => l.includes(eventSpace.id)).length === 1 && !lines.some(l => l.includes(orphan.id)));
  } catch (error) { check(String(error), false); }
  finally { helper.kill(); await helper.exited; }
  const failed = results.filter(r => !r.ok).length;
  write(join(dir, "result.json"), { passed: results.length - failed, failed, results });
  console.log(join(dir, "result.json"));
  process.exitCode = Number(failed !== 0);
}
if (process.env.FAKE_CMUX_DIR) await fake(process.env.FAKE_CMUX_DIR);
else await test();
