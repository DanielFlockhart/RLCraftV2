import type {
  ArenaPoint,
  ArenaSpec,
  MotorSession,
  Observation,
} from "./index.js";
import { arenaCellOrigin, arenaSpawn } from "./arenas.ts";
export { motorSessions } from "./motor-sessions.ts";

export const MOTOR_TRIALS_PER_EVOLUTION = 3;
export const MOTOR_TARGET_RADIUS = 1.5;
export function motorTrialPlan(episode: number, agents: number) {
  const population = Math.max(8, agents);
  const batches = Math.ceil(population / agents);
  const episodesPerEvolution = batches * MOTOR_TRIALS_PER_EVOLUTION;
  const offset = (episode - 1) % episodesPerEvolution;
  return {
    population,
    batches,
    episodesPerEvolution,
    evolution: Math.floor((episode - 1) / episodesPerEvolution),
    scenario: Math.floor(offset / batches),
    batch: offset % batches,
  };
}

function random(seed: number) {
  let state = seed >>> 0;
  return () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
}

export function motorArena(session: MotorSession, seed: number): ArenaSpec {
  const rng = random(seed);
  const regions: ArenaSpec["blueprint"]["regions"] = [];
  const add = (
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    block: string,
  ) =>
    regions.push({
      from: { x: x1, y: y1, z: z1 },
      to: { x: x2, y: y2, z: z2 },
      block: `minecraft:${block}`,
    });
  if (session === "M3") add(13, 0, 8, 13, 0, 22, "stone");
  if (session === "M4" || session === "M8") {
    for (let i = 0; i < 12; i++) {
      const x = 7 + Math.floor(rng() * 19),
        z = 3 + Math.floor(rng() * 26);
      if (Math.abs(z - 15) < 2 && x < 9) continue;
      add(x, 0, z, x, rng() < 0.25 ? 1 : 0, z, i % 3 ? "stone" : "oak_planks");
    }
  }
  if (session === "M5" || session === "M7" || session === "M8") {
    for (let x = 8; x <= 25; x += 4) {
      const z = 8 + Math.floor(rng() * 12);
      add(x, 0, z, x + 2, 0, z + 5, x % 2 ? "dirt" : "stone");
    }
  }
  if (session === "M6" || session === "M7") {
    add(12, 0, 9, 17, 0, 21, "water");
    add(19, 0, 11, 21, 0, 14, "stone");
  }
  return {
    blueprint: {
      width: 32,
      depth: 32,
      height: 5,
      floor: "minecraft:grass_block",
      walls: "minecraft:barrier",
      roof: "minecraft:air",
      spawn: session === "M1" ? { x: 15, y: 0, z: 15 } : { x: 3, y: 0, z: 15 },
      regions,
      containers: [],
      entities: [],
    },
    origin: { x: 12000, y: -61, z: 12000 },
    layout: "individual",
    columns: 4,
    gap: 16,
    // Motor policies only move/look; teleporting agents resets the trial without
    // rebuilding every cell for each generation.
    resetEachEpisode: false,
  };
}

export function motorTarget(
  arena: ArenaSpec,
  session: MotorSession,
  index: number,
  episode: number,
  seed: number,
  agents = 1,
): ArenaPoint {
  const spawn = arenaSpawn(arena, index);
  const trial = motorTrialPlan(episode, agents);
  if (session === "M1") {
    const rng = random(seed + trial.scenario * 31);
    const angle = rng() * Math.PI * 2;
    return {
      x: spawn.x + Math.cos(angle) * 10,
      y: spawn.y,
      z: spawn.z + Math.sin(angle) * 10,
    };
  }
  const distanceVariation = [-2, 0, 2][
    (trial.scenario + Math.floor(random(seed)() * 3)) % 3
  ];
  const desiredX =
    spawn.x +
    (session === "M0" ? 12 : session === "M3" ? 19 : 24) +
    distanceVariation;
  const origin = arenaCellOrigin(arena, index);
  const localZ = Math.floor(spawn.z - origin.z - 1);
  const clear = (x: number) => {
    const localX = Math.floor(x - origin.x - 1);
    return localX >= 1 && localX < arena.blueprint.width - 1 &&
      !arena.blueprint.regions.some((region) =>
        region.block !== "minecraft:air" &&
        region.block !== "minecraft:water" &&
        region.from.x <= localX && region.to.x >= localX &&
        region.from.z <= localZ && region.to.z >= localZ &&
        region.from.y <= 1 && region.to.y >= 0,
      );
  };
  for (let offset = 0; offset < arena.blueprint.width; offset++) {
    for (const x of offset ? [desiredX - offset, desiredX + offset] : [desiredX])
      if (clear(x)) return { x, y: spawn.y, z: spawn.z };
  }
  throw new Error("Motor arena has no clear target near the requested distance");
}

export function motorNaturalTarget(
  position: ArenaPoint,
  seed: number,
  worldSeed: string,
  episode: number,
  index: number,
  minDistance: number,
  maxDistance: number,
): ArenaPoint {
  let state = (seed ^ episode ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  for (const character of worldSeed)
    state = (Math.imul(state, 31) + character.charCodeAt(0)) >>> 0;
  const next = random(state);
  const angle = next() * Math.PI * 2;
  const distance = minDistance + next() * (maxDistance - minDistance);
  return {
    x: position.x + Math.cos(angle) * distance,
    y: position.y,
    z: position.z + Math.sin(angle) * distance,
  };
}

export function motorReachedTarget(
  observation: Observation,
  target: ArenaPoint,
  horizontal = false,
) {
  return (
    Math.hypot(
      target.x - observation.position.x,
      horizontal ? 0 : target.y - observation.position.y,
      target.z - observation.position.z,
    ) <= MOTOR_TARGET_RADIUS
  );
}

export function motorDelta(observation: Observation, target: ArenaPoint) {
  return {
    targetDx: target.x - observation.position.x,
    targetDy: target.y - observation.position.y,
    targetDz: target.z - observation.position.z,
  };
}

export function motorReward(
  before: Observation,
  after: Observation,
  target: ArenaPoint,
  alreadyReached = false,
  horizontal = false,
) {
  const distance = (observation: Observation) =>
    Math.hypot(
      target.x - observation.position.x,
      horizontal ? 0 : target.y - observation.position.y,
      target.z - observation.position.z,
    );
  const previous = distance(before),
    current = distance(after);
  return (
    (previous - current) * 2 -
    0.01 +
    (!alreadyReached &&
    after.health > 0 &&
    previous > MOTOR_TARGET_RADIUS &&
    current <= MOTOR_TARGET_RADIUS
      ? 8
      : 0) -
    (after.health <= 0 ? 5 : 0)
  );
}
