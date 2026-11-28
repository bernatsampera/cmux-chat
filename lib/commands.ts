// Local slash commands (/clear, /effort, /model) run inside Claude Code with no model
// turn. The parser of cmux opened a turn for them, so the chat showed "Thinking"
// forever, and it dropped the newer system rows, so /effort did not show at all.
// lib/queue.ts calls this from its plugin: Bun uses only the first plugin for a file.
// An edit whose anchor is missing is skipped with a line in the server log.
export function patchCommands(input: string): string {
  let source = input;
  function patch(name: string, anchor: string, replacement: string) {
    const at = source.indexOf(anchor);
    if (at < 0 || at !== source.lastIndexOf(anchor)) {
      console.warn(`[orca-chat guard] transcript patch skipped: ${name}`);
      return;
    }
    source = source.replace(anchor, () => replacement);
  }
  const command = '[{ kind: "user", text: args ? `${command} ${args}` : command }]';
  // Skills start with command-message. Their assistant reply closes the turn.
  patch("user command", `return ${command};`,
    `const events: AgentEvent[] = ${command};
      return text.startsWith("<command-message>") ? events : this.endTurn(events);`);
  const output = 'stdout ? [{ kind: "status", text: truncate(stdout, 200) }] : []';
  // A visible status after done counts as fresh activity in the chat.
  patch("command output", `if (stdout !== undefined) return ${output};`, `if (stdout !== undefined) {
      if (stdout) this.turnOpen = true;
      return this.endTurn(${output});
    }`);
  const duration = 'case "turn_duration": {';
  patch("system command", duration, `case "local_command": {
        const text = typeof ev.content === "string" ? ev.content.trim() : "";
        if (text.startsWith("<local-command-stdout>")) return this.prompt(text);
        if (!tagValue(text, "command-name")) return [];
        return this.endTurn(this.prompt(text).filter(e => e.kind === "user"));
      }
      ${duration}`);
  return source;
}
