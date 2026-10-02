import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MotorFullRun, MotorTerrainRun } from "@mlcraft/core";
import { Store } from "../apps/control/src/store.js";
import { summarizeMotorTrials } from "../apps/control/src/motor-full-run.js";

test("Full Run conditions use all trial episodes after an interrupted continuation", () => {
  const summary = summarizeMotorTrials([
    [
      { episode: 1, trials: 2, successes: 0 },
      { episode: 2, trials: 2, successes: 0 },
      { episode: 3, trials: 2, successes: 0 },
    ],
    [
      { episode: 3, trials: 2, successes: 2 },
      { episode: 4, trials: 2, successes: 2 },
    ],
  ], 4);
  assert.equal(summary.episodeCount, 4);
  assert.equal(summary.successRate, 0.5);
});

test("natural terrain continuation survives reopening the control store", () => {
  const root = mkdtempSync(join(tmpdir(), "motor-terrain-run-"));
  try {
    const path = join(root, "control.sqlite");
    const plan: MotorTerrainRun = {
      id: "00000000-0000-4000-8000-000000000010",
      sourceFullRunId: "00000000-0000-4000-8000-000000000011",
      sourceRunId: "00000000-0000-4000-8000-000000000012",
      status: "running",
      runIds: ["00000000-0000-4000-8000-000000000013"],
      episodesPerWorld: 12,
      minDistance: 12,
      maxDistance: 80,
      spreadRadius: 128,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const first = new Store(path);
    first.saveMotorTerrainRun(plan);
    first.close();
    const reopened = new Store(path);
    assert.deepEqual(reopened.motorTerrainRun(plan.id), plan);
    assert.deepEqual(reopened.motorTerrainRuns(), [plan]);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Full Run stage progress and run lineage survive reopening the control store", () => {
  const root = mkdtempSync(join(tmpdir(), "motor-full-run-"));
  try {
    const path = join(root, "control.sqlite");
    const plan: MotorFullRun = {
      id: "00000000-0000-4000-8000-000000000005",
      status: "running",
      stageIndex: 1,
      stages: [
        { session: "M0", agents: 4, episodes: 24, ticksPerEpisode: 80,
          tickMs: 100, seed: 42, backend: "mineflayer", minSuccessRate: 0.5,
          maxAttempts: 2, runIds: ["00000000-0000-4000-8000-000000000006"],
          lastSuccessRate: 0.75, lastBestFitness: 12 },
        { session: "M1", agents: 8, episodes: 24, ticksPerEpisode: 100,
          tickMs: 80, seed: 43, backend: "mineflayer", minSuccessRate: 0,
          maxAttempts: 1, runIds: [] },
      ],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const first = new Store(path);
    first.saveMotorFullRun(plan);
    first.close();
    const reopened = new Store(path);
    assert.deepEqual(reopened.motorFullRun(plan.id), plan);
    assert.deepEqual(reopened.motorFullRuns(), [plan]);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
