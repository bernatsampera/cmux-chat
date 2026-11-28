// A message that is sent while Claude works is not a user record: Claude Code
// writes a queue record at once, and an attachment when it reads the message in
// the middle of a turn. The parser of cmux skips both, so it is changed at load.
// Ways to fail: a background task looks like a message; a message shows twice
// (one that waits for the end of the turn gets a normal user record, so only the
// attachment is a bubble); a new pin has other code (then the server log says it).
// Bun uses only the first plugin for a file, so lib/live.ts is called from here.
import { plugin } from "bun";
import { addLive } from "./live";
import { patchCommands } from "./commands";

const AT = '      case "attachment":\n';
const ADD = `      case "queue-operation": {
        const queued = ev.operation === "enqueue" && typeof ev.content === "string" ? ev.content.trim() : "";
        if (!queued || /^<(task-notification|agent-message|system-reminder)\\b/.test(queued)) return [];
        return [{ kind: "status", text: "Queued: " + truncate(queued, 400) }];
      }
${AT}        if (ev.attachment?.type === "queued_command") {
          if (ev.attachment.commandMode !== "prompt" || ev.attachment.origin?.kind !== "human") return [];
          return this.prompt(typeof ev.attachment.prompt === "string" ? ev.attachment.prompt : textOf(ev.attachment.prompt));
        }
`;

plugin({
  name: "orca-chat queue",
  setup(build) {
    build.onLoad({ filter: /\/agent-chat\/adapters\/transcript\.ts$/ }, async ({ path }) => {
      const source = await Bun.file(path).text(), parts = source.split(AT);
      if (parts.length !== 2) console.log("[orca-chat] queued messages are off: the parser has changed");
      return { loader: "ts", contents: patchCommands(addLive(parts.length === 2 ? parts.join(ADD) : source)) };
    });
  },
});
