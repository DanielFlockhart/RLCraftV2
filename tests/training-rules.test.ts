import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRAINING_RULES, type Run } from "@rlcraft/core";
import {
  trainingRulesSchema,
  validateRulesCompatibility,
  worldRulesKey,
} from "../apps/control/src/training-rules.js";
test("training rules validate types, cap expensive values and reject unsupported native rules", () => {
  assert.deepEqual(
    trainingRulesSchema.parse(DEFAULT_TRAINING_RULES),
    DEFAULT_TRAINING_RULES,
  );
  for (const rules of [
    { ...DEFAULT_TRAINING_RULES, keepInventory: "false" },
    { ...DEFAULT_TRAINING_RULES, difficulty: "impossible" },
    { ...DEFAULT_TRAINING_RULES, world: { randomTickSpeed: 101 } },
    { ...DEFAULT_TRAINING_RULES, world: { spawnRadius: -1 } },
    { ...DEFAULT_TRAINING_RULES, world: { spectatorsGenerateChunks: true } },
  ])
    assert.throws(() => trainingRulesSchema.parse(rules));
});
test("shared-world conflicts include queued and paused runs while agent-only settings can differ", () => {
  const spec = {
    stage: "movement" as const,
    mode: "minecraft" as const,
    component: "pipeline" as const,
    agents: 1,
    episodes: 1,
    ticksPerEpisode: 10,
    tickMs: 100,
    seed: 42,
    rules: DEFAULT_TRAINING_RULES,
  };
  const run = {
    id: "existing",
    spec,
    status: "paused",
    episode: 1,
    progress: 0,
    createdAt: "",
    updatedAt: "",
  } as Run;
  assert.doesNotThrow(() =>
    validateRulesCompatibility(
      {
        ...spec,
        rules: { ...spec.rules, keepInventory: false, noHungerLoss: true },
      },
      [run],
    ),
  );
  for (const status of ["queued", "running", "paused", "pausing"] as const)
    for (const rules of [
      { ...spec.rules, difficulty: "hard" as const },
      { ...spec.rules, creeperBlockDamage: false },
      { ...spec.rules, world: { doMobSpawning: false } },
    ])
      assert.throws(
        () =>
          validateRulesCompatibility({ ...spec, rules }, [{ ...run, status }]),
        /World rules conflict/,
      );
  assert.doesNotThrow(() =>
    validateRulesCompatibility(
      { ...spec, rules: { ...spec.rules, difficulty: "hard" } },
      [{ ...run, status: "completed" }],
    ),
  );
  assert.equal(
    worldRulesKey({
      ...spec.rules,
      world: { doDaylightCycle: false, randomTickSpeed: 0 },
    }),
    worldRulesKey({
      ...spec.rules,
      world: { randomTickSpeed: 0, doDaylightCycle: false },
    }),
  );
});
