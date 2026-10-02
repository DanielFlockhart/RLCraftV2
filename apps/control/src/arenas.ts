import { z } from "zod";
import minecraftData from "minecraft-data";
import { combatMobTypes } from "../../../packages/core/src/combat.js";
import {
  ARENA_BLOCK_BUDGET,
  arenaBlockCount,
  arenaBounds,
  arenasOverlap,
} from "../../../packages/core/src/arenas.js";
import type { RunSpec, Run } from "@mlcraft/core";
const data = minecraftData("1.18.1");
export const arenaBlockCatalog = Object.values(data.blocksByName).map(
  (block) => ({ id: `minecraft:${block.name}`, name: block.displayName }),
);
const block = z
  .string()
  .regex(/^minecraft:[a-z0-9_]+$/)
  .refine(
    (id) => !!data.blocksByName[id.slice(10)],
    "Unknown Minecraft 1.18.1 block",
  );
const point = z
  .object({
    x: z.number().int().min(0).max(31),
    y: z.number().int().min(0).max(15),
    z: z.number().int().min(0).max(31),
  })
  .strict();
const items = z
  .array(
    z
      .object({
        slot: z.number().int().min(0).max(26),
        item: z.string().regex(/^minecraft:[a-z0-9_]+$/),
        count: z.number().int().min(1).max(64),
      })
      .strict(),
  )
  .max(27)
  .superRefine((items, ctx) => {
    const used = new Set<number>();
    items.forEach((item, index) => {
      const definition = data.itemsByName[item.item.slice(10)];
      if (
        !definition ||
        definition.name === "air" ||
        item.count > definition.stackSize ||
        used.has(item.slot)
      )
        ctx.addIssue({
          code: "custom",
          path: [index],
          message:
            "Unknown item, invalid stack size or duplicate container slot",
        });
      used.add(item.slot);
    });
  });
