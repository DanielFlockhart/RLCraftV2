import test from "node:test";
import assert from "node:assert/strict";
import type { RunSpec, PolicyObservation } from "@mlcraft/core";
import {
  motorArena,
  motorReward,
  motorSessions,
  motorTarget,
} from "../packages/core/src/motor.js";
import { arenaSpawn } from "../packages/core/src/arenas.js";
import { arenaSpecSchema } from "../apps/control/src/arenas.js";
import {
  MotorNeat,
  MotorPolicy,
  MotorTrainer,
} from "../packages/agents/src/motor-neat.js";

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
});

test("NEAT evaluates a population and evolves after all candidates receive rewards", async () => {
  const spec: RunSpec = {
    stage: "motor",
    motor: "M0",
    mode: "minecraft",
    component: "pipeline",
    agents: 1,
    episodes: 8,
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
  for (let episode = 1; episode <= 8; episode++) {
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
  assert.equal(checkpoint.bestFitness, 8);
  assert.equal(population.inspect("policy").status, "ready");
});
