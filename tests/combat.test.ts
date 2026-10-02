import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CombatFullRun,
  Observation,
  PolicyObservation,
  RunSpec,
} from "@mlcraft/core";
import {
  combatArena,
  combatReward,
  combatSessions,
  combatSetup,
  combatMobTypes,
  combatMobTemperament,
  combatFullRunTargetEpisodes,
} from "../packages/core/src/combat.js";
import {
  arenaSpecSchema,
  validateArenaRun,
} from "../apps/control/src/arenas.js";
import {
  arenaBlockCount,
  ARENA_BLOCK_BUDGET,
} from "../packages/core/src/arenas.js";
import {
  CombatNeat,
  CombatPolicy,
  combatFeatures,
} from "../packages/agents/src/combat-neat.js";
import { inspectModels } from "../packages/agents/src/inspection.js";
import { Store } from "../apps/control/src/store.js";

test("every combat session has a valid 64-agent arena and real loadout", () => {
  const plugin = readFileSync(
    join(
      process.cwd(),
      "plugins/viewer-guard/src/dev/rlcraft/viewer/TrainingArenas.java",
    ),
    "utf8",
  );
  for (const mob of combatMobTypes)
    assert.ok(
      plugin.includes(`"${mob}"`),
      `${mob} must be spawnable by the plugin`,
    );
  for (const mob of combatMobTypes)
    assert.ok(combatMobTemperament[mob], `${mob} needs a temperament input`);
  const weapons = new Set(combatSessions.map((session) => session.weapon));
  for (const material of [
    "wooden",
    "golden",
    "stone",
    "iron",
    "diamond",
    "netherite",
  ])
    for (const kind of ["sword", "axe"])
      assert.ok(
        weapons.has(
          `${material}_${kind}` as NonNullable<
            (typeof combatSessions)[number]["weapon"]
          >,
        ),
      );
  for (const weapon of ["bow", "crossbow", "trident"])
    assert.ok(
      weapons.has(
        weapon as NonNullable<(typeof combatSessions)[number]["weapon"]>,
      ),
    );
  for (const session of combatSessions) {
    const arena = arenaSpecSchema.parse(combatArena(session.id, 42));
    const setup = combatSetup(session.id);
    assert.equal(arena.layout, "individual");
    assert.ok(arena.blueprint.entities.length >= 1);
    assert.ok(arenaBlockCount(arena, 64) <= ARENA_BLOCK_BUDGET);
    assert.ok(
      arena.blueprint.entities.reduce(
        (count, entity) => count + entity.count,
        0,
      ) *
        64 <=
        128,
    );
    validateArenaRun({
      stage: "pvp",
      combat: session.id,
      mode: "minecraft",
      component: "pipeline",
      agents: 64,
      episodes: 3,
      ticksPerEpisode: 10,
      tickMs: 100,
      seed: 42,
      arena,
      setup,
    });
    assert.equal(
      new Set(setup.items.map((item) => item.slot)).size,
      setup.items.length,
    );
    assert.equal(setup.applyEachEpisode, true);
  }
});

test("combat scenarios vary deterministically without changing arena bounds", () => {
  const first = combatArena("C0", 42);
  const repeated = combatArena("C0", 42);
  const other = combatArena("C0", 43);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.blueprint.entities[0].position, other.blueprint.entities[0].position);
  assert.deepEqual(first.origin, other.origin);
  arenaSpecSchema.parse(first);
  arenaSpecSchema.parse(other);
});

test("third combat scenario is held out of fitness", () => {
  const spec: RunSpec = { stage: "pvp", combat: "C0", mode: "minecraft", component: "pipeline", agents: 8, episodes: 3, ticksPerEpisode: 10, tickMs: 100, seed: 7 };
  const neat = new CombatNeat(spec);
  for (let episode = 0; episode < 3; episode++) {
    for (let index = 0; index < 8; index++) {
      neat.assign(index);
      neat.observe(index, episode === 2 ? 1000 : 2 + episode);
    }
    neat.endEpisode();
  }
  assert.equal(neat.report().heldoutPopulationMeanReward, 1000);
  assert.equal(neat.checkpoint().speciesHistory[0].bestFitness, 2.5);
});