export const arenaBlueprintSchema = z
  .object({
    width: z.number().int().min(3).max(32),
    depth: z.number().int().min(3).max(32),
    height: z.number().int().min(3).max(16),
    floor: block.refine(
      (id) => data.blocksByName[id.slice(10)]?.boundingBox === "block",
      "Floor must have collision",
    ),
    walls: block,
    roof: block,
    spawn: point,
    regions: z
      .array(z.object({ from: point, to: point, block }).strict())
      .max(32),
    containers: z
      .array(
        z
          .object({
            position: point,
            block: z.enum(["minecraft:chest", "minecraft:barrel"]),
            items,
          })
          .strict(),
      )
      .max(8),
    entities: z
      .array(
        z
          .object({
            position: point,
            type: z.enum(combatMobTypes as [string, ...string[]]),
            count: z.number().int().min(1).max(8),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .superRefine((arena, ctx) => {
    const inside = (p: { x: number; y: number; z: number }) =>
      p.x < arena.width && p.y < arena.height && p.z < arena.depth;
    if (!inside(arena.spawn) || arena.spawn.y + 1 >= arena.height)
      ctx.addIssue({
        code: "custom",
        path: ["spawn"],
        message: "Spawn needs two clear blocks inside the arena",
      });
    arena.regions.forEach((region, i) => {
      if (
        !inside(region.from) ||
        !inside(region.to) ||
        (["x", "y", "z"] as const).some(
          (axis) => region.from[axis] > region.to[axis],
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["regions", i],
          message: "Region must fit inside the arena with From <= To",
        });
    });
    const finalBlock = (p: typeof arena.spawn) => {
      let value = "minecraft:air";
      for (const region of arena.regions)
        if (
          (["x", "y", "z"] as const).every(
            (axis) =>
              p[axis] >= region.from[axis] && p[axis] <= region.to[axis],
          )
        )
          value = region.block;
      for (const container of arena.containers)
        if (
          (["x", "y", "z"] as const).every(
            (axis) => p[axis] === container.position[axis],
          )
        )
          value = container.block;
      return value;
    };
    if (
      [arena.spawn, { ...arena.spawn, y: arena.spawn.y + 1 }].some(
        (p) => finalBlock(p) !== "minecraft:air",
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["spawn"],
        message: "Spawn feet/head must be air after contents are placed",
      });
    if (
      arena.spawn.y > 0 &&
      data.blocksByName[
        finalBlock({ ...arena.spawn, y: arena.spawn.y - 1 }).slice(10)
      ]?.boundingBox !== "block"
    )
      ctx.addIssue({
        code: "custom",
        path: ["spawn"],
        message: "Elevated spawn needs a supporting block",
      });
    const used = new Set<string>();
    arena.containers.forEach((container, i) => {
      const key = JSON.stringify(container.position);
      if (!inside(container.position) || used.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["containers", i],
          message: "Container must fit inside and have a unique position",
        });
      used.add(key);
    });
    arena.entities.forEach((entity, i) => {
      if (
        !inside(entity.position) ||
        entity.position.y + 1 >= arena.height ||
        finalBlock(entity.position) !== "minecraft:air" ||
        finalBlock({ ...entity.position, y: entity.position.y + 1 }) !==
          "minecraft:air"
      )
        ctx.addIssue({
          code: "custom",
          path: ["entities", i],
          message: "Mob spawn needs two clear blocks inside",
        });
    });
    if (arena.entities.reduce((sum, entity) => sum + entity.count, 0) > 16)
      ctx.addIssue({
        code: "custom",
        path: ["entities"],
        message: "At most 16 mobs per cell",
      });
  });
export const arenaPresetSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    blueprint: arenaBlueprintSchema,
  })
  .strict();
export const arenaSpecSchema = z
  .object({
    blueprint: arenaBlueprintSchema,
    origin: z
      .object({
        x: z.number().int().min(-29999984).max(29999984),
        y: z.number().int().min(-64).max(318),
        z: z.number().int().min(-29999984).max(29999984),
      })
      .strict(),
    layout: z.enum(["individual", "shared"]),
    columns: z.number().int().min(1).max(16),
    gap: z.number().int().min(2).max(32),
    resetEachEpisode: z.boolean(),
  })
  .strict();
export function validateArenaRun(spec: RunSpec) {
  if (!spec.arena) return;
  if (spec.mode !== "minecraft")
    throw new Error("Training arenas require Minecraft mode");
  if (spec.setup?.spawn)
    throw new Error(
      "Remove the starting setup's custom spawn: arena layouts control agent spawn positions",
    );
  const arena = spec.arena,
    cells = arena.layout === "shared" ? 1 : spec.agents;
  const bounds = arenaBounds(arena, spec.agents);
  if (
    bounds.max.y > 319 ||
    Math.abs(bounds.max.x) > 29999984 ||
    Math.abs(bounds.max.z) > 29999984
  )
    throw new Error("Arena layout exceeds Minecraft world bounds");
  if (arenaBlockCount(arena, spec.agents) > ARENA_BLOCK_BUDGET)
    throw new Error(
      `Arena layout exceeds ${ARENA_BLOCK_BUDGET.toLocaleString()} blocks; reduce size or agent count`,
    );
  if (
    arena.blueprint.entities.reduce((sum, entity) => sum + entity.count, 0) *
      cells >
    128
  )
    throw new Error("Arena layout exceeds 128 mobs across all cells");
}
export function arenaConflict(spec: RunSpec, runs: Run[]) {
  const live = runs.filter(
    (run) =>
      run.spec.mode === "minecraft" &&
      ["queued", "running", "paused", "pausing"].includes(run.status),
  );
  if (live.some((run) => !!run.spec.arena !== !!spec.arena))
    throw new Error(
      "Finish/cancel existing Minecraft runs before mixing arena and free-roam experiments",
    );
  if (
    spec.arena &&
    live.some(
      (run) =>
        run.spec.arena &&
        arenasOverlap(
          spec.arena!,
          spec.agents,
          run.spec.arena,
          run.spec.agents,
        ),
    )
  )
    throw new Error(
      "Arena overlaps an active/queued experiment; choose another origin or finish/cancel that run",
    );
}
