import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ARENA_SPEC,
  DEFAULT_AGENT_SETUP,
  type RunSpec,
  type Run,
} from "@mlcraft/core";
import {
  arenaSpecSchema,
  arenaBlueprintSchema,
  validateArenaRun,
  arenaConflict,
} from "../apps/control/src/arenas.js";
import {
  arenaCellOrigin,
  arenaSpawn,
  arenaBounds,
} from "../packages/core/src/arenas.js";
import { Store } from "../apps/control/src/store.js";
import { archiveDocuments } from "../apps/control/src/archive-documents.js";
const base: RunSpec = {
  stage: "movement",
  mode: "minecraft",
  component: "pipeline",
  agents: 4,
  episodes: 2,
  ticksPerEpisode: 5,
  tickMs: 50,
  seed: 42,
  arena: structuredClone(DEFAULT_ARENA_SPEC),
};

test("arena validation rejects unknown blocks/items, unsafe spawns, invalid regions, duplicate containers and invalid budgets", () => {
  const blueprint = DEFAULT_ARENA_SPEC.blueprint;
  assert.equal(arenaSpecSchema.safeParse(DEFAULT_ARENA_SPEC).success, true);
  for (const patch of [
    { width: 33 },
    { floor: "minecraft:air" },
    { walls: "minecraft:unknown" },
    { spawn: { x: 100, y: 0, z: 0 } },
    { spawn: { x: 1, y: 1, z: 1 } },
    {
      regions: [
        {
          from: blueprint.spawn,
          to: blueprint.spawn,
          block: "minecraft:stone",
        },
      ],
    },
    {
      regions: [
        {
          from: { x: 2, y: 0, z: 0 },
          to: { x: 1, y: 0, z: 0 },
          block: "minecraft:stone",
        },
      ],
    },
    {
      containers: [
        {
          position: { x: 0, y: 0, z: 0 },
          block: "minecraft:chest",
          items: [{ slot: 0, item: "minecraft:iron_axe", count: 64 }],
        },
      ],
    },
    {
      containers: [
        { position: blueprint.spawn, block: "minecraft:barrel", items: [] },
      ],
    },
    {
      entities: [
        { position: { x: 1, y: 0, z: 1 }, type: "ender_dragon", count: 1 },
      ],
    },
  ])
    assert.equal(
      arenaBlueprintSchema.safeParse({ ...blueprint, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  assert.throws(
    () => validateArenaRun({ ...base, mode: "simulator" }),
    /Minecraft mode/,
  );
  assert.throws(
    () =>
      validateArenaRun({
        ...base,
        setup: { ...DEFAULT_AGENT_SETUP, spawn: { x: 0, y: 64, z: 0 } },
      }),
    /custom spawn/,
  );
  assert.throws(
    () =>
      validateArenaRun({
        ...base,
        agents: 128,
        arena: {
          ...DEFAULT_ARENA_SPEC,
          blueprint: { ...blueprint, width: 32, depth: 32, height: 16 },
        },
      }),
    /65,536/,
  );
  assert.throws(
    () =>
      validateArenaRun({
        ...base,
        arena: { ...DEFAULT_ARENA_SPEC, origin: { x: 29999984, y: 64, z: 0 } },
      }),
    /bounds/,
  );
});

test("grid placement records actual cell spawns, shared layouts reuse one cell, and occupied experiments cannot overlap", () => {
  const arena = {
    ...DEFAULT_ARENA_SPEC,
    columns: 2,
    origin: { x: -20, y: -61, z: -20 },
  };
  assert.deepEqual(arenaCellOrigin(arena, 3), { x: -7, y: -61, z: -7 });
  assert.deepEqual(arenaSpawn(arena, 3), { x: -2.5, y: -60, z: -2.5 });
  assert.deepEqual(arenaBounds(arena, 4), {
    min: arena.origin,
    max: { x: 1, y: -56, z: 1 },
  });
  assert.deepEqual(
    arenaSpawn({ ...arena, layout: "shared" }, 127),
    arenaSpawn(arena, 0),
  );
  const active = {
    id: "existing",
    spec: { ...base, arena },
    status: "running",
  } as Run;
  assert.throws(() => arenaConflict({ ...base, arena }, [active]), /overlaps/);
  assert.throws(
    () => arenaConflict({ ...base, arena: undefined }, [active]),
    /mixing/,
  );
  assert.doesNotThrow(() =>
    arenaConflict(
      { ...base, arena: { ...arena, origin: { x: 100, y: -61, z: 100 } } },
      [active],
    ),
  );
  assert.doesNotThrow(() =>
    arenaConflict({ ...base, arena }, [{ ...active, status: "completed" }]),
  );
});

test("arena presets persist independently from run snapshots and are included in the optional Firebase archive", () => {
  const store = new Store(":memory:");
  try {
    store.archive.configure("test-destination");
    const now = new Date().toISOString();
    const preset = {
      id: "preset",
      name: "Cage",
      blueprint: DEFAULT_ARENA_SPEC.blueprint,
      createdAt: now,
      updatedAt: now,
    };
    store.saveArenaPreset(preset);
    store.saveRun({
      id: "run",
      spec: base,
      status: "queued",
      episode: 0,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    });
    store.saveArenaPreset({
      ...preset,
      blueprint: { ...preset.blueprint, width: 9 },
    });
    assert.equal(store.arenaPreset("preset")!.blueprint.width, 9);
    assert.equal(store.getRun("run")!.spec.arena!.blueprint.width, 7);
    store.deleteArenaPreset("preset");
    assert.equal(store.arenaPresets().length, 0);
    assert.equal(store.getRun("run")!.spec.arena!.blueprint.width, 7);
    assert.equal(
      archiveDocuments(store.archive.batch()).find(
        (doc) => doc.path === "arenaPresets/preset",
      )!.value,
      null,
    );
  } finally {
    store.close();
  }
});
