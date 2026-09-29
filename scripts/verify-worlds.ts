import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  cp,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:net";
import nbt from "prismarine-nbt";
import mineflayer, { type Bot } from "mineflayer";
import { Store } from "../apps/control/src/store.js";
import { MinecraftServer } from "../apps/control/src/server.js";
import { WorldManager } from "../apps/control/src/worlds.js";
import { config, root } from "../apps/control/src/config.js";
import type { WorldSettings, WorldGeneration } from "@rlcraft/core";

const listener = createServer();
await new Promise<void>((ok, fail) => {
  listener.once("error", fail);
  listener.listen(0, "127.0.0.1", ok);
});
const address = listener.address();
if (!address || typeof address === "string")
  throw new Error("No isolated test port");
const port = address.port;
await new Promise<void>((ok) => listener.close(() => ok()));
const original = config.serverDir;
const runtime = resolve(root, "runtime");
await mkdir(runtime, { recursive: true });
const testDir = await mkdtemp(join(runtime, "world-verification-"));
const store = new Store(":memory:");
const server = new MinecraftServer(store, () => {});
const worlds = new WorldManager(
  testDir,
  () => (server.hasProcess ? "Server must be stopped" : undefined),
  (message) => console.log(message),
);
let bot: Bot | undefined;
const settings: WorldSettings = {
  type: "flat",
  seed: "42",
  difficulty: "peaceful",
  gamemode: "survival",
  structures: true,
  flat: {
    biome: "minecraft:plains",
    layers: [
      { block: "minecraft:bedrock", height: 1 },
      { block: "minecraft:dirt", height: 8 },
      { block: "minecraft:grass_block", height: 1 },
    ],
  },
};
async function until(predicate: () => boolean, label: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function boot() {
  server.start();
  await until(
    () => {
      if (server.state.status === "failed") throw new Error(server.state.error);
      return server.state.status === "running";
    },
    "Paper readiness",
    180000,
  );
}
async function stop() {
  bot?.quit();
  bot = undefined;
  await server.stop();
}
async function saved(generation: WorldGeneration) {
  return nbt.simplify(
    (
      await nbt.parse(
        await readFile(resolve(testDir, generation.levelName, "level.dat")),
        "big",
      )
    ).parsed,
  ).Data;
}
async function blockAtOrigin(expected: string) {
  bot = mineflayer.createBot({
    username: "rl_world_test",
    host: "127.0.0.1",
    port,
    version: "1.18.1",
    auth: "offline",
  });
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("Bot spawn timeout")), 30000);
    bot!.once("spawn", () => {
      clearTimeout(timer);
      ok();
    });
    bot!.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
  server.command("tp rl_world_test 0 -54 0");
  await until(
    () =>
      Math.abs(bot!.entity.position.x) < 1 &&
      Math.abs(bot!.entity.position.z) < 1,
    "test teleport",
  );
  await until(
    () =>
      bot!.blockAt(bot!.entity.position.floored().set(0, -55, 0))?.name ===
      expected,
    `origin block ${expected}`,
  );
}
try {
  await copyFile(
    resolve(original, "server.jar"),
    resolve(testDir, "server.jar"),
  );
  await copyFile(resolve(original, "eula.txt"), resolve(testDir, "eula.txt"));
  for (const name of ["libraries", "cache", "versions"])
    if (existsSync(resolve(original, name)))
      await cp(resolve(original, name), resolve(testDir, name), {
        recursive: true,
      });
  await mkdir(resolve(testDir, "plugins"));
  await copyFile(
    resolve(original, "plugins/RLCraftViewerGuard.jar"),
    resolve(testDir, "plugins/RLCraftViewerGuard.jar"),
  );
  await writeFile(
    resolve(testDir, "server.properties"),
    `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nlevel-name=unused-baseline\nlevel-type=default\nview-distance=2\nsimulation-distance=2\nspawn-protection=0\nspawn-monsters=false\nspawn-animals=false\n`,
  );
  config.serverDir = testDir;
  config.MC_MIN_MEMORY = "512M";
  config.MC_MAX_MEMORY = "1G";
  const created = await worlds.create({ name: "Custom flat", settings });
  const profile = created.profiles.find((p) => p.name === "Custom flat")!;
  const first = profile.generations[0];
  await boot();
  await assert.rejects(
    worlds.reset(profile.id, first.id, false),
    /must be stopped/,
  );
  await blockAtOrigin("grass_block");
  server.command("setblock 0 -55 0 gold_block");
  await until(
    () =>
      bot!.blockAt(bot!.entity.position.floored().set(0, -55, 0))?.name ===
      "gold_block",
    "changed block",
  );
  await stop();
  const flat = await saved(first);
  const generator =
    flat.WorldGenSettings.dimensions["minecraft:overworld"].generator;
  assert.equal(generator.type, "minecraft:flat");
  assert.deepEqual(generator.settings.layers, settings.flat.layers);
  assert.ok(generator.settings.structures.structures["minecraft:village"]);
  assert.equal(flat.WorldGenSettings.seed.toString(), "42");
  assert.equal(flat.GameRules.spectatorsGenerateChunks, "false");
  console.log(
    "PASS: exact custom superflat layers, village configuration, seed and viewer gamerule in Paper level.dat",
  );
  const reset = await worlds.reset(profile.id, first.id, false);
  const second = reset.profiles.find((p) => p.id === profile.id)!
    .generations[1];
  await boot();
  await blockAtOrigin("grass_block");
  await stop();
  assert.equal((await saved(second)).WorldGenSettings.seed.toString(), "42");
  await worlds.activate(profile.id, first.id);
  await boot();
  await blockAtOrigin("gold_block");
  await stop();
  console.log(
    "PASS: reset produces fresh terrain; returning to earlier generation restores changed blocks",
  );
  for (const type of ["survival", "large_biomes", "amplified"] as const) {
    const catalog = await worlds.create({
      name: type,
      settings: { ...settings, type, difficulty: "normal" },
    });
    const generation = catalog.profiles.find((p) => p.name === type)!
      .generations[0];
    await boot();
    await stop();
    const data = await saved(generation);
    const generator =
      data.WorldGenSettings.dimensions["minecraft:overworld"].generator;
    assert.equal(generator.type, "minecraft:noise");
    assert.equal(
      generator.settings,
      type === "survival" ? "minecraft:overworld" : `minecraft:${type}`,
    );
    assert.equal(data.WorldGenSettings.seed.toString(), "42");
    console.log(
      `PASS: ${type} uses expected noise generator with recorded seed`,
    );
  }
  const errors = store
    .logs(undefined, 1000)
    .filter((log) =>
      /Error parsing|Failed to parse|Unknown registry/.test(log.message),
    );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real Paper world creation, same-seed reset, saved terrain restore, all four terrain types and viewer gamerule. Training world untouched.",
  );
} finally {
  await stop();
  store.close();
  if (resolve(testDir).startsWith(runtime + sep))
    await rm(testDir, { recursive: true, force: true });
}
