// Feeds each case through the hook the way Claude Code does (JSON on stdin)
// and asserts allow/deny. Cases live in a file so this script's own command
// line doesn't contain the trigger strings.
//
// The hook is resolved relative to this file, not by absolute path. It used to
// be hardcoded to C:/VibeCoding/.claude/hooks/, and when the personal repo was
// moved down a level that path stopped existing - spawnSync then failed with
// no stdout, `denied` came out false for every case, and the suite printed a
// clean sheet of "allowed" while testing nothing at all. Hence also the exit
// code below: a suite that only prints cannot tell you it has stopped working.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const HOOK = new URL("./block-remote-d1-writes.mjs", import.meta.url);
const cases = JSON.parse(readFileSync(new URL("./block-remote-d1-writes.cases.json", import.meta.url), "utf8"));

let failures = 0;
for (const [command, label] of cases) {
  const r = spawnSync(process.execPath, [HOOK.pathname.replace(/^\//, "")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
  if (r.error) {
    console.log(`  ERROR    ${label}: ${r.error.message}`);
    failures++;
    continue;
  }
  const denied = (r.stdout || "").includes('"deny"');
  const shouldAllow = /must stay allowed/.test(label);
  const ok = shouldAllow ? !denied : denied;
  if (!ok) failures++;
  console.log(`  ${ok ? " " : "!"} ${denied ? "DENIED " : "allowed"}  ${label}`);
}

console.log(`\n  ${cases.length} cases, ${failures} unexpected`);
if (failures) process.exit(1);
