import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { MinecraftEnvironment } from "@mlcraft/agents";
import { DEFAULT_AGENT_SETUP, defaultInputs, type Run } from "@mlcraft/core";
import { config, root } from "../apps/control/src/config.js";
import { createApp } from "../apps/control/src/app.js";
import { Store } from "../apps/control/src/store.js";

// An owned, disposable world: console grants below verify packet detection,
// never claim a policy completed survival or touch the user's running world.
const listener = createServer();
await new Promise<void>((yes, no) => {
  listener.once("error", no);
  listener.listen(0, "127.0.0.1", yes);
});
const address = listener.address();
if (!address || typeof address === "string") throw new Error("No test port");
const port = address.port;
await new Promise<void>((yes) => listener.close(() => yes()));
const original = config.serverDir;
const fixture = await mkdtemp(resolve(root, "runtime/progress-verification-"));
config.serverDir = fixture;
config.dataDir = resolve(fixture, "data");
config.artifactDir = resolve(fixture, "artifacts");
config.MC_PORT = port;
config.MC_MIN_MEMORY = "512M";
config.MC_MAX_MEMORY = "1G";
const { app, store, server } = createApp(new Store(":memory:"));
let environment: MinecraftEnvironment | undefined;
async function until(check: () => boolean, label: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (server.state.status === "failed") throw new Error(server.state.error);
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((yes) => setTimeout(yes, 50));
  }
  console.log(`PASS: ${label}`);
}
try {
  await copyFile(
    resolve(original, "server.jar"),
    resolve(fixture, "server.jar"),
  );
  await copyFile(resolve(original, "eula.txt"), resolve(fixture, "eula.txt"));
  for (const name of ["cache", "libraries", "versions"])
    await cp(resolve(original, name), resolve(fixture, name), {
      recursive: true,
    });
  await mkdir(resolve(fixture, "plugins"));
  await copyFile(
    resolve(original, "plugins/RLCraftViewerGuard.jar"),
    resolve(fixture, "plugins/RLCraftViewerGuard.jar"),
  );
  await writeFile(
    resolve(fixture, "server.properties"),
    `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nlevel-type=flat\nlevel-name=progress-test\ngenerate-structures=false\nview-distance=2\nsimulation-distance=2\nspawn-protection=0\nmax-players=100\nspawn-monsters=false\nspawn-animals=false\n`,
  );
  await app.ready();
  server.start();
  await until(
    () =>
      server.state.status === "running" &&
      !!server.state.progressReady &&
      !!server.state.setupReady,
    "isolated Paper/progress plugin startup",
    180000,
  );
  const runId = randomUUID(),
    agentId = `${runId}:0`,
    username = `rl_${runId.slice(0, 6)}_0`;
  const now = new Date().toISOString();
  store.saveRun({
    id: runId,
    spec: {
      mode: "minecraft",
      agents: 1,
      stage: "survival",
      component: "pipeline",
      episodes: 1,
      ticksPerEpisode: 100,
      tickMs: 100,
      seed: 42,
    },
    status: "running",
    createdAt: now,
    updatedAt: now,
    progress: 0,
    episode: 1,
  } as Run);
  const agent = {
    id: agentId,
    runId,
    username,
    status: "connecting" as const,
    ticks: 0,
    reward: 0,
    health: 20,
  };
  store.saveAgents([agent]);
  const inputs = structuredClone(defaultInputs);
  for (const channel of Object.values(inputs.channels)) channel.enabled = false;
  environment = new MinecraftEnvironment(
    username,
    { host: "127.0.0.1", port, version: "1.18.1", auth: "offline" },
    (setup) => server.setupAgent(randomUUID(), username, setup),
    undefined,
    inputs,
  );
  environment.watchProgress((evidence) =>
    store.saveProgress({
      ...evidence,
      runId,
      agentId,
      username,
      episode: 1,
      minecraftVersion: "1.18.1",
    }),
  );
  await environment.connect();
  await environment.reset({
    ...DEFAULT_AGENT_SETUP,
    spawn: { x: 0.5, y: -60, z: 0.5 },
    items: [
      { slot: 0, item: "minecraft:blaze_rod", count: 6 },
      { slot: 1, item: "minecraft:ender_pearl", count: 12 },
      { slot: 2, item: "minecraft:ender_eye", count: 12 },
    ],
  });
  store.saveAgents([{ ...agent, status: "active" }]);
  const reached = (id: string) =>
    store.progress(runId).find((s) => s.milestoneId === id)?.first;
  await until(
    () => reached("eyes-twelve")?.origin === "setup" && !!reached("rods-six"),
    "real setup inventory evidence",
  );
  assert(!reached("craft-eye"));
  const inputFrame = environment.observe(0).inputs!;
  assert.equal(Object.keys(inputFrame.channels).length, 0);
  console.log("PASS: tracking works independently of disabled policy inputs");
  const bot: Bot = (environment as unknown as { bot: Bot }).bot;
  let statistics = false;
  bot._client.on("statistics", () => {
    statistics = true;
  });
  bot._client.write("client_command", { actionId: 1 });
  await until(() => statistics, "real statistics baseline");
  const powder = minecraftData("1.18.1").itemsByName.blaze_powder;
  const recipe = bot.recipesFor(powder.id, null, 1, null)[0];
  assert(recipe);
  await bot.craft(recipe, 1);
  bot._client.write("client_command", { actionId: 1 });
  await until(
    () => reached("craft-powder")?.source === "statistic",
    "actual crafting statistic evidence",
  );
  server.command(
    `advancement grant ${username} only minecraft:story/follow_ender_eye`,
  );
  await until(
    () => reached("stronghold")?.source === "advancement",
    "real stronghold advancement packet",
  );
  server.command(
    'setblock 0 -58 3 spawner{SpawnData:{entity:{id:"minecraft:blaze"}},SpawnCount:0s}',
  );
  await bot.lookAt(new Vec3(0.5, -57.5, 3.5), true);
  await until(
    () => reached("blaze-seen")?.source === "server-event",
    "private Paper attribution and registered agent ownership",
  );
  server.command(
    `advancement grant ${username} only minecraft:end/kill_dragon`,
  );
  await until(
    () => reached("kill-dragon")?.source === "advancement",
    "real dragon advancement packet",
  );
  assert(!reached("credits"));
  server.command(`effect give ${username} minecraft:resistance 120 255 true`);
  server.command(
    "execute in minecraft:the_end run fill -2 79 -2 5 79 2 minecraft:bedrock",
  );
  server.command(`execute in minecraft:the_end run tp ${username} 0.5 80 0.5`);
  await until(
    () => !!reached("enter-end") && bot.game.dimension === "the_end",
    "real End dimension transition",
  );
  server.command(
    'execute in minecraft:the_end run summon minecraft:end_crystal 3.5 80 0.5 {Tags:["progress_fixture"]}',
  );
  await bot.lookAt(new Vec3(3.5, 81, 0.5), true);
  await until(
    () => reached("crystal")?.source === "server-event",
    "real visible End crystal attribution",
  );
  const crystal = Object.values(bot.entities).find(
    (entity) =>
      entity.name === "end_crystal" &&
      entity.position.distanceTo(bot.entity.position) < 5,
  );
  assert(crystal);
  bot.attack(crystal);
  await until(
    () => reached("destroy-crystals")?.source === "server-event",
    "actual player crystal destruction attribution",
  );
  server.command(`execute in minecraft:the_end run tp ${username} 0.5 80 0.5`);
  server.command(
    "execute in minecraft:the_end run setblock 0 80 0 minecraft:end_portal",
  );
  await until(
    () => !!reached("credits") && !!reached("return-end"),
    "real End exit win event and Overworld return",
  );
  await writeFile(
    resolve(fixture, "progress.json"),
    JSON.stringify(store.progress(runId), null, 2),
  );
  console.log(
    `PASS: real Minecraft 1.18.1 progression integration. Fixture: ${fixture}`,
  );
} catch (error) {
  console.log(
    JSON.stringify(
      {
        state: server.state,
        progress: store.progress(),
        agents: store.agents(),
        logs: store.logs(undefined, 25),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await environment?.close();
  await app.close();
}
