import { z } from "zod";
import {
  DEFAULT_TRAINING_RULES,
  type Run,
  type RunSpec,
  type TrainingRules,
} from "@rlcraft/core";
export const trainingRulesSchema = z
  .object({
    keepInventory: z.boolean(),
    noHungerLoss: z.boolean(),
    creeperBlockDamage: z.boolean(),
    creeperEntityDamage: z.boolean(),
    pvp: z.boolean(),
    fallDamage: z.boolean(),
    drowningDamage: z.boolean(),
    fireDamage: z.boolean(),
    difficulty: z.enum(["world", "peaceful", "easy", "normal", "hard"]),
    world: z
      .object({
        doDaylightCycle: z.boolean().optional(),
        doWeatherCycle: z.boolean().optional(),
        doMobSpawning: z.boolean().optional(),
        mobGriefing: z.boolean().optional(),
        doFireTick: z.boolean().optional(),
        naturalRegeneration: z.boolean().optional(),
        doMobLoot: z.boolean().optional(),
        doTileDrops: z.boolean().optional(),
        doEntityDrops: z.boolean().optional(),
        doInsomnia: z.boolean().optional(),
        doPatrolSpawning: z.boolean().optional(),
        doTraderSpawning: z.boolean().optional(),
        randomTickSpeed: z.number().int().min(0).max(100).optional(),
        spawnRadius: z.number().int().min(0).max(128).optional(),
      })
      .strict(),
  })
  .strict();
export function worldRulesKey(rules: TrainingRules = DEFAULT_TRAINING_RULES) {
  return JSON.stringify({
    difficulty: rules.difficulty,
    creeperBlockDamage: rules.creeperBlockDamage,
    world: Object.fromEntries(
      Object.entries(rules.world)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
}
export function validateRulesCompatibility(spec: RunSpec, runs: Run[]) {
  if (spec.mode !== "minecraft") return;
  if (
    runs.some(
      (run) =>
        run.spec.mode === "minecraft" &&
        ["queued", "running", "paused", "pausing"].includes(run.status) &&
        worldRulesKey(run.spec.rules) !== worldRulesKey(spec.rules),
    )
  )
    throw new Error(
      "World rules conflict with an active/queued Minecraft experiment. Use matching world settings or finish/cancel that experiment first.",
    );
}
