import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "@mlcraft/core";
import { viewerHudRuns } from "../apps/control/src/viewer-hud.js";
import { motorArena, motorTarget } from "../packages/core/src/motor.js";
import { arenaSpawn } from "../packages/core/src/arenas.js";

const run: Run = {
  id: "12345678-1234-1234-1234-123456789abc",
  status: "running",
  createdAt: new Date(1000).toISOString(),
  updatedAt: new Date(3000).toISOString(),
  episode: 2,
  progress: 0.3,
  spec: {
    stage: "movement",
    mode: "minecraft",
    component: "pipeline",
    agents: 2,
    episodes: 5,
    ticksPerEpisode: 100,
    tickMs: 50,
    seed: 42,
  },
  timing: {
    sampledAt: 2000,
    totalElapsedMs: 1000,
    generationElapsedMs: 500,
    lastGenerationMs: 400,
    tick: 25,
    ticks: 100,
    phase: "training",
    advancing: true,
  },
};
test("viewer clocks freeze generation during pauses, preserve wall runtime and stop after terminal state", () => {
  const active = viewerHudRuns([run], 4000)[0];
  assert.equal(active.totalMs, 3000);
  assert.equal(active.generationMs, 2500);
  assert.equal(active.targetGenerationMs, 5000);
  const paused = viewerHudRuns(
    [
      {
        ...run,
        status: "paused",
        timing: { ...run.timing!, advancing: false },
      },
    ],
    4000,
  )[0];
  assert.equal(paused.generationMs, 500);
  assert.equal(paused.totalMs, 3000);
  const completed = { ...run, status: "completed" as const };
  assert.deepEqual(
    viewerHudRuns([completed], 4000),
    viewerHudRuns([completed], 100000),
  );
  assert.equal(active.lastGenerationMs, 400);
  const interrupted = viewerHudRuns(
    [
      {
        ...run,
        status: "interrupted",
        updatedAt: new Date(100000).toISOString(),
      },
    ],
    100000,
  )[0];
  assert.equal(interrupted.totalMs, run.timing!.totalElapsedMs);
  assert.equal(interrupted.generationMs, run.timing!.generationElapsedMs);
});
test("HUD limits payloads, excludes simulator experiments and keeps queued timing unavailable", () => {
  const simulator = {
    ...run,
    spec: { ...run.spec, mode: "simulator" as const },
  };
  assert.equal(viewerHudRuns([simulator]).length, 0);
  const queued = viewerHudRuns(
    [{ ...run, status: "queued", timing: undefined }],
    4000,
  )[0];
  assert.equal(queued.timingAvailable, false);
  assert.equal(queued.totalMs, 0);
  assert.equal(viewerHudRuns(Array.from({ length: 30 }, () => run)).length, 16);
  const backlog = Array.from({ length: 30 }, () => ({
    ...run,
    status: "queued" as const,
    updatedAt: new Date(999999).toISOString(),
  }));
  assert.equal(
    viewerHudRuns([...backlog, { ...run, status: "paused" }])[0].status,
    "paused",
  );
});
test("motor markers follow each agent's actual episode target and disappear after the run", () => {
  const arena = motorArena("M1", 42);
  const motorRun: Run = {
    ...run,
    spec: { ...run.spec, stage: "motor", motor: "M1", arena, agents: 2 },
  };
  const projected = viewerHudRuns([motorRun])[0];
  assert.equal(projected.motor, "M1");
  assert.deepEqual(
    projected.motorMarkers,
    [0, 1].map((index) => ({
      index,
      spawn: arenaSpawn(arena, index),
      target: motorTarget(
        arena,
        "M1",
        index,
        motorRun.episode,
        motorRun.spec.seed,
        motorRun.spec.agents,
      ),
    })),
  );
  assert.deepEqual(
    viewerHudRuns([{ ...motorRun, status: "completed" }])[0].motorMarkers,
    [],
  );
});
test("64 motor markers fit in the viewer HUD console payload", () => {
  const motorRun: Run = {
    ...run,
    spec: {
      ...run.spec,
      stage: "motor",
      motor: "M0",
      arena: motorArena("M0", 42),
      agents: 64,
    },
  };
  const projection = viewerHudRuns([motorRun]);
  assert.equal(projection[0].motorMarkers.length, 64);
  const payload = Buffer.from(JSON.stringify({ runs: projection })).toString(
    "base64url",
  );
  assert.ok(
    payload.length <= 32768,
    `HUD payload has ${payload.length} characters`,
  );
});

test("natural terrain markers use each agent's observed spawn and target", () => {
  const terrainRun: Run = {
    ...run,
    spec: {
      ...run.spec,
      stage: "motor",
      motor: "M7",
      motorTerrain: {
        planId: "00000000-0000-4000-8000-000000000001",
        worldSeed: "12345",
        minDistance: 12,
        maxDistance: 80,
        spreadRadius: 128,
      },
    },
  };
  const spawn = { x: 10, y: 71, z: 20 };
  const target = { x: 60, y: 71, z: 40 };
  const projected = viewerHudRuns([terrainRun], 4000, () => [{
    id: `${terrainRun.id}:0`, runId: terrainRun.id, username: "rl_test_0",
    status: "active", ticks: 0, reward: 0, health: 20,
    motorSpawn: spawn, motorTarget: target,
  }]);
  assert.deepEqual(projected[0].motorMarkers, [{ index: 0, spawn, target }]);
});
