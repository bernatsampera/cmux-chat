// E2E of the placement step, against a fake Orca (fake CLI and fake runtime client).
// Ways it can fail, written before the code:
// P1 the chat stays a tab in the terminal's group (no split).
// P2 a second run opens a second chat tab or makes a second split.
// P3 a run in a second terminal tab opens one more chat or split: there is ONE per worktree.
// P4 it moves a tab that is not the chat (other site).
// P5 the new tab is listed late, so the move runs before it exists.
// P6 focus stays on the chat, so typing does not go to the terminal.
// P7 Orca has no such internal call: the chat must still open, with a clear message.
// P8 Orca accepts the move but does nothing: it must not report success.
// P9 a tab of the old form (/s/t-...) is not reused, or goto hits the active tab, not that page.
// P10 goto fails or does nothing: no chat at all, or nobody is told about the old tab.
// P11 it closes a tab, or sends text or keys, in any case above.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const OUT = join(process.argv[2] ?? tmpdir(), "place-" + new Date().toISOString().replace(/[:.]/g, "-"));
const APP = join(OUT, "Contents/Resources"), CLI = join(APP, "app.asar.unpacked/out/cli"), STATE = join(OUT, "state");
for (const d of [join(APP, "bin"), CLI, STATE]) mkdirSync(d, { recursive: true });
const DB = join(OUT, "db.json"), L = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const base = "http://127.0.0.1:1/tok";
const FOLLOW = base + "/follow?worktree=id%3Awt", OLD = { id: "B8", type: "browser", browserPageId: "page-old", url: base + "/s/t-session-one" };
const tab = (i: number) => ({ id: `T${i}::${L[i]}`, type: "terminal", parentTabId: `T${i}`, leafId: L[i] });
const all: any[] = []; // every call of every run, for P11
const reset = (mode = "", old = false) => { all.push(...(existsSync(DB) ? db().calls : [])); writeFileSync(DB, JSON.stringify({ mode, calls: [], hide: 0, groups: [...(old ? [{ id: "G2", tabOrder: ["B8"] }] : []), { id: "G1", tabOrder: ["T0", "T1", "B9"] }], tabs: [tab(0), tab(1), { id: "B9", type: "browser", browserPageId: "page-other", url: "https://example.com/follow?x" }, ...(old ? [OLD] : [])] })); };
const db = () => JSON.parse(readFileSync(DB, "utf8"));
const head = `const fs=require("fs"),DB=${JSON.stringify(DB)},rd=()=>JSON.parse(fs.readFileSync(DB)),wr=d=>fs.writeFileSync(DB,JSON.stringify(d));`;
writeFileSync(join(CLI, "runtime-client.js"), head + `exports.RuntimeClient=class{async call(m,p){const d=rd();
if(m==="session.tabs.list"){if(d.mode==="nocall")throw Error("method_not_found");const late=d.hide>0;if(late){d.hide--;wr(d)}return{result:{tabs:d.tabs.filter(t=>!(late&&t.fresh)),tabGroups:d.groups}}}
d.calls.push([m,p]);if(d.mode!=="noop"){d.groups.forEach(g=>g.tabOrder=g.tabOrder.filter(x=>x!==p.tabId));p.kind==="split"?d.groups.unshift({id:"G"+(d.groups.length+1),tabOrder:[p.tabId]}):d.groups.find(g=>g.id===p.targetGroupId).tabOrder.push(p.tabId)}wr(d);return{result:{moved:true}}}}`);
const ORCA = join(APP, "bin/orca");
writeFileSync(ORCA, `#!/usr/bin/env bun\n` + head + `const a=process.argv.slice(2),d=rd();d.calls.push(a);let r={};
if(a[1]==="list")r={truncated:false,terminals:${JSON.stringify(L.map((l, i) => ({ handle: "term_" + i, tabId: "T" + i, leafId: l, connected: true, writable: true })))}};
if(a[1]==="create"){const u=a.find(x=>x.startsWith("--url=")).slice(6),id="B"+d.tabs.length;d.tabs.push({id,type:"browser",fresh:true,browserPageId:"page-"+id,url:u});d.groups.find(g=>g.tabOrder.includes("T0")).tabOrder.push(id);d.hide=2;r={browserPageId:"page-"+id}}
if(a[0]==="goto"){if(d.mode==="nogoto"){wr(d);process.exit(1)}const t=d.tabs.find(t=>t.browserPageId===a.find(x=>x.startsWith("--page="))?.slice(7));if(t)t.url=a.find(x=>x.startsWith("--url=")).slice(6)}
wr(d);console.log(JSON.stringify({ok:true,result:r}))`);
chmodSync(ORCA, 0o755);
const place = (i: number) => { const p = Bun.spawnSync(["bun", join(import.meta.dir, "../lib/place.ts")], { stdin: Buffer.from(JSON.stringify({ url: FOLLOW, worktree: "id:wt", leaf: L[i], orca: ORCA })), env: { ...process.env, ORCA_CHAT_STATE_DIR: STATE } }); return { code: p.exitCode, out: String(p.stdout) + String(p.stderr) }; };
const res: any[] = []; const check = (id: string, ok: boolean, info?: unknown) => { res.push({ id, ok, info }); console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(info)); };
const moves = () => db().calls.filter((c: any) => c[0] === "session.tabs.move").map((c: any) => c[1]);
const creates = () => db().calls.filter((c: any) => c[1] === "create").length, last = () => db().calls.at(-1);
reset(); let r = place(0);
check("P1 P5 splits the new tab up, once", r.code === 0 && moves().length === 1 && moves()[0].kind === "split" && moves()[0].splitDirection === "up" && moves()[0].tabId === "B3" && moves()[0].targetGroupId === "G1", { r, m: moves() });
check("P4 other tabs did not move", JSON.stringify(db().groups.at(-1).tabOrder) === '["T0","T1","B9"]', db().groups);
check("P6 focus returns to the exact terminal", last().join(" ") === "terminal switch --terminal=term_0 --json", last());
r = place(0); check("P2 second run: no new tab, no new split", r.code === 0 && creates() === 1 && moves().length === 1, { r, m: moves() });
r = place(1); check("P3 a run in another terminal: same tab, no move, focus on that terminal", r.code === 0 && creates() === 1 && moves().length === 1 && last().join(" ") === "terminal switch --terminal=term_1 --json", { r, m: moves() });
reset("nocall"); r = place(0); check("P7 no internal call: tab opens, clear message", r.code === 0 && creates() === 1 && /could not place/.test(r.out), r);
reset("noop"); r = place(0); check("P8 no false success", /could not place/.test(r.out) && !/above/.test(r.out), r);
reset("", true); r = place(0);
check("P9 the old tab becomes the follow tab, with an explicit page", r.code === 0 && creates() === 0 && moves().length === 0 && db().calls.filter((c: any) => c[0] === "goto").length === 1 && db().calls.find((c: any) => c[0] === "goto").join(" ") === `goto --url=${FOLLOW} --page=page-old --worktree=id:wt --json` && db().tabs.find((t: any) => t.id === "B8").url === FOLLOW && db().tabs.find((t: any) => t.id === "B9").url.startsWith("https://example.com"), { r, db: db() });
r = place(0); check("P9 then a second run changes nothing", r.code === 0 && creates() === 0 && db().calls.filter((c: any) => c[0] === "goto").length === 1 && !/old form/.test(r.out), r);
reset("nogoto", true); r = place(0);
check("P10 goto fails: a new tab joins the old chat's group, the old tab is reported", r.code === 0 && creates() === 1 && moves().length === 1 && moves()[0].kind === "move-to-group" && moves()[0].targetGroupId === "G2" && /1 chat tab\(s\) of the old form/.test(r.out) && db().tabs.some((t: any) => t.id === "B8"), { r, m: moves() });
reset(); const verbs = [...new Set(all.map((c) => (typeof c[1] === "string" ? c.slice(0, 2).join(" ").split(" --")[0] : c[0])))];
check("P11 only these calls were made: no close, no send", verbs.length > 0 && verbs.every((v) => ["tab create", "terminal list", "terminal switch", "session.tabs.move", "goto"].includes(v)), verbs);
const failed = res.filter((x) => !x.ok).length;
writeFileSync(join(OUT, "result.json"), JSON.stringify({ when: new Date(), passed: res.length - failed, failed, results: res }, null, 1));
console.log(`${res.length - failed} passed, ${failed} failed\n${join(OUT, "result.json")}`); process.exit(failed ? 1 : 0);
