// Opens the follow tab of the worktree, or reuses it, puts it above the
// terminal, then focuses the terminal. It never closes a tab. The split uses
// session.tabs.move, an internal Orca call. When it is missing or does nothing,
// the chat stays a normal tab.
import { matchLeaf, orca, refuse, run, runtimeClient } from "./common";

run(async () => {
  const { url, worktree, leaf, orca: bin } = JSON.parse(await Bun.stdin.text());
  process.env.ORCA_CHAT_ORCA = bin;
  const base = url.split("/follow?")[0];
  const client = runtimeClient();
  let page = "";
  const look = async () => {
    const s = (await client.call("session.tabs.list", { worktree })).result;
    const group = (id?: string) => s.tabGroups.find((g: any) => g.tabOrder.includes(id))?.id;
    const term = group(s.tabs.find((t: any) => t.type === "terminal" && t.leafId.toLowerCase() === leaf)?.parentTabId);
    const urls = (...paths: string[]) => s.tabs.filter((t: any) => t.type === "browser" && paths.some((p) => String(t.url).startsWith(base + p)));
    const chat = urls("/follow?")[0] ?? s.tabs.find((t: any) => page && t.browserPageId === page);
    const old = urls("/s/t-", "/terminal/").sort((a: any, b: any) => Number(group(a.id) === term) - Number(group(b.id) === term));
    return { term, chat, old, chatGroup: group(chat?.id), above: old.map((t: any) => group(t.id)).find((g: any) => g && g !== term) };
  };
  let now: any = client && (await look().catch(() => null));
  // A tab of the old form becomes the follow tab, so the user's split stays.
  const reuse = !now?.chat && now?.old.find((t: any) => t.browserPageId);
  if (reuse) {
    await orca(["goto", `--url=${url}`, `--page=${reuse.browserPageId}`, `--worktree=${worktree}`, "--json"], 10_000);
    for (let i = 0; i < 10 && !now?.chat; i++, await Bun.sleep(200)) now = await look().catch(() => null);
  }
  if (!now?.chat) {
    const res = await orca(["tab", "create", `--url=${url}`, `--worktree=${worktree}`, "--json"], 15_000);
    if (res.code !== 0) refuse(`orca did not open the tab, open ${url}`);
    try { page = JSON.parse(res.stdout).result.browserPageId ?? ""; } catch {}
  }
  let moved = false;
  for (let i = 0; client && i < 20; i++, await Bun.sleep(200)) {
    now = await look().catch(() => null);
    if (!now) break;
    if (!now.term || !now.chatGroup) continue;
    if (now.chatGroup !== now.term) break;
    if (moved) continue;
    const where = now.above ? { kind: "move-to-group", targetGroupId: now.above } : { kind: "split", splitDirection: "up", targetGroupId: now.term };
    moved = !!(await client.call("session.tabs.move", { worktree, tabId: now.chat.id, ...where }).catch(() => null));
    if (!moved) break;
  }
  if (now?.old?.length) console.log(`${now.old.length} chat tab(s) of the old form are still open, close them by hand`);
  if (!(now?.term && now.chatGroup && now.chatGroup !== now.term)) return console.log("chat opened as a tab: could not place it over the terminal");
  const { handle } = await matchLeaf(leaf);
  await orca(["terminal", "switch", `--terminal=${handle}`, "--json"]);
  console.log("chat opened above this terminal, it follows the active terminal tab");
});
