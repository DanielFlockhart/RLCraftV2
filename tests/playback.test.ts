import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveStepMs, type RunSpec } from "@rlcraft/core";
import {
  changePlayback,
  initialPlayback,
  playbackSchema,
} from "../apps/control/src/playback.js";
const spec: RunSpec = {
  stage: "movement",
  mode: "simulator",
  component: "pipeline",
  agents: 1,
  episodes: 3,
  ticksPerEpisode: 100,
  tickMs: 100,
  seed: 42,
};
test("pace scaling caps Minecraft sampling and generation limits use explicit units", () => {
  assert.equal(effectiveStepMs(spec, 2), 50);
  assert.equal(effectiveStepMs({ ...spec, mode: "minecraft" }, 8), 50);
  assert.equal(effectiveStepMs(spec, 0.5), 200);
  const initial = initialPlayback(spec);
  const extended = changePlayback(
    initial,
    { action: "extend", seconds: 10 },
    spec,
    false,
  );
  assert.equal(extended.ticksPerGeneration, 200);
  const timed = changePlayback(
    extended,
    { action: "length", unit: "seconds", value: 30 },
    spec,
    false,
  );
  assert.equal(timed.generationSeconds, 30);
  assert.equal(timed.ticksPerGeneration, 100000);
  assert.equal(
    changePlayback(timed, { action: "extend", seconds: 5 }, spec, false)
      .generationSeconds,
    35,
  );
  assert.equal(
    changePlayback(
      timed,
      { action: "length", unit: "steps", value: 50 },
      spec,
      false,
    ).generationSeconds,
    undefined,
  );
  assert.equal(initial.ticksPerGeneration, 100);
});
test("manual controls validate counts, reject overlapping advancement and preserve queued configuration", () => {
  const initial = initialPlayback({ ...spec, generationSeconds: 60 });
  assert.equal(initial.ticksPerGeneration, 100000);
  assert.throws(() =>
    changePlayback(
      initial,
      { action: "advance", unit: "steps", value: 3 },
      spec,
      false,
    ),
  );
  const manual = changePlayback(
    initial,
    { action: "advance", unit: "steps", value: 3 },
    spec,
    true,
  );
  assert.deepEqual(manual.manual, { kind: "steps", remaining: 3 });
  assert.throws(() =>
    changePlayback(
      manual,
      { action: "advance", unit: "seconds", value: 1 },
      spec,
      true,
    ),
  );
  for (const command of [
    { action: "speed", speed: 0 },
    { action: "speed", speed: 9 },
    { action: "length", unit: "steps", value: 1.5 },
    { action: "advance", unit: "generation", value: 2 },
    { action: "extend", seconds: -1 },
    { action: "length", unit: "seconds", value: 86401 },
  ])
    assert.equal(playbackSchema.safeParse(command).success, false);
});
