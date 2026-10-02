import test from "node:test";
import assert from "node:assert/strict";
import { arenaSpecSchema, validateArenaRun } from "../apps/control/src/arenas.js";
import {
  chooseMiningTool, interactionArena, interactionRequest,
  interactionSessions, interactionSetup, skillAffordance,
} from "../packages/core/src/interaction.js";
import type { RunSpec } from "@mlcraft/core";
import { MinecraftEnvironment } from "../packages/agents/src/backends/mineflayer.js";
import { trainingPlugins } from "../packages/agents/src/registry.js";
import { Vec3 } from "vec3";

test("Phase 3C targeting and mining sessions have valid isolated scenarios", () => {
  assert.equal(interactionSessions.length, 9);
  for (const session of interactionSessions) {
    const arena = arenaSpecSchema.parse(interactionArena(session.id));
    const setup = interactionSetup(session.id);
    const spec = { stage: "interaction", interaction: session.id, mode: "minecraft", component: "pipeline", agents: 64, episodes: 3, ticksPerEpisode: 1, tickMs: 100, seed: 42, arena, setup } as RunSpec;
    assert.doesNotThrow(() => validateArenaRun(spec));
    assert.equal(arena.layout, "individual");
    for (const index of [0, 1, 63]) {
      const request = interactionRequest(session.id, arena, index, 1, 42);
      assert.equal(request.skill, session.skill);
      assert.ok(request.target.position);
    }
  }
});

test("mining executor aims, equips the valid tool, digs and verifies the block changed", async () => {
  const target = new Vec3(8, -60, 8);
  let exists = true;
  let aimed = false;
  let equipped = "";
  const block = { name: "iron_ore", position: target };
  const items = [
    { name: "wooden_pickaxe", count: 1 },
    { name: "stone_pickaxe", count: 1 },
  ];
  const bot = {
    entity: { position: new Vec3(8.5, -60, 11.5) },
    inventory: { items: () => items },
    blockAt: () => exists ? block : { name: "air", position: target },
    blockAtCursor: () => aimed && exists ? block : null,
    lookAt: async () => { aimed = true; },
    equip: async (item: { name: string }) => { equipped = item.name; },
    canDigBlock: () => true,
    dig: async () => { exists = false; },
  };
  const environment = new MinecraftEnvironment("test", { host: "127.0.0.1", port: 25565, version: "1.18.1", auth: "offline" });
  (environment as unknown as { bot: typeof bot }).bot = bot;
  const result = await environment.executeSkill({ skill: "MINE", target: { block: "iron_ore", position: { x: 8, y: -60, z: 8 } } });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.state_delta.targetRemoved, true);
  assert.equal(result.metrics.toolCorrect, true);
  assert.equal(equipped, "stone_pickaxe");
  assert.equal(result.metrics.actions, 3);
});

test("Phase 3C affordances choose a valid tool and report missing requirements", () => {
  assert.equal(chooseMiningTool("iron_ore", { wooden_pickaxe: 1, stone_pickaxe: 1 }), "stone_pickaxe");
  assert.equal(chooseMiningTool("iron_ore", { wooden_pickaxe: 1 }), undefined);
  const mine = interactionRequest("M4", interactionArena("M4"), 0, 1, 42);
  assert.deepEqual(skillAffordance(mine, { inventory: { wooden_pickaxe: 1 } }), { executable: false, reason: "MISSING_TOOL" });
  assert.deepEqual(skillAffordance(mine, { inventory: { stone_pickaxe: 1 }, targetExists: false }), { executable: false, reason: "TARGET_LOST" });
  assert.deepEqual(skillAffordance(mine, { inventory: { stone_pickaxe: 1 }, distance: 8 }), { executable: false, reason: "TARGET_UNREACHABLE" });
  assert.equal(skillAffordance(mine, { inventory: { stone_pickaxe: 1 }, distance: 3 }).executable, true);
  assert.deepEqual(skillAffordance({ skill: "MINE", target: { block: "stone" } }, { inventory: { wooden_pickaxe: 1 } }), {
    executable: false, reason: "INTERACTION_FAILED",
  });
  assert.deepEqual(skillAffordance({ skill: "EAT", target: { item: "bread" }, parameters: { quantity: 2 } }, { inventory: { bread: 1 } }), {
    executable: false, reason: "MISSING_INGREDIENT", missing: [{ item: "bread", count: 1 }],
  });
  assert.deepEqual(skillAffordance({ skill: "CRAFT", target: { recipe: "iron_pickaxe" } }, {
    inventory: { iron_ingot: 1, stick: 2 }, workstations: ["crafting_table"],
  }), { executable: false, reason: "MISSING_INGREDIENT", missing: [{ item: "iron_ingot", count: 2 }] });
  assert.deepEqual(skillAffordance({ skill: "CRAFT", target: { recipe: "iron_pickaxe" } }, {
    inventory: { iron_ingot: 3, stick: 2 }, workstations: [],
  }), { executable: false, reason: "MISSING_WORKSTATION" });
  assert.deepEqual(skillAffordance({ skill: "RETRIEVE", target: { item: "iron_ingot", container: { x: 1, y: 2, z: 3 } }, parameters: { quantity: 3 } }, {
    inventory: {}, containerAvailable: true, containerInventory: { iron_ingot: 1 },
  }), { executable: false, reason: "MISSING_INGREDIENT", missing: [{ item: "iron_ingot", count: 2 }] });
});

test("interaction architecture reports the actual deterministic executor", async () => {
  const inspection = await trainingPlugins.interaction.createPolicy("test", {} as RunSpec).inspectModel!();
  assert.equal(inspection.status, "ready");
  assert.equal(inspection.implementation, "MineflayerInteractionExecutor");
  assert.equal(inspection.trainableParameters, 0);
  assert.ok(inspection.nodes.some((node) => node.id === "result"));
});
