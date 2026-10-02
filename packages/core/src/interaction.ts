import type { AgentSetup, ArenaPoint, ArenaSpec } from "./index.js";
import { arenaCellOrigin } from "./arenas.ts";

export type SkillType =
  | "AIM" | "MINE" | "PLACE" | "USE" | "EAT" | "EQUIP"
  | "CRAFT" | "OPEN" | "STORE" | "RETRIEVE" | "SMELT";
export type SkillStatus = "SUCCESS" | "FAILURE" | "INTERRUPTED" | "TIMEOUT";
export type SkillFailureReason =
  | "TARGET_LOST" | "TARGET_UNREACHABLE" | "MISSING_TOOL"
  | "MISSING_INGREDIENT" | "MISSING_WORKSTATION"
  | "CONTAINER_UNAVAILABLE" | "INTERACTION_FAILED" | "AGENT_DIED"
  | "TIMEOUT";
export interface SkillRequest {
  skill: SkillType;
  target: {
    block?: string;
    item?: string;
    position?: ArenaPoint;
    container?: ArenaPoint;
    recipe?: string;
  };
  parameters?: {
    quantity?: number;
    startYaw?: number;
    startPitch?: number;
  };
}
export interface SkillResult {
  status: SkillStatus;
  reason?: SkillFailureReason;
  state_delta: {
    inventory?: Record<string, number>;
    targetRemoved?: boolean;
    targetPlaced?: boolean;
  };
  duration_ms: number;
  metrics: {
    actions: number;
    aimErrorDegrees?: number;
    wrongBlockBreaks?: number;
    toolCorrect?: boolean;
  };
  missing?: { item: string; count: number }[];
}
export interface SkillAffordance {
  executable: boolean;
  reason?: SkillFailureReason;
  missing?: { item: string; count: number }[];
}
export const craftRequirements: Record<string, { ingredients: Record<string, number>; workstation?: string }> = {
  oak_planks: { ingredients: { oak_log: 1 } },
  stick: { ingredients: { oak_planks: 2 } },
  crafting_table: { ingredients: { oak_planks: 4 } },
  wooden_pickaxe: { ingredients: { oak_planks: 3, stick: 2 }, workstation: "crafting_table" },
  stone_pickaxe: { ingredients: { cobblestone: 3, stick: 2 }, workstation: "crafting_table" },
  furnace: { ingredients: { cobblestone: 8 }, workstation: "crafting_table" },
  iron_pickaxe: { ingredients: { iron_ingot: 3, stick: 2 }, workstation: "crafting_table" },
};

