import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSpec, PolicyObservation } from "@mlcraft/core";
import {
  motorArena,
  motorReachedTarget,
  motorReward,
  motorSessions,
  motorTarget,
  motorTrialPlan,
} from "../packages/core/src/motor.js";
import {
  ARENA_BLOCK_BUDGET,
  arenaBlockCount,
  arenaSpawn,
} from "../packages/core/src/arenas.js";
import {
  arenaSpecSchema,
  validateArenaRun,
} from "../apps/control/src/arenas.js";
import {
  MotorNeat,
  MotorPolicy,
  MotorTrainer,
  loadMotorSkill,
  motorFeatures,
} from "../packages/agents/src/motor-neat.js";
import { inspectModels } from "../packages/agents/src/inspection.js";
import { motorInputConfig } from "../apps/control/src/motor-inputs.js";

test("every motor session has a valid separate arena and target", () => {
  for (const session of motorSessions) {
    const arena = arenaSpecSchema.parse(motorArena(session.id, 42));
    assert.equal(arena.layout, "individual");
    assert.equal(arena.blueprint.walls, "minecraft:barrier");
    const first = arenaSpawn(arena, 0),
      second = arenaSpawn(arena, 1);
    assert.ok(
      Math.abs(first.x - second.x) >= arena.blueprint.width + arena.gap,
    );
    const target = motorTarget(arena, session.id, 0, 1, 42);
    assert.ok(
      target.x > arena.origin.x &&
        target.x < arena.origin.x + arena.blueprint.width + 2,
    );
  }
});

test("motor input sampling is limited to policy channels and 48 geometry rays", () => {
  const config = motorInputConfig();
  assert.deepEqual(
    Object.entries(config.channels)
      .filter(([, channel]) => channel.enabled)
      .map(([id]) => id),
    ["self.pose", "self.physics", "vision.geometry"],
  );
  assert.equal(config.limits.visionWidth * config.limits.visionHeight, 48);
  assert.equal(config.channels["self.pose"].intervalMs, 0);
  assert.equal(config.channels["self.physics"].intervalMs, 0);
});

test("motor policy exposes target-relative movement, terrain and physics features", () => {
  const observation: PolicyObservation = {
    tick: 0,
    motor: { targetDx: 4, targetDy: 1, targetDz: -12 },
    inputs: {
      schemaVersion: 1, at: 0, tick: 0, sequence: 0,
      channels: {
        "self.pose": { status: "ready", sampledAt: 0, source: "test", data: {
          velocity: { x: 0.25, y: 0, z: -0.5 }, yaw: 0, pitch: 0, onGround: true,
        } },
        "self.physics": { status: "ready", sampledAt: 0, source: "test", data: {
          isInWater: true, isCollidedHorizontally: true,
          isCollidedVertically: false, jumpTicks: 10,
        } },
        "vision.geometry": { status: "ready", sampledAt: 0, source: "test", data: {
          width: 8, height: 6, distance: 16,
          depth: Array(48).fill(8), valid: Array(48).fill(true),
        } },
      },
      diagnostics: { droppedEvents: 0, droppedBytes: 0, eventBytes: 0 },
    },
  };
  const checkpoint = new MotorNeat({
    stage: "motor", motor: "M0", mode: "minecraft", component: "pipeline",
    agents: 8, episodes: 3, ticksPerEpisode: 1, tickMs: 100, seed: 42,
  }).checkpoint();
  const values = Object.fromEntries(
    checkpoint.inputs.map((name: string, index: number) => [name, motorFeatures(observation)[index]]),
  );
  assert.equal(checkpoint.inputs.length, motorFeatures(observation).length);
  assert.equal(values.target_forward, 0.5);
  assert.equal(values.target_right, 4 / 24);
  assert.equal(values.velocity_forward, 0.5);
  assert.equal(values.velocity_right, 0.25);
  assert.equal(values.depth_low_ahead, 0.5);
  assert.equal(values.depth_valid_ahead, 1);
  assert.equal(values.in_water, 1);
  assert.equal(values.collided_horizontally, 1);
  assert.equal(values.jump_ticks, 0.5);
  assert.ok(checkpoint.outputs.includes("sneak"));
});

