import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AGENT_SETUP } from "@rlcraft/core";
import { SimulatorEnvironment } from "@rlcraft/agents";
import { agentSetupSchema } from "../apps/control/src/agent-setup.js";
test("starting inventories reject nonexistent items, duplicate slots, overflowing stacks and injected values", () => {
  for (const items of [
    [{ slot: 0, item: "minecraft:made_up", count: 1 }],
    [{ slot: 0, item: "minecraft:diamond_sword", count: 64 }],
    [
      { slot: 0, item: "minecraft:stone", count: 1 },
      { slot: 0, item: "minecraft:dirt", count: 1 },
    ],
    [{ slot: 41, item: "minecraft:stone", count: 1 }],
    [{ slot: 0, item: "stone\nstop", count: 1 }],
  ])
    assert.equal(
      agentSetupSchema.safeParse({ ...DEFAULT_AGENT_SETUP, items }).success,
      false,
    );
  assert.equal(
    agentSetupSchema.safeParse({
      ...DEFAULT_AGENT_SETUP,
      gamemode: "spectator",
    }).success,
    false,
  );
  assert.equal(
    agentSetupSchema.safeParse({ ...DEFAULT_AGENT_SETUP, health: 0 }).success,
    false,
  );
});
test("simulator setup supplies baseline inventory/vitals and position, then preserves or clears slots on reset", async () => {
  const environment = new SimulatorEnvironment();
  await environment.connect();
  await environment.reset({
    ...DEFAULT_AGENT_SETUP,
    items: [{ slot: 0, item: "minecraft:stone", count: 16 }],
    health: 12,
    food: 14,
    spawn: { x: 5, y: 64, z: 8 },
  });
  const initial = environment.observe(0);
  assert.deepEqual(initial.inventory, { stone: 16 });
  assert.equal(initial.health, 12);
  assert.equal(initial.food, 14);
  assert.deepEqual(initial.position, { x: 5, y: 64, z: 8 });
  await environment.reset({
    ...DEFAULT_AGENT_SETUP,
    clearInventory: false,
    resetVitals: false,
    items: [{ slot: 1, item: "minecraft:iron_axe", count: 1 }],
  });
  assert.deepEqual(environment.observe(1).inventory, {
    stone: 16,
    iron_axe: 1,
  });
  assert.equal(environment.observe(1).health, 12);
  await environment.reset({ ...DEFAULT_AGENT_SETUP, items: [] });
  assert.deepEqual(environment.observe(2).inventory, {});
  await environment.close();
});