const pickaxeTier: Record<string, number> = {
  wooden_pickaxe: 1,
  golden_pickaxe: 1,
  stone_pickaxe: 2,
  iron_pickaxe: 3,
  diamond_pickaxe: 4,
  netherite_pickaxe: 4,
};
export function requiredPickaxeTier(block: string): number {
  if (["obsidian", "crying_obsidian"].includes(block)) return 4;
  if (["diamond_ore", "deepslate_diamond_ore", "gold_ore", "redstone_ore"].includes(block)) return 3;
  if (["iron_ore", "deepslate_iron_ore", "lapis_ore"].includes(block)) return 2;
  if (["stone", "cobblestone", "coal_ore", "deepslate_coal_ore"].includes(block)) return 1;
  return 0;
}
export function chooseMiningTool(block: string, inventory: Record<string, number>) {
  const required = requiredPickaxeTier(block);
  if (!required) return undefined;
  return Object.entries(pickaxeTier)
    .filter(([item, tier]) => tier >= required && (inventory[item] ?? 0) > 0)
    .sort((a, b) => a[1] - b[1])[0]?.[0];
}
export function skillAffordance(
  request: SkillRequest,
  state: { inventory: Record<string, number>; distance?: number; targetExists?: boolean; workstations?: string[]; containerAvailable?: boolean; containerInventory?: Record<string, number> },
): SkillAffordance {
  if (["AIM", "MINE", "PLACE", "USE"].includes(request.skill) && !request.target.position)
    return { executable: false, reason: "INTERACTION_FAILED" };
  if (["AIM", "MINE"].includes(request.skill) && !request.target.block)
    return { executable: false, reason: "INTERACTION_FAILED" };
  if (["PLACE", "USE", "EAT", "EQUIP", "STORE", "RETRIEVE", "SMELT"].includes(request.skill) && !request.target.item)
    return { executable: false, reason: "INTERACTION_FAILED" };
  if (state.targetExists === false) return { executable: false, reason: "TARGET_LOST" };
  if (state.distance !== undefined && state.distance > 4.4 && ["AIM", "MINE", "PLACE", "USE", "OPEN", "STORE", "RETRIEVE"].includes(request.skill))
    return { executable: false, reason: "TARGET_UNREACHABLE" };
  const block = request.target.block?.replace(/^minecraft:/, "");
  if (request.skill === "MINE" && block && requiredPickaxeTier(block) && !chooseMiningTool(block, state.inventory))
    return { executable: false, reason: "MISSING_TOOL" };
  const item = request.target.item?.replace(/^minecraft:/, "");
  const quantity = request.parameters?.quantity ?? 1;
  if (["PLACE", "USE", "EAT", "EQUIP", "STORE", "SMELT"].includes(request.skill) && item && (state.inventory[item] ?? 0) < quantity)
    return { executable: false, reason: "MISSING_INGREDIENT", missing: [{ item, count: quantity - (state.inventory[item] ?? 0) }] };
  if (["OPEN", "STORE", "RETRIEVE"].includes(request.skill) && !request.target.container)
    return { executable: false, reason: "CONTAINER_UNAVAILABLE" };
  if (["OPEN", "STORE", "RETRIEVE"].includes(request.skill) && state.containerAvailable === false)
    return { executable: false, reason: "CONTAINER_UNAVAILABLE" };
  if (request.skill === "RETRIEVE" && item && state.containerInventory && (state.containerInventory[item] ?? 0) < quantity)
    return { executable: false, reason: "MISSING_INGREDIENT", missing: [{ item, count: quantity - (state.containerInventory[item] ?? 0) }] };
  if (request.skill === "CRAFT") {
    const recipe = request.target.recipe?.replace(/^minecraft:/, "");
    const requirements = recipe && craftRequirements[recipe];
    if (!requirements) return { executable: false, reason: "INTERACTION_FAILED" };
    if (requirements.workstation && !state.workstations?.includes(requirements.workstation))
      return { executable: false, reason: "MISSING_WORKSTATION" };
    const missing = Object.entries(requirements.ingredients)
      .map(([ingredient, count]) => ({ item: ingredient, count: Math.max(0, count - (state.inventory[ingredient] ?? 0)) }))
      .filter((entry) => entry.count > 0);
    if (missing.length) return { executable: false, reason: "MISSING_INGREDIENT", missing };
  }
  if (request.skill === "SMELT") {
    if (!state.workstations?.includes("furnace")) return { executable: false, reason: "MISSING_WORKSTATION" };
    if ((state.inventory.coal ?? 0) < 1 && (state.inventory.charcoal ?? 0) < 1)
      return { executable: false, reason: "MISSING_INGREDIENT", missing: [{ item: "coal", count: 1 }] };
  }
  return { executable: true };
}