test("the motor arena budget admits 64 isolated agents and rejects a 65th", () => {
  const arena = motorArena("M0", 42);
  assert.equal(arena.resetEachEpisode, false);
  assert.equal(arenaBlockCount(arena, 64), 517_888);
  assert.ok(arenaBlockCount(arena, 64) <= ARENA_BLOCK_BUDGET);
  const spec: RunSpec = {
    stage: "motor",
    motor: "M0",
    mode: "minecraft",
    component: "pipeline",
    agents: 64,
    episodes: 1,
    ticksPerEpisode: 1,
    tickMs: 100,
    seed: 42,
    arena,
  };
  assert.doesNotThrow(() => validateArenaRun(spec));
  assert.throws(() => validateArenaRun({ ...spec, agents: 65 }), /524,288/);
});

test("motor reward follows actual target progress", () => {
  const before = {
    position: { x: 0, y: 0, z: 0 },
    health: 20,
    food: 20,
    inventory: {},
    tick: 0,
  };
  const closer = { ...before, position: { x: 1, y: 0, z: 0 }, tick: 1 };
  const farther = { ...before, position: { x: -1, y: 0, z: 0 }, tick: 1 };
  assert.ok(motorReward(before, closer, { x: 10, y: 0, z: 0 }) > 0);
  assert.ok(motorReward(before, farther, { x: 10, y: 0, z: 0 }) < 0);
  assert.equal(motorReachedTarget(closer, { x: 1, y: 0, z: 0 }), true);
  assert.equal(
    motorReward(before, closer, { x: 2, y: 0, z: 0 }) -
      motorReward(before, closer, { x: 2, y: 0, z: 0 }, true),
    8,
  );
});

test("every genome receives the same three seeded directions before evolution", () => {
  const arena = motorArena("M1", 42);
  const first = motorTarget(arena, "M1", 0, 1, 42, 3);
  const second = motorTarget(arena, "M1", 1, 1, 42, 3);
  const nextBatch = motorTarget(arena, "M1", 0, 2, 42, 3);
  const nextScenario = motorTarget(arena, "M1", 0, 4, 42, 3);
  const delta = (index: number, target: { x: number; z: number }) => {
    const spawn = arenaSpawn(arena, index);
    return { x: target.x - spawn.x, z: target.z - spawn.z };
  };
  assert.deepEqual(delta(0, first), delta(1, second));
  assert.deepEqual(delta(0, first), delta(0, nextBatch));
  assert.notDeepEqual(delta(0, first), delta(0, nextScenario));
  assert.deepEqual(
    delta(0, first),
    delta(0, motorTarget(arena, "M1", 0, 10, 42, 3)),
  );
  assert.deepEqual(motorTrialPlan(9, 3), {
    population: 8,
    batches: 3,
    episodesPerEvolution: 9,
    evolution: 0,
    scenario: 2,
    batch: 2,
  });
  assert.equal(motorTrialPlan(10, 3).evolution, 1);
});

test("straight and obstacle sessions share three repeatable trial distances", () => {
  for (const session of [
    "M0",
    "M2",
    "M3",
    "M4",
    "M5",
    "M6",
    "M7",
    "M8",
  ] as const) {
    const arena = motorArena(session, 42);
    const offset = (index: number, episode: number) =>
      motorTarget(arena, session, index, episode, 42, 3).x -
      arenaSpawn(arena, index).x;
    const distances = [1, 4, 7].map((episode) => offset(0, episode));
    assert.equal(new Set(distances).size, 3, session);
    assert.equal(offset(0, 1), offset(1, 1), session);
    assert.equal(offset(0, 1), offset(0, 2), session);
    assert.equal(offset(0, 1), offset(0, 10), session);
  }
});

test("NEAT evaluates a population and evolves after all candidates receive rewards", async () => {
  const spec: RunSpec = {
    stage: "motor",
    motor: "M0",
    mode: "minecraft",
    component: "pipeline",
    agents: 1,
    episodes: 24,
    ticksPerEpisode: 1,
    tickMs: 100,
    seed: 42,
  };
  const population = new MotorNeat(spec),
    policy = new MotorPolicy(population, 0),
    trainer = new MotorTrainer(population);
  const observation: PolicyObservation = {
    tick: 0,
    motor: { targetDx: 10, targetDy: 0, targetDz: 0 },
    inputs: {
      schemaVersion: 1,
      at: 0,
      tick: 0,
      sequence: 0,
      channels: {
        "self.pose": {
          status: "ready",
          sampledAt: 0,
          source: "test",
          data: {
            velocity: { x: 0, y: 0, z: 0 },
            yaw: 0,
            pitch: 0,
            onGround: true,
          },
        },
      },
      diagnostics: { droppedEvents: 0, droppedBytes: 0, eventBytes: 0 },
    },
  };
  for (let episode = 1; episode <= 24; episode++) {
    await policy.reset(episode);
    const action = await policy.act(observation);
    assert.equal(typeof action.controls?.forward, "boolean");
    assert.equal(typeof action.look?.yaw, "number");
    await trainer.observe("test:0", {
      observation,
      action,
      reward: episode,
      nextObservation: observation,
      done: true,
    });
    await trainer.endEpisode(episode);
  }
  const checkpoint = await trainer.checkpoint();
  assert.equal(checkpoint.kind, "neat-rl");
  assert.equal(checkpoint.generation, 1);
  assert.equal(checkpoint.bestFitness, 16);
  assert.equal(checkpoint.speciesHistory.length, 1);
  assert.equal(checkpoint.speciesHistory[0].generation, 1);
  await policy.reset(25);
  assert.equal(population.inspect("policy", 0).status, "ready");
});

