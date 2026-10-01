import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "@mlcraft/core";
import { viewerHudRuns } from "../apps/control/src/viewer-hud.js";

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
