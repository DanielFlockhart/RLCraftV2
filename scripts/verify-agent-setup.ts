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
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import mineflayer, { type Bot } from "mineflayer";
import {
  DEFAULT_AGENT_SETUP,
  DEFAULT_TRAINING_RULES,
  DEFAULT_ARENA_SPEC,
  type AgentSetup,
  type ArenaSpec,
} from "@mlcraft/core";
import { arenaSpawn } from "../packages/core/src/arenas.js";
import { MinecraftEnvironment } from "@mlcraft/agents";
import { Store } from "../apps/control/src/store.js";
import { createApp } from "../apps/control/src/app.js";
import { config, root, token } from "../apps/control/src/config.js";

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
const testDir = await mkdtemp(join(runtime, "agent-setup-verification-"));
config.serverDir = testDir;
config.dataDir = resolve(testDir, "data");
config.artifactDir = resolve(testDir, "artifacts");
config.MC_PORT = port;
config.MC_MIN_MEMORY = "512M";
config.MC_MAX_MEMORY = "1G";
process.env.MC_PORT = String(port);
const { app, store, server } = createApp(new Store(":memory:"));
const headers = { authorization: `Bearer ${token}` };
const bots: Bot[] = [];
let environment: MinecraftEnvironment | undefined;
async function until(check: () => boolean, label: string, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function connect(username: string) {
  const bot = mineflayer.createBot({
    username,
    host: "127.0.0.1",
    port,
    version: "1.18.1",
    auth: "offline",
  });
  bots.push(bot);
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("Bot spawn timeout")), 30000);
    bot.once("spawn", () => {
      clearTimeout(timer);
      ok();
    });
    bot.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
  return bot;
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
    `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nlevel-name=setup-test\nlevel-type=flat\ndifficulty=peaceful\nview-distance=2\nsimulation-distance=2\nspawn-protection=0\nspawn-monsters=false\nspawn-animals=false\n`,
  );
  await app.ready();
  server.start();
  await until(
    () => {
      if (server.state.status === "failed") throw new Error(server.state.error);
      return server.state.status === "running" && !!server.state.setupReady;
    },
    "Paper/training plugin readiness",
    180000,
  );
  const viewer = await connect("ChilledVibe");
  viewer.physicsEnabled = false;
  const human = await connect("rl_observer");
  const humanBefore = human.inventory.slots.map((item) =>
    item ? [item.name, item.count] : null,
  );
  const setup: AgentSetup = {
    ...DEFAULT_AGENT_SETUP,
    health: 12,
    food: 14,
    experienceLevel: 3,
    heldSlot: 1,
    spawn: { x: 0.5, y: -60, z: 0.5 },
    items: [
      { slot: 0, item: "minecraft:iron_axe", count: 1 },
      { slot: 1, item: "minecraft:cooked_beef", count: 8 },
      { slot: 39, item: "minecraft:diamond_helmet", count: 1 },
      { slot: 40, item: "minecraft:shield", count: 1 },
    ],
  };
  environment = new MinecraftEnvironment(
    "rl_abcdef_0",
    { host: "127.0.0.1", port, version: "1.18.1", auth: "offline" },
    (value) => server.setupAgent(randomUUID(), "rl_abcdef_0", value),
  );
  await environment.connect();
  await environment.reset(setup);
  const initial = environment.observe(0);
  assert.deepEqual(initial.inventory, {
    iron_axe: 1,
    cooked_beef: 8,
    diamond_helmet: 1,
    shield: 1,
  });
  assert.equal(initial.health, 12);
  assert.equal(initial.food, 14);
  await environment.reset({
    ...setup,
    clearInventory: false,
    items: [{ slot: 2, item: "minecraft:stone", count: 16 }],
  });
  assert.equal(environment.observe(0).inventory.stone, 16);
  await environment.reset(setup);
  assert.equal(environment.observe(0).inventory.stone, undefined);
  const beforeInvalid = environment.observe(0).inventory;
  await assert.rejects(
    server.setupAgent(randomUUID(), "rl_abcdef_0", {
      ...setup,
      items: [{ slot: 0, item: "minecraft:diamond_sword", count: 64 }],
    }),
    /Invalid inventory/,
  );
  assert.deepEqual(environment.observe(0).inventory, beforeInvalid);
  const requestId = randomUUID();
  server.command(
    `rlcraftsetup ${requestId} ChilledVibe ${Buffer.from(JSON.stringify(DEFAULT_AGENT_SETUP)).toString("base64url")}`,
  );
  await until(
    () =>
      store
        .logs()
        .some((log) =>
          log.message.includes(`RLCRAFT_SETUP_ERROR ${requestId}`),
        ),
    "viewer rejection",
  );
  assert.equal(viewer.game.gameMode, "spectator");
  assert.deepEqual(
    human.inventory.slots.map((item) =>
      item ? [item.name, item.count] : null,
    ),
    humanBefore,
  );
  viewer.chat(`/rlcraftsetup ${randomUUID()} rl_abcdef_0 e30`);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(environment.observe(0).inventory, beforeInvalid);
  console.log(
    "PASS: exact inventory/armor/off-hand, vitals/XP/held slot/spawn, clear/preserve, invalid request atomicity and viewer/player isolation",
  );
  const response = await app.inject({
    method: "POST",
    url: "/runs",
    headers,
    payload: {
      stage: "wood_collection",
      mode: "minecraft",
      component: "pipeline",
      agents: 1,
      episodes: 2,
      ticksPerEpisode: 5,
      tickMs: 50,
      seed: 42,
      setup,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const run = response.json();
  await until(
    () => {
      const current = store.getRun(run.id)!;
      if (current.status === "failed") throw new Error(current.error);
      return current.status === "completed";
    },
    "managed worker run",
    45000,
  );
  const agent = store.agents(run.id)[0];
  assert.deepEqual(agent.inventory, initial.inventory);
  assert.equal(agent.reward, 0);
  const applications = store
    .logs(undefined, 1000)
    .filter((log) =>
      log.message.includes(`Starting setup applied to ${agent.username}`),
    );
  assert.equal(applications.length, 2);
  const artifact = JSON.parse(
    await readFile(resolve(config.artifactDir, run.id, "config.json"), "utf8"),
  );
  assert.deepEqual(artifact.spec.setup, setup);
  console.log(
    "PASS: real run admission -> worker IPC -> console plugin -> client synchronisation, episode reapplication, setup provenance and reward baseline",
  );
  assert.ok(server.state.arenaReady, "Updated arena plugin was not loaded");
  const arena: ArenaSpec = {
    ...structuredClone(DEFAULT_ARENA_SPEC),
    origin: { x: 64, y: -61, z: 64 },
    columns: 2,
    blueprint: {
      ...structuredClone(DEFAULT_ARENA_SPEC.blueprint),
      regions: [
        {
          from: { x: 0, y: 0, z: 0 },
          to: { x: 1, y: 2, z: 0 },
          block: "minecraft:oak_log",
        },
      ],
      containers: [
        {
          position: { x: 6, y: 0, z: 6 },
          block: "minecraft:barrel",
          items: [{ slot: 0, item: "minecraft:stone", count: 16 }],
        },
      ],
      entities: [{ position: { x: 2, y: 0, z: 4 }, type: "cow", count: 1 }],
    },
  };
  const arenaRun = await app.inject({
    method: "POST",
    url: "/runs",
    headers,
    payload: {
      stage: "wood_collection",
      mode: "minecraft",
      component: "pipeline",
      agents: 2,
      episodes: 2,
      ticksPerEpisode: 60,
      tickMs: 100,
      startPaused: true,
      seed: 42,
      setup: { ...setup, spawn: undefined },
      arena,
    },
  });
  assert.equal(arenaRun.statusCode, 201, arenaRun.body);
  const cageRun = arenaRun.json();
  await until(
    () => {
      const run = store.getRun(cageRun.id)!;
      if (run.status === "failed") throw new Error(run.error);
      return run.status === "paused";
    },
    "arena prepared and training initially paused",
    45000,
  );
  assert.equal(store.getRun(cageRun.id)!.timing!.tick, 0);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/runs/${cageRun.id}/playback`,
        headers,
        payload: { action: "speed", speed: 2 },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/runs/${cageRun.id}/playback`,
        headers,
        payload: { action: "advance", unit: "steps", value: 5 },
      })
    ).statusCode,
    200,
  );
  await until(
    () =>
      store.getRun(cageRun.id)!.status === "paused" &&
      store.getRun(cageRun.id)!.timing!.tick === 5,
    "five exact Minecraft training steps",
  );
  assert.ok(store.agents(cageRun.id).every((agent) => agent.ticks === 5));
  assert.equal(store.getRun(cageRun.id)!.playback!.speed, 2);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/runs/${cageRun.id}/resume`,
        headers,
        payload: {},
      })
    ).statusCode,
    200,
  );
  await until(
    () => {
      const run = store.getRun(cageRun.id)!;
      if (run.status === "failed") throw new Error(run.error);
      return (
        store.agents(cageRun.id).length === 2 &&
        store.agents(cageRun.id).every((agent) => (agent.position?.x ?? 0) > 60)
      );
    },
    "first arena observations",
    45000,
  );
  const overlap = await app.inject({
    method: "POST",
    url: "/runs",
    headers,
    payload: cageRun.spec,
  });
  assert.equal(overlap.statusCode, 400);
  assert.match(overlap.json().error, /overlaps/);
  server.command("setblock 62 -60 64 minecraft:gold_block");
  server.command("tp ChilledVibe 68.5 -58 68.5");
  const blockAt = (x: number, y: number, z: number) =>
    viewer.blockAt(viewer.entity.position.floored().set(x, y, z));
  await until(
    () => blockAt(65, -60, 65)?.name === "oak_log",
    "arena block preview",
  );
  server.command("data get block 71 -60 71 Items");
  await until(
    () =>
      store
        .logs(undefined, 1000)
        .some(
          (log) =>
            log.message.includes("minecraft:stone") &&
            log.message.includes("16b"),
        ),
    "stocked barrel",
  );
  server.command("setblock 65 -60 65 minecraft:dirt");
  server.command("data modify block 71 -60 71 Items set value []");
  server.command("kill @e[type=cow,x=64,y=-61,z=64,dx=8,dy=5,dz=8]");
  await until(
    () => {
      const run = store.getRun(cageRun.id)!;
      if (run.status === "failed") throw new Error(run.error);
      return run.status === "completed";
    },
    "per-episode arena rebuild",
    45000,
  );
  await until(
    () => blockAt(65, -60, 65)?.name === "oak_log",
    "resource restoration",
  );
  assert.equal(
    blockAt(62, -60, 64)?.name,
    "gold_block",
    "Outside sentinel was changed",
  );
  assert.equal(blockAt(64, -61, 64)?.name, "stone");
  assert.equal(blockAt(64, -60, 64)?.name, "glass");
  assert.equal(blockAt(68, -56, 68)?.name, "glass");
  const cages = store.agents(cageRun.id);
  cages.forEach((agent, index) => {
    const expected = arenaSpawn(arena, index);
    assert.ok(
      Math.abs(agent.position!.x - expected.x) < 0.8 &&
        Math.abs(agent.position!.z - expected.z) < 0.8,
      JSON.stringify(agent),
    );
    assert.deepEqual(agent.inventory, initial.inventory);
    assert.equal(agent.reward, 0);
  });
  assert.equal(
    store
      .logs(undefined, 2000)
      .filter((log) =>
        log.message.includes(`Training arena prepared for run ${cageRun.id}`),
      ).length,
    2,
  );
  server.command("data get block 71 -60 71 Items");
  await until(
    () =>
      store
        .logs(undefined, 2000)
        .filter(
          (log) =>
            log.message.includes("minecraft:stone") &&
            log.message.includes("16b"),
        ).length >= 2,
    "barrel restock",
  );
  assert.equal(
    Object.values(viewer.entities).filter(
      (entity) =>
        entity.name === "cow" &&
        entity.position.x >= 64 &&
        entity.position.x < 73 &&
        entity.position.z >= 64 &&
        entity.position.z < 73,
    ).length,
    1,
    "Configured cow was not restored",
  );
  const cageArtifact = JSON.parse(
    await readFile(
      resolve(config.artifactDir, cageRun.id, "config.json"),
      "utf8",
    ),
  );
  assert.deepEqual(cageArtifact.spec.arena, arena);
  assert.equal(viewer.game.gameMode, "spectator");
  assert.deepEqual(
    human.inventory.slots.map((item) =>
      item ? [item.name, item.count] : null,
    ),
    humanBefore,
  );
  const shared = await app.inject({
    method: "POST",
    url: "/runs",
    headers,
    payload: {
      ...cageRun.spec,
      component: "environment",
      startPaused: false,
      episodes: 1,
      arena: {
        ...arena,
        layout: "shared",
        origin: { x: 100, y: -61, z: 100 },
        blueprint: { ...arena.blueprint, entities: [] },
      },
    },
  });
  assert.equal(shared.statusCode, 201, shared.body);
  const sharedRun = shared.json();
  await until(
    () => {
      const run = store.getRun(sharedRun.id)!;
      if (run.status === "failed") throw new Error(run.error);
      return run.status === "completed";
    },
    "shared arena",
    45000,
  );
  for (const agent of store.agents(sharedRun.id))
    assert.ok(Math.abs(agent.position!.x - 104.5) < 0.8);
  console.log(
    "PASS: real per-agent/shared arenas, floor/walls/roof, resources, container restocking, mob respawn, episode rebuild, overlap guard, spawn synchronisation, outside/viewer isolation and recorded blueprint",
  );
  server.command("setblock 200 -61 200 minecraft:gold_block");
  server.command("tp rl_observer 204.5 -60 204.5");
  await until(
    () => Math.abs(human.entity.position.x - 204.5) < 0.8,
    "human occupancy",
  );
  await assert.rejects(
    server.prepareArena(
      randomUUID(),
      randomUUID(),
      { ...arena, origin: { x: 200, y: -61, z: 200 } },
      1,
    ),
    /Another player occupies/,
  );
  server.command(
    "execute if block 200 -61 200 minecraft:gold_block run say ARENA_OCCUPIED_PRESERVED",
  );
  await until(
    () =>
      store
        .logs()
        .some((log) => log.message.endsWith("ARENA_OCCUPIED_PRESERVED")),
    "occupied area preservation",
  );
  const cancelId = randomUUID();
  const cancelled = server.prepareArena(
    randomUUID(),
    cancelId,
    { ...arena, origin: { x: 300, y: -61, z: 300 } },
    1,
  );
  server.cancelArena(cancelId);
  await assert.rejects(cancelled, /cancelled/);
  console.log(
    "PASS: occupied arenas reject before mutation and cancelled arena work acknowledges cleanup",
  );
  // Default mode/setup must create visible players before their first training step.
  const lifecycleResponse = await app.inject({
    method: "POST",
    url: "/runs",
    headers,
    payload: {
      stage: "movement",
      agents: 2,
      episodes: 2,
      ticksPerEpisode: 10,
      tickMs: 100,
      startPaused: true,
    },
  });
  assert.equal(lifecycleResponse.statusCode, 201, lifecycleResponse.body);
  const lifecycle = lifecycleResponse.json();
  assert.equal(lifecycle.spec.mode, "minecraft");
  assert.deepEqual(lifecycle.spec.setup, DEFAULT_AGENT_SETUP);
  const liveRun = () => store.getRun(lifecycle.id)!;
  const liveAgents = () => store.agents(lifecycle.id);
  await until(
    () => {
      if (liveRun().status === "failed") throw new Error(liveRun().error);
      return liveRun().status === "paused" && liveAgents().length === 2;
    },
    "visible default Minecraft agents before first step",
    45000,
  );
  assert.ok(
    liveAgents().every(
      (agent) =>
        agent.ticks === 0 && agent.position && agent.status === "paused",
    ),
  );
  const starts = liveAgents().map((agent) => ({ ...agent.position! }));
  const names = liveAgents().map((agent) => agent.username);
  const watch = await app.inject({
    method: "POST",
    url: `/runs/${lifecycle.id}/watch`,
    headers,
    payload: { username: names[0] },
  });
  assert.equal(watch.statusCode, 200, watch.body);
  await until(
    () =>
      Object.values(viewer.entities).some(
        (entity) => entity.username === names[0],
      ),
    "viewer sees spawned agent",
  );
  const foreignWatch = await app.inject({
    method: "POST",
    url: `/runs/${lifecycle.id}/watch`,
    headers,
    payload: { username: "rl_ffffff_0" },
  });
  assert.equal(foreignWatch.statusCode, 400);
  server.command(`give ${names[0]} minecraft:diamond 3`);
  server.command(
    `tp ${names[0]} ${starts[0].x + 4} ${starts[0].y} ${starts[0].z + 4}`,
  );
  server.command(`kill ${names[0]}`);
  const advance = (unit: "steps" | "generation", value = 1) =>
    app.inject({
      method: "POST",
      url: `/runs/${lifecycle.id}/playback`,
      headers,
      payload: { action: "advance", unit, value },
    });
  assert.equal((await advance("steps")).statusCode, 200);
  await until(
    () =>
      liveRun().status === "paused" &&
      liveRun().timing!.tick === 1 &&
      liveAgents().some((agent) => agent.status === "dead"),
    "individual agent death preserves run",
  );
  assert.equal(
    liveAgents().filter((agent) => agent.status === "dead").length,
    1,
  );
  server.command(`kill ${names[1]}`);
  assert.equal((await advance("generation")).statusCode, 200);
  await until(
    () =>
      liveRun().status === "paused" &&
      liveRun().timing!.phase === "between" &&
      liveAgents().every((agent) => agent.status === "dead"),
    "all dead ends generation without failing",
  );
  const firstReport = JSON.parse(
    (
      await readFile(
        resolve(config.artifactDir, lifecycle.id, "episodes.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")[0],
  );
  assert.equal(firstReport.endedBy, "agents-dead");
  assert.equal((await advance("steps")).statusCode, 200);
  await until(
    () => {
      if (liveRun().status === "failed") throw new Error(liveRun().error);
      return (
        liveRun().status === "paused" &&
        liveRun().episode === 2 &&
        liveRun().timing!.tick === 1
      );
    },
    "next-generation respawn and starting-state restore",
    45000,
  );
  liveAgents().forEach((agent, index) => {
    assert.equal(agent.username, names[index]);
    assert.equal(agent.health, 20);
    assert.deepEqual(agent.inventory, {});
    assert.equal(agent.reward, 0);
    assert.ok(
      Math.abs(agent.position!.x - starts[index].x) < 0.8 &&
        Math.abs(agent.position!.z - starts[index].z) < 0.8,
      JSON.stringify(agent),
    );
  });
  assert.equal(viewer.game.gameMode, "spectator");
  assert.ok(
    !Object.values(viewer.entities).some((entity) => entity.name === "item"),
    "Training deaths leaked inventory drops",
  );
  const cancelledRun = await app.inject({
    method: "POST",
    url: `/runs/${lifecycle.id}/cancel`,
    headers,
    payload: {},
  });
  assert.equal(cancelledRun.statusCode, 200);
  await until(
    () =>
      liveAgents().every((agent) => agent.status === "stopped") &&
      names.every((name) => !viewer.players[name]),
    "cancel disconnects all owned players",
  );
  console.log(
    "PASS: default visible spawning, paused roster, viewer watch, individual/all-agent deaths, next-generation respawn/position/inventory reset and cancellation cleanup",
  );
  const experimentRules = {
    ...DEFAULT_TRAINING_RULES,
    noHungerLoss: true,
    creeperBlockDamage: false,
    creeperEntityDamage: false,
    fallDamage: false,
    pvp: false,
    difficulty: "hard" as const,
    world: {
      doDaylightCycle: false,
      doWeatherCycle: false,
      doMobSpawning: false,
      mobGriefing: true,
      naturalRegeneration: false,
      randomTickSpeed: 0,
    },
  };
  const rulesResponse = await app.inject({
    method: "POST",
    url: "/runs",
    headers,
    payload: {
      stage: "survival",
      agents: 2,
      episodes: 2,
      ticksPerEpisode: 50,
      tickMs: 100,
      startPaused: true,
      rules: experimentRules,
    },
  });
  assert.equal(rulesResponse.statusCode, 201, rulesResponse.body);
  const rulesRun = rulesResponse.json();
  const rulesAgents = () => store.agents(rulesRun.id);
  await until(
    () => {
      const run = store.getRun(rulesRun.id)!;
      if (run.status === "failed") throw new Error(run.error);
      return run.status === "paused" && rulesAgents().length === 2;
    },
    "game rules applied before agents spawn",
    45000,
  );
  const ruledAgent = rulesAgents()[0];
  const conflict = await app.inject({
    method: "POST",
    url: "/runs",
    headers,
    payload: {
      stage: "movement",
      rules: { ...experimentRules, difficulty: "easy" },
    },
  });
  assert.equal(conflict.statusCode, 400);
  assert.match(conflict.json().error, /World rules conflict/);
  await app.inject({
    method: "POST",
    url: `/runs/${rulesRun.id}/watch`,
    headers,
    payload: { username: ruledAgent.username },
  });
  await until(
    () => Math.abs(viewer.entity.position.x - ruledAgent.position!.x) < 1,
    "viewer near rules agent",
  );
  server.command(
    `effect give ${ruledAgent.username} minecraft:hunger 5 255 true`,
  );
  server.command("effect give rl_observer minecraft:hunger 5 255 true");
  await until(
    () => human.food < 20,
    "hunger remains active for unrelated player",
  );
  const point = ruledAgent.position!;
  const sentinel = {
    x: Math.floor(point.x) + 1,
    y: -60,
    z: Math.floor(point.z),
  };
  server.command(
    `setblock ${sentinel.x} ${sentinel.y} ${sentinel.z} minecraft:gold_block`,
  );
  server.command(
    `summon minecraft:creeper ${point.x} -60 ${point.z} {Fuse:0s,ignited:1b,ExplosionRadius:2b}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const stepRules = await app.inject({
    method: "POST",
    url: `/runs/${rulesRun.id}/playback`,
    headers,
    payload: { action: "advance", unit: "steps", value: 1 },
  });
  assert.equal(stepRules.statusCode, 200);
  await until(
    () =>
      store.getRun(rulesRun.id)!.status === "paused" &&
      store.getRun(rulesRun.id)!.timing!.tick === 1,
    "rules observation step",
  );
  assert.equal(
    rulesAgents().find((agent) => agent.username === ruledAgent.username)!.food,
    20,
  );
  assert.equal(
    rulesAgents().find((agent) => agent.username === ruledAgent.username)!
      .health,
    20,
  );
  assert.equal(
    viewer.blockAt(
      viewer.entity.position.floored().set(sentinel.x, sentinel.y, sentinel.z),
    )?.name,
    "gold_block",
  );
  server.command("gamerule doDaylightCycle");
  server.command("gamerule randomTickSpeed");
  server.command("difficulty");
  await until(
    () =>
      store
        .logs(undefined, 300)
        .some((log) => /doDaylightCycle.*false/.test(log.message)) &&
      store
        .logs(undefined, 300)
        .some((log) => /randomTickSpeed.*0/.test(log.message)) &&
      store
        .logs(undefined, 300)
        .some((log) => /difficulty.*Hard/i.test(log.message)),
    "native world rules and difficulty active",
  );
  const compatibleLease = randomUUID();
  await server.applyTrainingRules(
    randomUUID(),
    compatibleLease,
    { ...experimentRules, noHungerLoss: false },
    1,
  );
  await app.inject({
    method: "POST",
    url: `/runs/${rulesRun.id}/cancel`,
    headers,
    payload: {},
  });
  await until(
    () => rulesAgents().every((agent) => agent.status === "stopped"),
    "rules run cleanup",
  );
  assert.ok(
    existsSync(
      resolve(testDir, "plugins/RLCraftViewerGuard/training-world-rules.yml"),
    ),
    "Shared lease restored rules too early",
  );
  server.releaseTrainingRules(compatibleLease);
  await until(
    () =>
      !existsSync(
        resolve(testDir, "plugins/RLCraftViewerGuard/training-world-rules.yml"),
      ),
    "last lease restores original settings",
  );
  server.command("gamerule doDaylightCycle");
  server.command("gamerule randomTickSpeed");
  server.command("difficulty");
  await until(
    () =>
      store
        .logs(undefined, 30)
        .some((log) => /doDaylightCycle.*true/.test(log.message)) &&
      store
        .logs(undefined, 30)
        .some((log) => /randomTickSpeed.*3/.test(log.message)) &&
      store
        .logs(undefined, 30)
        .some((log) => /difficulty.*Peaceful/i.test(log.message)),
    "original native settings restored",
  );
  const configArtifact = JSON.parse(
    await readFile(
      resolve(config.artifactDir, rulesRun.id, "config.json"),
      "utf8",
    ),
  );
  assert.deepEqual(configArtifact.spec.rules, experimentRules);
  // Scoped keepInventory=false overrides a world's keepInventory=true without changing humans.
  server.command("gamerule keepInventory true");
  const dropResponse = await app.inject({
    method: "POST",
    url: "/runs",
    headers,
    payload: {
      stage: "movement",
      agents: 2,
      episodes: 2,
      ticksPerEpisode: 20,
      startPaused: true,
      setup: {
        ...DEFAULT_AGENT_SETUP,
        applyEachEpisode: false,
        items: [{ slot: 0, item: "minecraft:diamond", count: 3 }],
      },
      rules: { ...DEFAULT_TRAINING_RULES, keepInventory: false },
    },
  });
  assert.equal(dropResponse.statusCode, 201, dropResponse.body);
  const dropRun = dropResponse.json();
  await until(
    () => store.getRun(dropRun.id)!.status === "paused",
    "drop experiment ready",
  );
  const dropName = store.agents(dropRun.id)[0].username;
  await app.inject({
    method: "POST",
    url: `/runs/${dropRun.id}/watch`,
    headers,
    payload: { username: dropName },
  });
  server.command(`kill ${dropName}`);
  await app.inject({
    method: "POST",
    url: `/runs/${dropRun.id}/playback`,
    headers,
    payload: { action: "advance", unit: "steps", value: 1 },
  });
  await until(
    () =>
      store.getRun(dropRun.id)!.status === "paused" &&
      store.agents(dropRun.id).some((agent) => agent.status === "dead"),
    "inventory-off death",
  );
  await until(
    () =>
      Object.values(viewer.entities).some((entity) => entity.name === "item"),
    "inventory drops visible",
  );
  // Remove the drops in this isolated test so the respawned agent cannot pick them up.
  server.command(`execute at ${dropName} run kill @e[type=item,distance=..5]`);
  await app.inject({
    method: "POST",
    url: `/runs/${dropRun.id}/playback`,
    headers,
    payload: { action: "end-generation" },
  });
  await until(
    () => store.getRun(dropRun.id)!.timing!.phase === "between",
    "drop generation boundary",
  );
  await app.inject({
    method: "POST",
    url: `/runs/${dropRun.id}/playback`,
    headers,
    payload: { action: "advance", unit: "steps", value: 1 },
  });
  await until(
    () => {
      const run = store.getRun(dropRun.id)!;
      if (run.status === "failed") throw new Error(run.error);
      return (
        run.status === "paused" && run.episode === 2 && run.timing!.tick === 1
      );
    },
    "inventory-off respawn",
    45000,
  );
  assert.deepEqual(
    store.agents(dropRun.id).find((agent) => agent.username === dropName)!
      .inventory,
    {},
  );
  await app.inject({
    method: "POST",
    url: `/runs/${dropRun.id}/cancel`,
    headers,
    payload: {},
  });
  console.log(
    "PASS: agent hunger isolation, creeper block/entity protection, real world rules/difficulty, conflicts, shared lease restoration, rule provenance and inventory-off death/respawn",
  );
  await until(
    () => store.agents(dropRun.id).every((agent) => agent.status === "stopped"),
    "last worker cleanup before crash recovery test",
  );
  await environment.close();
  for (const bot of bots) bot.quit();
  const recoveryRun = randomUUID();
  await server.applyTrainingRules(
    randomUUID(),
    recoveryRun,
    experimentRules,
    1,
  );
  const recoveryFile = resolve(
    testDir,
    "plugins/RLCraftViewerGuard/training-world-rules.yml",
  );
  assert.ok(existsSync(recoveryFile));
  server.command("save-all flush");
  await until(
    () =>
      store
        .logs(undefined, 20)
        .some((log) => log.message.includes("Saved the game")),
    "overrides persisted before isolated Java crash",
  );
  assert.equal(config.serverDir, testDir);
  assert.ok(server.state.pid && server.hasProcess);
  process.kill(server.state.pid!, "SIGKILL");
  await until(() => !server.hasProcess, "isolated Java process exits");
  assert.ok(
    existsSync(recoveryFile),
    "Crash recovery journal must survive Java termination",
  );
  const blockedWorldChange = await app.inject({
    method: "POST",
    url: "/worlds",
    headers,
    payload: {
      name: "Blocked during rule recovery",
      settings: lifecycle.world.settings,
    },
  });
  assert.equal(blockedWorldChange.statusCode, 400);
  assert.match(
    blockedWorldChange.json().error,
    /restore interrupted experiment rules/,
  );
  server.start();
  await until(
    () => server.state.status === "running" && !!server.state.rulesReady,
    "plugin restart and crash recovery",
    180000,
  );
  assert.equal(existsSync(recoveryFile), false);
  server.command("gamerule doDaylightCycle");
  server.command("gamerule randomTickSpeed");
  await until(
    () =>
      store
        .logs(undefined, 20)
        .some((log) => /doDaylightCycle.*true/.test(log.message)) &&
      store
        .logs(undefined, 20)
        .some((log) => /randomTickSpeed.*3/.test(log.message)),
    "crashed overrides restored from journal",
  );
  console.log(
    "PASS: forced termination of isolated Java preserves recovery journal; next startup restores saved world rules",
  );
} catch (error) {
  console.error(
    store
      .logs(undefined, 80)
      .map((log) => log.message)
      .join("\n")
      .slice(-7000),
  );
  throw error;
} finally {
  await environment?.close();
  for (const bot of bots) bot.quit();
  await app.close();
  if (resolve(testDir).startsWith(runtime + sep))
    await rm(testDir, { recursive: true, force: true });
}