export const interactionSessions = [
  { id: "A0", name: "Look at target", detail: "Aim at a specified block directly ahead.", skill: "AIM", block: "stone", target: { x: 8, y: 0, z: 8 }, tools: [] },
  { id: "A1", name: "Random orientation", detail: "Correct random yaw and pitch before aiming.", skill: "AIM", block: "stone", target: { x: 8, y: 0, z: 8 }, tools: [] },
  { id: "A2", name: "Target among blocks", detail: "Aim at the specified block without selecting distractors.", skill: "AIM", block: "coal_ore", target: { x: 8, y: 0, z: 8 }, tools: [] },
  { id: "M0", name: "Mine directly ahead", detail: "Break a specified stone block with a pickaxe.", skill: "MINE", block: "stone", target: { x: 8, y: 0, z: 8 }, tools: ["wooden_pickaxe"] },
  { id: "M1", name: "Mine from random orientation", detail: "Reorient and mine the requested stone block.", skill: "MINE", block: "stone", target: { x: 8, y: 0, z: 8 }, tools: ["wooden_pickaxe"] },
  { id: "M2", name: "Varying target distance", detail: "Mine a block at a seeded reachable distance.", skill: "MINE", block: "stone", target: { x: 8, y: 0, z: 8 }, tools: ["wooden_pickaxe"] },
  { id: "M3", name: "Specified block", detail: "Mine coal ore while leaving nearby distractor blocks intact.", skill: "MINE", block: "coal_ore", target: { x: 8, y: 0, z: 8 }, tools: ["wooden_pickaxe"] },
  { id: "M4", name: "Tool selection", detail: "Select a suitable pickaxe for iron ore.", skill: "MINE", block: "iron_ore", target: { x: 8, y: 0, z: 8 }, tools: ["wooden_pickaxe", "stone_pickaxe"] },
  { id: "M5", name: "Small vein", detail: "Mine the specified ore within a small vein.", skill: "MINE", block: "iron_ore", target: { x: 8, y: 0, z: 8 }, tools: ["wooden_pickaxe", "stone_pickaxe"] },
] as const;
export type InteractionSession = (typeof interactionSessions)[number]["id"];
export function interactionSession(id: InteractionSession) {
  return interactionSessions.find((session) => session.id === id)!;
}
export function interactionArena(id: InteractionSession): ArenaSpec {
  const session = interactionSession(id);
  const regions: ArenaSpec["blueprint"]["regions"] = [{ from: session.target, to: session.target, block: `minecraft:${session.block}` }];
  if (["A2", "M2", "M3", "M5"].includes(id)) {
    for (const x of [6, 10]) regions.push({ from: { x, y: 0, z: 8 }, to: { x, y: 0, z: 8 }, block: "minecraft:stone" });
  }
  if (id === "M5") regions.push({ from: { x: 8, y: 0, z: 7 }, to: { x: 8, y: 0, z: 7 }, block: "minecraft:iron_ore" });
  return {
    blueprint: { width: 16, depth: 16, height: 5, floor: "minecraft:stone", walls: "minecraft:barrier", roof: "minecraft:barrier", spawn: { x: 8, y: 0, z: 11 }, regions, containers: [], entities: [] },
    origin: { x: 24000, y: -61, z: 24000 }, layout: "individual", columns: 4, gap: 8, resetEachEpisode: true,
  };
}
export function interactionSetup(id: InteractionSession): AgentSetup {
  const session = interactionSession(id);
  return {
    items: session.tools.map((item, slot) => ({ slot, item: `minecraft:${item}`, count: 1 })),
    clearInventory: true, resetVitals: true, health: 20, food: 20,
    experienceLevel: 0, heldSlot: 0, gamemode: "survival", applyEachEpisode: true,
  };
}
export function interactionRequest(id: InteractionSession, arena: ArenaSpec, index: number, episode: number, seed: number): SkillRequest {
  const session = interactionSession(id);
  const origin = arenaCellOrigin(arena, index);
  const angle = ((seed * 1103515245 + episode * 12345 + index * 7919) >>> 0) / 0xffffffff;
  const targetX = id === "M2" ? [6, 8, 10][Math.min(2, Math.floor(angle * 3))] : session.target.x;
  const position = {
    x: origin.x + 1 + targetX,
    y: origin.y + 1 + session.target.y,
    z: origin.z + 1 + session.target.z,
  };
  const randomOrientation = id === "A1" || id === "M1" || id === "M2";
  return {
    skill: session.skill,
    target: { block: session.block, position },
    parameters: randomOrientation
      ? { startYaw: angle * Math.PI * 2 - Math.PI, startPitch: (angle - 0.5) * 1.2 }
      : undefined,
  };
}