test("verified wins outrank higher shaping reward and survive checkpoint resume", () => {
  const root = mkdtempSync(join(tmpdir(), "combat-win-priority-"));
  try {
    const sourceId = "00000000-0000-4000-8000-000000000121";
    const spec: RunSpec = { stage: "pvp", combat: "C3", mode: "minecraft", component: "pipeline", agents: 8, episodes: 6, ticksPerEpisode: 10, tickMs: 100, seed: 42 };
    const neat = new CombatNeat(spec, root);
    for (let episode = 0; episode < 3; episode++) {
      for (let index = 0; index < 8; index++) {
        neat.assign(index);
        neat.observe(index, index === 0 ? -100 : 100, index === 0);
      }
      neat.endEpisode();
    }
    const checkpoint = neat.checkpoint();
    assert.equal(checkpoint.champion.wins, 2);
    assert.equal(checkpoint.champion.fitness, -100);
    assert.equal(checkpoint.generationBestWins, 2);
    mkdirSync(join(root, sourceId));
    writeFileSync(join(root, sourceId, "checkpoint.json"), JSON.stringify({ ...checkpoint, seed: 42 }));
    const restored = new CombatNeat({ ...spec, combatResume: sourceId }, root).checkpoint();
    assert.equal(restored.champion.wins, 2);
    assert.equal(restored.population.length, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retrying a combat Full Run keeps the original episode target", () => {
  assert.equal(combatFullRunTargetEpisodes(64, 252, 252), 316);
  assert.equal(combatFullRunTargetEpisodes(64, 285, 252), 316);
  assert.equal(combatFullRunTargetEpisodes(129, 285, 252), 381);
  assert.throws(() => combatFullRunTargetEpisodes(64, 316, 252));
});

test("large combat populations retain distinct model inspections", async () => {
  const spec: RunSpec = { stage: "pvp", combat: "C0", mode: "minecraft", component: "pipeline", agents: 64, episodes: 3, ticksPerEpisode: 10, tickMs: 100, seed: 7 };
  const population = new CombatNeat(spec);
  const policies = Array.from({ length: 64 }, (_, index) => ({ username: `agent_${index}`, policy: new CombatPolicy(population, index) }));
  await Promise.all(policies.map(({ policy }) => policy.reset(7)));
  const variants = await inspectModels("pvp", policies);
  assert.ok(Buffer.byteLength(JSON.stringify(variants)) > 1_000_000);
  assert.equal(variants.reduce((count, variant) => count + variant.agents.length, 0), 64);
  assert.ok(variants.every((variant) => variant.inspection.status === "ready"));
});

test("combat NEAT receives mob identity, temperament, status, secondary threat, projectiles and weapon", () => {
  const spec: RunSpec = {
    stage: "pvp",
    combat: "C18",
    mode: "minecraft",
    component: "pipeline",
    agents: 8,
    episodes: 3,
    ticksPerEpisode: 10,
    tickMs: 100,
    seed: 42,
  };
  const names = new CombatNeat(spec).checkpoint().inputs as string[];
  const observation = {
    tick: 0,
    inputs: { channels: {} },
    combat: {
      health: 18,
      food: 20,
      targets: 2,
      targetDx: 4,
      targetDy: 0,
      targetDz: -3,
      targetHealth: 20,
      attackReady: 1,
      sword: 1,
      axe: 0,
      armor: 1,
      shield: 1,
      targetType: "creeper",
      secondType: "wolf",
      secondDx: -2,
      secondDy: 0,
      secondDz: 5,
      creeperFuse: 1,
      weapon: "diamond_sword",
      projectileCount: 1,
      projectileDx: 3,
      projectileDy: 1,
      projectileDz: 0,
    },
  } as PolicyObservation;
  const values = combatFeatures(observation);
  assert.equal(values.length, names.length);
  const feature = (name: string) => values[names.indexOf(name)];
  assert.equal(feature("opponent_creeper"), 1);
  assert.equal(feature("opponent_hostile"), 1);
  assert.equal(feature("second_opponent_wolf"), 1);
  assert.equal(feature("second_opponent_neutral"), 1);
  assert.equal(feature("creeper_fuse"), 1);
  assert.equal(feature("weapon_diamond"), 1);
  assert.equal(feature("projectile_count"), 0.25);
  assert.equal(feature("opponent_zombie"), 0);
});

test("combat rewards accepted kills and damage while penalizing damage taken", () => {
  const before: Observation = {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: {},
    tick: 0,
    combat: {
      attackReady: 1,
      targets: [
        { id: 1, type: "zombie", position: { x: 2, y: 64, z: 0 }, health: 10 },
      ],
    },
  };
  const hit: Observation = {
    ...before,
    tick: 1,
    combat: {
      attackReady: 0,
      targets: [
        { id: 1, type: "zombie", position: { x: 2, y: 64, z: 0 }, health: 7 },
      ],
    },
  };
  const killed: Observation = {
    ...hit,
    tick: 2,
    combat: { attackReady: 0, targets: [] },
  };
  assert.ok(combatReward(before, hit, { attack: true }) > 0);
  const confirmedHit: Observation = {
    ...before,
    tick: 1,
    combat: {
      attackReady: 0,
      confirmedHits: 1,
      targets: [{ id: 1, type: "zombie", position: { x: 2, y: 64, z: 0 } }],
    },
  };
  assert.ok(
    combatReward(
      { ...before, combat: { ...before.combat!, confirmedHits: 0 } },
      confirmedHit,
      { attack: true },
    ) > 1,
  );
  assert.ok(combatReward(hit, killed, { attack: true }) < 1, "a missing client entity cannot earn kill credit");
  assert.ok(combatReward(hit, killed, { attack: true }, 1) > 19);
  assert.ok(combatReward(before, { ...hit, health: 15 }, {}) < 0);
});

test("combat NEAT checkpoint restores and transfers the full population", () => {
  const root = mkdtempSync(join(tmpdir(), "combat-neat-"));
  try {
    const sourceId = "00000000-0000-4000-8000-000000000111";
    const spec: RunSpec = {
      stage: "pvp",
      combat: "C0",
      mode: "minecraft",
      component: "pipeline",
      agents: 8,
      episodes: 3,
      ticksPerEpisode: 10,
      tickMs: 100,
      seed: 42,
    };
    const neat = new CombatNeat(spec, root);
    for (let episode = 1; episode <= 3; episode++) {
      for (let i = 0; i < 8; i++) {
        neat.assign(i);
        neat.observe(i, i + episode);
      }
      neat.endEpisode();
    }
    const original = neat.checkpoint();
    mkdirSync(join(root, sourceId));
    writeFileSync(
      join(root, sourceId, "checkpoint.json"),
      JSON.stringify({ ...original, seed: 42 }),
    );
    const resumed = new CombatNeat(
      { ...spec, combatResume: sourceId, episodes: 5 },
      root,
    ).checkpoint();
    assert.equal(resumed.episode, original.episode);
    assert.deepEqual(resumed.population, original.population);
    const transfer = new CombatNeat(
      {
        ...spec,
        combat: "C1",
        combatResume: sourceId,
        combatTransfer: true,
        episodes: 6,
      },
      root,
    ).checkpoint();
    assert.equal(transfer.session, "C1");
    assert.equal(transfer.population.length, original.population.length);
    assert.deepEqual(
      transfer.population.map((genome) => genome.connections),
      original.population.map((genome) => genome.connections),
    );
    assert.equal(transfer.trialEvaluations, 0);
    assert.ok(transfer.population.every((genome) => genome.fitness === 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("older combat checkpoints gain the new sensor and item-use nodes", () => {
  const root = mkdtempSync(join(tmpdir(), "combat-upgrade-"));
  try {
    const id = "00000000-0000-4000-8000-000000000119";
    const spec: RunSpec = {
      stage: "pvp",
      combat: "C0",
      mode: "minecraft",
      component: "pipeline",
      agents: 8,
      episodes: 3,
      ticksPerEpisode: 10,
      tickMs: 100,
      seed: 42,
    };
    const current = new CombatNeat(spec, root).checkpoint();
    const newInputCount = current.inputs.length;
    const newOutputCount = current.outputs.length;
    const oldInputCount = 39;
    const oldOutputCount = 11;
    const mapId = (node: number): number | undefined =>
      node < oldInputCount
        ? node
        : node === newInputCount
          ? oldInputCount
          : node > newInputCount && node <= newInputCount + oldOutputCount
            ? oldInputCount + node - newInputCount
            : undefined;
    const graph = (genome: (typeof current.population)[number]) => ({
      ...genome,
      nodes: genome.nodes.flatMap((node) => {
        const id = mapId(node.id);
        return id === undefined ? [] : [{ ...node, id }];
      }),
      connections: genome.connections.flatMap((connection) => {
        const from = mapId(connection.from),
          to = mapId(connection.to);
        return from === undefined || to === undefined
          ? []
          : [{ ...connection, from, to }];
      }),
    });
    const old = {
      ...current,
      seed: 42,
      inputs: current.inputs.slice(0, oldInputCount),
      outputs: current.outputs.slice(0, oldOutputCount),
      population: current.population.map(graph),
      resumeState: {
        ...current.resumeState,
        nextNode: oldInputCount + oldOutputCount + 1,
        innovations: current.resumeState.innovations.flatMap(
          ([key, innovation]) => {
            const [from, to] = key.split(":").map(Number).map(mapId);
            return from === undefined || to === undefined
              ? []
              : [[`${from}:${to}`, innovation]];
          },
        ),
      },
    };
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "checkpoint.json"), JSON.stringify(old));
    const upgraded = new CombatNeat(
      { ...spec, combatResume: id },
      root,
    ).checkpoint();
    assert.equal(upgraded.inputs.length, newInputCount);
    assert.equal(upgraded.outputs.length, newOutputCount);
    assert.equal(upgraded.population.length, old.population.length);
    assert.ok(
      upgraded.population.every((genome) =>
        genome.nodes.some((node) => node.id === newInputCount + newOutputCount),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint migration preserves networks when a mob one-hot input is inserted mid-vector", () => {
  const root = mkdtempSync(join(tmpdir(), "combat-inserted-input-"));
  try {
    const id = "00000000-0000-4000-8000-000000000120";
    const spec: RunSpec = { stage: "pvp", combat: "C0", mode: "minecraft", component: "pipeline",
      agents: 8, episodes: 3, ticksPerEpisode: 10, tickMs: 100, seed: 42 };
    const current = new CombatNeat(spec, root).checkpoint();
    const missing = current.inputs.indexOf("opponent_wolf");
    assert.ok(missing > 39);
    const oldId = (node: number) => node > missing ? node - 1 : node;
    const oldGraph = (genome: typeof current.population[number]) => ({ ...genome,
      nodes: genome.nodes.filter((node) => node.id !== missing)
        .map((node) => ({ ...node, id: oldId(node.id) })),
      connections: genome.connections
        .filter((edge) => edge.from !== missing && edge.to !== missing)
        .map((edge) => ({ ...edge, from: oldId(edge.from), to: oldId(edge.to) })),
    });
    const old = { ...current, seed: 42,
      inputs: current.inputs.filter((_, index) => index !== missing),
      population: current.population.map(oldGraph),
      resumeState: { ...current.resumeState, nextNode: current.resumeState.nextNode - 1,
        innovations: current.resumeState.innovations.flatMap(([key, innovation]) => {
          const [from, to] = key.split(":").map(Number);
          return from === missing || to === missing ? [] : [[`${oldId(from)}:${oldId(to)}`, innovation]];
        }),
      },
    };
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "checkpoint.json"), JSON.stringify(old));
    const upgraded = new CombatNeat({ ...spec, combatResume: id }, root).checkpoint();
    assert.deepEqual(upgraded.inputs, current.inputs);
    assert.equal(upgraded.population.length, current.population.length);
    assert.ok(upgraded.population.every((genome) =>
      genome.nodes.some((node) => node.id === missing)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("combat Full Run persists stage and checkpoint lineage", () => {
  const root = mkdtempSync(join(tmpdir(), "combat-full-run-"));
  try {
    const plan: CombatFullRun = {
      id: "00000000-0000-4000-8000-000000000112",
      status: "running",
      stageIndex: 2,
      stages: combatSessions.map((session) => ({
        session: session.id,
        agents: 8,
        episodes: 3,
        ticksPerEpisode: 10,
        tickMs: 100,
        seed: 42,
        minWinRate: 0.5,
        maxAttempts: 2,
        runIds: [],
      })),
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const path = join(root, "control.sqlite");
    const store = new Store(path);
    store.saveCombatFullRun(plan);
    store.close();
    const reopened = new Store(path);
    assert.deepEqual(reopened.combatFullRun(plan.id), plan);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
