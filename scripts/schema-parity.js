import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["dist/cli.js", "describe", "--format", "json"],
  { encoding: "utf8" },
);
assert.equal(result.status, 0, result.stderr);
const envelope = JSON.parse(result.stdout);
assert.equal(envelope.ok, true);
assert.ok(Array.isArray(envelope.data?.commands));
assert.ok(envelope.data.commands.length > 0);
for (const command of envelope.data.commands) {
  assert.equal(typeof command.command, "string");
  assert.equal(typeof command.raw_payload, "object");
}
