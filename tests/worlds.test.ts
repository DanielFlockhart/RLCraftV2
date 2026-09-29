import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import nbt from "prismarine-nbt";
import {
  WorldManager,
  worldCreateSchema,
  worldSettingsSchema,
} from "../apps/control/src/worlds.js";
const settings = {
  type: "flat" as const,
  seed: "42",
  difficulty: "peaceful" as const,
  gamemode: "survival" as const,
  structures: false,
  flat: {
    biome: "minecraft:plains",
    layers: [
      { block: "minecraft:bedrock", height: 1 },
      { block: "minecraft:dirt", height: 8 },
      { block: "minecraft:grass_block", height: 1 },
    ],
  },
};

test("world creation, resets and restoring generations preserve worlds, dimensions, player data and unrelated properties", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "rlcraft-worlds-"));
  try {
    const properties =
      "level-name=training-world\nlevel-type=default\nlevel-seed=\ndifficulty=normal\ngamemode=survival\nmax-players=150\nonline-mode=false\nserver-port=25565\n";
    await writeFile(resolve(dir, "server.properties"), properties);
    for (const name of [
      "training-world",
      "training-world_nether",
      "training-world_the_end",
    ]) {
      await mkdir(resolve(dir, name));
      await writeFile(
        resolve(dir, name, "sentinel"),
        "Original world/player state",
      );
    }
    // World seeds are signed 64-bit integers, not safely representable as JS numbers.
    await writeFile(
      resolve(dir, "training-world/level.dat"),
      gzipSync(
        nbt.writeUncompressed({
          type: "compound",
          name: "",
          value: {
            Data: {
              type: "compound",
              value: {
                WorldGenSettings: {
                  type: "compound",
                  value: { seed: { type: "long", value: [-1, 42] } },
                },
              },
            },
          },
        }),
      ),
    );
    let blocked: string | undefined;
    const logs: string[] = [];
    const worlds = new WorldManager(
      dir,
      () => blocked,
      (message) => logs.push(message),
    );
    const original = await worlds.catalog();
    const rediscovered = await new WorldManager(
      dir,
      () => undefined,
      () => {},
    ).catalog();
    assert.deepEqual(rediscovered.active, original.active);
    assert.equal(
      original.profiles[0].generations[0].settings.seed,
      "-4294967254",
    );
    await assert.rejects(access(resolve(dir, "rlcraft-worlds.json"))); // Reading never changes runtime state.
    const created = await worlds.create(
      worldCreateSchema.parse({ name: "Movement flat", settings }),
    );
    const profile = created.profiles.find((p) => p.name === "Movement flat")!;
    const first = profile.generations[0];
    assert.equal(created.active?.levelName, first.levelName);
    const configured = await readFile(
      resolve(dir, "server.properties"),
      "utf8",
    );
    assert.match(configured, /max-players=150/);
    assert.match(configured, /online-mode=false/);
    assert.match(configured, /level-type=flat/);
    const reset = await worlds.reset(profile.id, first.id, false);
    const second = reset.profiles.find((p) => p.id === profile.id)!
      .generations[1];
    assert.notEqual(first.levelName, second.levelName);
    assert.equal(first.settings.seed, second.settings.seed);
    const refreshed = await worlds.reset(profile.id, second.id, true);
    assert.notEqual(
      refreshed.profiles.find((p) => p.id === profile.id)!.generations[2]
        .settings.seed,
      second.settings.seed,
    );
    await worlds.activate(
      original.profiles[0].id,
      original.profiles[0].generations[0].id,
    );
    const restored = await readFile(resolve(dir, "server.properties"), "utf8");
    assert.match(restored, /level-name=training-world/);
    assert.match(restored, /level-type=default/);
    assert.match(restored, /level-seed=\r?\n/);
    for (const name of [
      "training-world",
      "training-world_nether",
      "training-world_the_end",
    ])
      assert.equal(
        await readFile(resolve(dir, name, "sentinel"), "utf8"),
        "Original world/player state",
      );
    blocked = "Server still saving";
    const before = await readFile(resolve(dir, "server.properties"), "utf8");
    await assert.rejects(
      worlds.reset(profile.id, first.id, false),
      /still saving/,
    );
    assert.equal(
      await readFile(resolve(dir, "server.properties"), "utf8"),
      before,
    );
    assert.equal((await worlds.catalog()).canChange, false);
    assert.ok(
      logs.some((message) => message.includes("previous world retained")),
    );
    const reopened = new WorldManager(
      dir,
      () => undefined,
      () => {},
    );
    assert.equal((await reopened.catalog()).profiles.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("world changes reject unknown blocks/biomes, invalid heights, properties injection and overlapping mutations", async () => {
  for (const input of [
    { ...settings, seed: "42\nmax-players=1" },
    { ...settings, flat: { ...settings.flat, biome: "minecraft:made_up" } },
    {
      ...settings,
      flat: {
        ...settings.flat,
        layers: [{ block: "minecraft:made_up", height: 1 }],
      },
    },
    {
      ...settings,
      flat: {
        ...settings.flat,
        layers: [{ block: "minecraft:dirt", height: 385 }],
      },
    },
  ])
    assert.equal(worldSettingsSchema.safeParse(input).success, false);
  const dir = await mkdtemp(resolve(tmpdir(), "rlcraft-world-lock-"));
  try {
    const worlds = new WorldManager(
      dir,
      () => undefined,
      () => {},
    );
    assert.equal((await worlds.catalog()).profiles.length, 0);
    await writeFile(
      resolve(dir, "server.properties"),
      "level-name=training-world\n",
    );
    assert.equal((await worlds.catalog()).profiles.length, 1); // Preparation after first dashboard read.
    const pending = worlds.create({ name: "First", settings });
    await assert.rejects(
      worlds.create({ name: "Concurrent", settings }),
      /already in progress/,
    );
    await pending;
    assert.equal(worlds.busy, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
