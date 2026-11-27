# cmux-chat

Read a Claude Code or Codex conversation above its terminal in cmux. Project tabs let you switch chats, and the sidebar patches group chats by project and show their age.

## Install

Use an Apple silicon Mac with cmux 0.65.x, Git, curl, and Claude Code or Codex on your PATH. The installer downloads a pinned copy of Bun and the cmux chat server. Project setup uses jq and the installed cmux-sidebar sidebar. The file and worktree pickers use fzf, and the Markdown picker also uses fd.

```sh
git clone https://github.com/bernatsampera/cmux-chat.git && cd cmux-chat && ./install
```

The installer writes both settings files to `~/.config/cmux-chat/`. If you already have a cmux config, merge the rendered cmux.json into it, or run `./install --write-cmux-config` to save a dated backup and use the new file. The Claude settings are available for use with Claude's `--settings` option.

Edit `~/.config/cmux-chat/projects.txt`. Put one name and folder on each line, separated by a pipe. Lines starting with `#` are comments. For a different file, set `CMUX_CHAT_PROJECTS`.

```text
Work | ~/code/work
Work/api | ~/code/work/api
```

Run `./cmux/setup` inside a cmux terminal. To start the tabs helper from zsh, add the line printed by the installer to your zsh configuration.

## Update

Run `git pull && ./install` from the clone. Merge any updated cmux settings and run `./cmux/setup` again.

## Uninstall

Stop the chat server with `"${ORCA_CHAT_DATA_DIR:-$HOME/.local/share/orca-chat}/bun-1.3.14/package/bin/bun" lib/chat.ts stop` and quit cmux. Remove the zsh start line if you added it. Restore your cmux config from backup or remove the entries you added. Restore the sidebar from its pre-patch backup or reinstall cmux-sidebar.

Remove the clone and `~/.config/cmux-chat/`. To remove the installed server and saved mappings, remove `~/.local/share/orca-chat/` (or your `ORCA_CHAT_DATA_DIR`) and `~/.local/state/orca-chat/`. The state folder contains the saved chat mappings.

## Components in the chat

Write a fenced `json` block with a top-level `ui` array. The chat draws the parts in order. Other viewers show the JSON. Incomplete JSON and blocks with no known parts stay visible as code.

```json
{"ui": [
  {"card": "Agent sent an option the backend rejects", "status": "fail", "sub": "The owner got the table sorted by count, not by weekday"},
  {"story": [["Owner", "For this year, how many check-ins for each weekday and hour?"], ["Agent", "attendance.query → rejected → retry without `order` → answered"]]},
  {"compare": {"left": "sent", "right": "should send", "a": {"by": ["weekday","hour"], "order": "fixed"}, "b": {"by": ["weekday","hour"]}}},
  {"note": "The `order` text never says that **fixed** works for one dimension only.", "label": "Why"},
  {"steps": {"title": "Try in Agent Lab", "link": {"text": "Open in Agent Lab", "href": "https://example.test/lab?x=1"}, "items": [
    "Click **Run** once as it is, for a baseline. The error comes and goes.",
    {"text": "Domain actions › attendance.query › Edit parameter wording › `order`: paste, then **Save**", "copy": "count: largest first. fixed: ... for one dimension only."},
    {"text": "Run both questions", "checks": [["no `order`", "For this year, how many check-ins for each weekday and hour?"], ["still `order: \"fixed\"`", "Check-ins by time of day over the last 12 months, morning first."]]}
  ]}}
]}
```

Card status can be `fail`, `ok`, `warn`, or `info` (the default). Comparison headings default to “before” and “after”. Use backticks for inline code and double asterisks for bold. Links accept HTTP and HTTPS addresses. Hover over the block or focus its copy button to copy the original JSON.

## Tests and license

Run `./e2e/install.e2e.sh` to repeat the install checks with a fresh temporary home. It downloads dependencies and uses a fake cmux command. Other tests under `e2e/` cover chat, tabs, and sidebar behavior. Some create real cmux workspaces on screen.

Licensed under [GPL-3.0](LICENSE).
