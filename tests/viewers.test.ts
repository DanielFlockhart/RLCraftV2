import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import { isViewerUsername } from "@mlcraft/core";
import { trainingEntities } from "@mlcraft/agents";
test("viewer names are case-insensitive and viewers are excluded from training targets", () => {
  assert.equal(isViewerUsername("ChilledVibe"), true);
  assert.equal(isViewerUsername("chilledvibe"), true);
  assert.equal(isViewerUsername("rl_abc_0"), false);
  assert.equal(isViewerUsername(undefined), false);
  const entities = {
    1: { username: "ChilledVibe" },
    2: { username: "rl_abc_0" },
    3: { name: "zombie" },
  } as unknown as Bot["entities"];
  assert.deepEqual(trainingEntities({ entities }), [entities[2], entities[3]]);
});