test("speciation allocates offspring by shared fitness and keeps evolving with eight species", () => {
  const spec: RunSpec = {
    stage: "motor",
    motor: "M0",
    mode: "minecraft",
    component: "pipeline",
    agents: 8,
    episodes: 6,
    ticksPerEpisode: 1,
    tickMs: 100,
    seed: 42,
  };
  const population = new MotorNeat(spec);
  const initial = population.checkpoint().population;
  for (let index = 0; index < initial.length; index++)
    initial[index].connections = [
      { ...initial[index].connections[0], innovation: 1000 + index },
    ];
  for (let episode = 1; episode <= 3; episode++) {
    for (let index = 0; index < 8; index++) {
      population.assign(index);
      population.observe(index, index + 1);
    }
    population.endEpisode();
  }
  const checkpoint = population.checkpoint();
  assert.equal(checkpoint.generation, 1);
  assert.equal(checkpoint.population.length, 8);
  assert.equal(checkpoint.speciesHistory[0].species.length, 8);
  const offspring = checkpoint.speciesHistory[0].species;
  assert.ok(offspring[0].offspring > offspring.at(-1)!.offspring);
  assert.ok(
    checkpoint.population.some(
      (genome) =>
        JSON.stringify(genome.connections) !==
        JSON.stringify(checkpoint.champion.connections),
    ),
  );
  for (let episode = 4; episode <= 6; episode++) {
    for (let index = 0; index < 8; index++) {
      population.assign(index);
      population.observe(index, index + 1);
    }
    population.endEpisode();
  }
  const nextHistory = population.checkpoint().speciesHistory;
  assert.equal(nextHistory.length, 2);
  assert.deepEqual(
    population.checkpoint().population[0].connections,
    population.checkpoint().champion.connections,
  );
  assert.ok(
    nextHistory[1].species.some((species) =>
      nextHistory[0].species.some((previous) => previous.id === species.id),
    ),
  );
});

