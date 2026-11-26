// Commands run in a shell. Quote the root there, and let JSON handle its own escaping.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const shellRoot = /^[a-zA-Z0-9_./-]+$/.test(root) ? root : "'" + root.replaceAll("'", "'\\''") + "'";

export function config(name: string) {
  const template = readFileSync(resolve(root, "cmux", name), "utf8");
  return JSON.parse(template.replace(/__ROOT__|__HOME__/g, token =>
    JSON.stringify(token === "__ROOT__" ? shellRoot : homedir()).slice(1, -1)));
}

if (import.meta.main) console.log(JSON.stringify(config(process.argv[2]), null, 2));
