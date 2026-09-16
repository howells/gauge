import assert from "node:assert/strict";
import { test } from "node:test";

import { describeCommands } from "../src/schema.js";

test("describeCommands returns runtime command schemas", () => {
  const description = describeCommands();
  assert.equal(Array.isArray(description.commands), true);
  assert.ok(
    (description.commands as Array<{ command: string }>).some(
      (command) => command.command === "describe"
    )
  );
  assert.equal(description.runtime.headless_auth, true);
});