test("transferred motor populations retain multiple species and fresh explorers", () => {
  const root = mkdtempSync(join(tmpdir(), "motor-diversity-"));
  const sourceId = "00000000-0000-4000-8000-000000000032";
  const base: RunSpec = {
    stage: "motor", motor: "M2", mode: "minecraft", component: "pipeline",
    agents: 32, episodes: 36, ticksPerEpisode: 1, tickMs: 100, seed: 42,
  };
  try {
    mkdirSync(join(root, sourceId));
    writeFileSync(join(root, sourceId, "checkpoint.json"),
      JSON.stringify(new MotorNeat(base).checkpoint()));
    const population = new MotorNeat({
      ...base, motor: "M3", motorSource: sourceId,
    }, root);
    const initial = population.checkpoint();
    assert.equal(initial.resumeState.evolutionVersion, 2);
    assert.equal(initial.resumeState.compatibilityThreshold, 0.12);
    assert.ok(new Set(initial.population.map((genome) =>
      genome.connections.map((edge) => edge.innovation).join(","))).size >= 8);
    const observation: PolicyObservation = {
      tick: 0, motor: { targetDx: 12, targetDy: 0, targetDz: 0 },
      inputs: {
        schemaVersion: 1, at: 0, tick: 0, sequence: 0,
        channels: { "self.pose": { status: "ready", sampledAt: 0, source: "test", data: {
          velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true,
        } } },
        diagnostics: { droppedEvents: 0, droppedBytes: 0, eventBytes: 0 },
      },
    };
    let jumpingExplorers = 0;
    for (let index = 24; index < 32; index++) {
      population.assign(index);
      if (population.act(index, observation).controls?.jump) jumpingExplorers++;
    }
    assert.ok(jumpingExplorers > 0);
    for (let episode = 1; episode <= 36; episode++) {
      for (let index = 0; index < 32; index++) {
        population.assign(index);
        population.observe(index, 1 + (index % 8));
      }
      population.endEpisode();
    }
    const checkpoint = population.checkpoint();
    assert.equal(checkpoint.generation, 12);
    assert.ok(checkpoint.speciesHistory.slice(-3).every((entry) => entry.species.length > 1));
    assert.ok(new Set(checkpoint.population.map((genome) =>
      genome.connections.map((edge) => edge.innovation).join(","))).size > 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uneven agent batch evaluates each genome three times without using idle slots", () => {
  const population = new MotorNeat({
    stage: "motor",
    motor: "M1",
    mode: "minecraft",
    component: "pipeline",
    agents: 3,
    episodes: 9,
    ticksPerEpisode: 1,
    tickMs: 100,
    seed: 42,
  });
  for (let episode = 1; episode <= 9; episode++) {
    for (let index = 0; index < 3; index++) {
      population.assign(index);
      population.observe(index, 1);
    }
    population.endEpisode();
    if (episode === 3) assert.equal(population.report().trialEvaluations, 8);
    if (episode === 6) assert.equal(population.report().trialEvaluations, 16);
  }
  assert.equal(population.report().generation, 1);
  assert.equal(population.checkpoint().generationBestFitness, 1);
});

test("full checkpoint resumes partial trials and produces the same later evolution", () => {
  const sourceId = "00000000-0000-4000-8000-000000000003";
  const root = mkdtempSync(join(tmpdir(), "motor-resume-"));
  const spec: RunSpec = {
    stage: "motor", motor: "M0", mode: "minecraft", component: "pipeline",
    agents: 3, episodes: 20, ticksPerEpisode: 1, tickMs: 100, seed: 42,
  };
  const advance = (population: MotorNeat, start: number, end: number) => {
    for (let episode = start; episode <= end; episode++) {
      for (let index = 0; index < spec.agents; index++) {
        population.assign(index);
        population.observe(index, episode + index);
      }
      population.endEpisode();
    }
  };
  try {
    const continuous = new MotorNeat(spec);
    advance(continuous, 1, 4);
    const saved = JSON.parse(JSON.stringify({ ...continuous.checkpoint(), seed: spec.seed }));
    assert.equal(saved.episode, 4);
    assert.equal(saved.resumeState.version, 1);
    mkdirSync(join(root, sourceId));
    writeFileSync(join(root, sourceId, "checkpoint.json"), JSON.stringify(saved));
    assert.throws(
      () => new MotorNeat({ ...spec, agents: 4, motorResume: sourceId }, root),
      /cannot restore the complete NEAT state/,
    );
    const restored = new MotorNeat({ ...spec, motorResume: sourceId }, root);
    assert.deepEqual(restored.checkpoint().population, continuous.checkpoint().population);
    assert.equal(restored.report().trialEvaluations, continuous.report().trialEvaluations);
    advance(continuous, 5, 20);
    advance(restored, 5, 20);
    const expected = continuous.checkpoint();
    const actual = restored.checkpoint();
    for (const key of ["population", "champion", "generation", "speciesHistory", "speciesLineages", "resumeState"] as const)
      assert.deepEqual(actual[key], expected[key], key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("motor checkpoints with earlier input and output layouts migrate the full population", () => {
  const root = mkdtempSync(join(tmpdir(), "motor-layout-upgrade-"));
  const spec: RunSpec = {
    stage: "motor", motor: "M0", mode: "minecraft", component: "pipeline",
    agents: 8, episodes: 6, ticksPerEpisode: 1, tickMs: 100, seed: 42,
  };
  const current = new MotorNeat(spec).checkpoint();
  try {
    for (const oldInputs of [12, 13]) {
      const id = `00000000-0000-4000-8000-0000000000${oldInputs}`;
      const oldOutputs = 8;
      const newInputs = current.inputs.length;
      const newOutputs = current.outputs.length;
      const newHiddenStart = newInputs + 1 + newOutputs;
      const shift = newInputs - oldInputs + newOutputs - oldOutputs;
      const mapId = (node: number): number | undefined =>
        node < oldInputs ? node :
        node < newInputs ? undefined :
        node === newInputs ? oldInputs :
        node < newInputs + 1 + oldOutputs ? oldInputs + 1 + node - newInputs - 1 :
        node < newHiddenStart ? undefined : node - shift;
      const graph = (genome: any) => ({
        ...genome,
        nodes: genome.nodes.filter((node: any) => mapId(node.id) !== undefined)
          .map((node: any) => ({ ...node, id: mapId(node.id) })),
        connections: genome.connections.filter((edge: any) =>
          mapId(edge.from) !== undefined && mapId(edge.to) !== undefined)
          .map((edge: any) => ({ ...edge, from: mapId(edge.from), to: mapId(edge.to) })),
      });
      const oldResumeState: any = structuredClone(current.resumeState);
      delete oldResumeState.evolutionVersion;
      delete oldResumeState.compatibilityThreshold;
      const old = {
        ...current, seed: spec.seed,
        inputs: current.inputs.slice(0, oldInputs),
        outputs: current.outputs.slice(0, oldOutputs),
        champion: graph(current.champion),
        population: current.population.map(graph),
        resumeState: {
          ...oldResumeState,
          nextNode: current.resumeState.nextNode - shift,
          innovations: current.resumeState.innovations.flatMap(([key, innovation]: [string, number]) => {
            const [from, to] = key.split(":").map(Number);
            const mappedFrom = mapId(from), mappedTo = mapId(to);
            return mappedFrom === undefined || mappedTo === undefined
              ? [] : [[`${mappedFrom}:${mappedTo}`, innovation]];
          }),
        },
      };
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, "checkpoint.json"), JSON.stringify(old));
      const restored = new MotorNeat({ ...spec, motorResume: id }, root);
      const saved = restored.checkpoint();
      assert.equal(saved.resumeState.evolutionVersion, 1);
      assert.deepEqual(saved.inputs, current.inputs);
      assert.deepEqual(saved.outputs, current.outputs);
      assert.equal(saved.population.length, 8);
      assert.ok(saved.population.every((genome: any) =>
        genome.nodes.length === current.inputs.length + current.outputs.length + 1));
      assert.ok(saved.population.every((genome: any) =>
        genome.connections.every((edge: any) =>
          genome.nodes.some((node: any) => node.id === edge.from) &&
          genome.nodes.some((node: any) => node.id === edge.to))));
      restored.assign(0);
      restored.observe(0, 1);
      restored.endEpisode();
      assert.equal(restored.checkpoint().episode, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy checkpoint forks its full population at a clean evolution boundary", () => {
  const sourceId = "00000000-0000-4000-8000-000000000004";
  const root = mkdtempSync(join(tmpdir(), "motor-legacy-resume-"));
  const spec: RunSpec = {
    stage: "motor", motor: "M0", mode: "minecraft", component: "pipeline",
    agents: 3, episodes: 20, ticksPerEpisode: 1, tickMs: 100, seed: 42,
  };
  try {
    const original = new MotorNeat(spec);
    for (let episode = 1; episode <= 11; episode++) {
      for (let index = 0; index < 3; index++) {
        original.assign(index);
        original.observe(index, episode + index);
      }
      original.endEpisode();
    }
    const saved = JSON.parse(JSON.stringify({ ...original.checkpoint(), seed: spec.seed }));
    delete saved.episode;
    delete saved.agents;
    delete saved.resumeState;
    mkdirSync(join(root, sourceId));
    writeFileSync(join(root, sourceId, "checkpoint.json"), JSON.stringify(saved));
    const fork = new MotorNeat({ ...spec, motorResume: sourceId }, root);
    const restored = fork.checkpoint();
    assert.equal(restored.episode, 9);
    assert.equal(restored.generation, 1);
    assert.equal(restored.population.length, saved.population.length);
    assert.deepEqual(restored.population.map((genome) => genome.connections),
      saved.population.map((genome: { connections: unknown }) => genome.connections));
    assert.ok(restored.population.every((genome) => genome.fitness === 0));
    assert.equal(restored.trialEvaluations, 0);
    assert.deepEqual(restored.speciesHistory, saved.speciesHistory);
    for (let episode = 10; episode <= 18; episode++) {
      for (let index = 0; index < 3; index++) {
        fork.assign(index);
        fork.observe(index, episode + index);
      }
      fork.endEpisode();
    }
    assert.equal(fork.report().generation, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("motor genomes start sparse and the inspector reports each assigned graph", async () => {
  const spec: RunSpec = {
    stage: "motor",
    motor: "M0",
    mode: "minecraft",
    component: "pipeline",
    agents: 64,
    episodes: 3,
    ticksPerEpisode: 1,
    tickMs: 100,
    seed: 42,
  };
  const population = new MotorNeat(spec);
  const initial = population.checkpoint().population;
  assert.ok(initial[0].connections.length < 104);
  const policies = Array.from({ length: 64 }, (_, index) => {
    population.assign(index);
    return {
      username: `agent-${index}`,
      policy: new MotorPolicy(population, index),
    };
  });
  const first = population.inspect("policy", 0);
  const second = population.inspect("policy", 1);
  assert.equal(first.hyperparameters.genomeIndex, 0);
  assert.equal(second.hyperparameters.genomeIndex, 1);
  assert.equal(first.nodes.length, initial[0].nodes.length);
  assert.equal(first.edges.length, initial[0].connections.length);
  const ids = new Set(first.nodes.map((node) => node.id));
  assert.ok(
    first.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)),
  );
  const variants = await inspectModels(
    "motor",
    policies,
    new MotorTrainer(population),
  );
  assert.ok(variants.length > 1);
  assert.ok(Buffer.byteLength(JSON.stringify(variants)) < 1_000_000);
  for (let episode = 0; episode < 3; episode++) {
    for (let index = 0; index < 64; index++) {
      population.assign(index);
      population.observe(index, Math.sin(index + episode));
    }
    population.endEpisode();
  }
  assert.ok(population.checkpoint().speciesHistory[0].species.length > 1);
  assert.equal(population.checkpoint().population.length, 64);
});

test("M8 and loaded motor skills use an unchanged source champion", async () => {
  const sourceId = "00000000-0000-4000-8000-000000000001";
  const legacyId = "00000000-0000-4000-8000-000000000002";
  const root = mkdtempSync(join(tmpdir(), "motor-skill-"));
  try {
    const base: RunSpec = {
      stage: "motor",
      motor: "M7",
      mode: "minecraft",
      component: "pipeline",
      agents: 8,
      episodes: 3,
      ticksPerEpisode: 1,
      tickMs: 100,
      seed: 42,
    };
    const source = new MotorNeat(base).checkpoint();
    mkdirSync(join(root, sourceId));
    writeFileSync(
      join(root, sourceId, "checkpoint.json"),
      JSON.stringify(source),
    );
    const evaluation = new MotorNeat(
      {
        ...base,
        motor: "M8",
        motorSource: sourceId,
        component: "evaluation",
        episodes: 6,
        seed: 43,
      },
      root,
    );
    for (let episode = 0; episode < 6; episode++) {
      for (let index = 0; index < 8; index++) {
        evaluation.assign(index);
        evaluation.observe(index, index + 1);
      }
      assert.equal(evaluation.endEpisode(), false);
    }
    assert.equal(evaluation.report().generation, 0);
    assert.ok(
      evaluation
        .checkpoint()
        .population.every(
          (genome) =>
            JSON.stringify(genome.connections) ===
            JSON.stringify(source.champion.connections),
        ),
    );
    const policy = loadMotorSkill(sourceId, root, "M7");
    await policy.reset(42);
    assert.equal(policy.inspectModel()?.status, "ready");
    const legacy = {
      ...source,
      inputs: source.inputs.slice(0, -1),
      champion: {
        ...source.champion,
        nodes: source.champion.nodes
          .filter((node) => node.id !== 12)
          .map((node) => ({
            ...node,
            id: node.id > 12 ? node.id - 1 : node.id,
          })),
        connections: source.champion.connections
          .filter(
            (connection) => connection.from !== 12 && connection.to !== 12,
          )
          .map((connection) => ({
            ...connection,
            from: connection.from > 12 ? connection.from - 1 : connection.from,
            to: connection.to > 12 ? connection.to - 1 : connection.to,
          })),
      },
    };
    mkdirSync(join(root, legacyId));
    writeFileSync(
      join(root, legacyId, "checkpoint.json"),
      JSON.stringify(legacy),
    );
    const migrated = loadMotorSkill(legacyId, root, "M7");
    await migrated.reset(42);
    assert.ok(
      migrated.inspectModel()?.nodes.some((node) => node.label === "yaw_cos"),
    );
  } finally {
    for (const id of [sourceId, legacyId]) {
      const directory = join(root, id);
      const checkpoint = join(directory, "checkpoint.json");
      if (existsSync(checkpoint)) unlinkSync(checkpoint);
      if (existsSync(directory)) rmdirSync(directory);
    }
    rmdirSync(root);
  }
});
