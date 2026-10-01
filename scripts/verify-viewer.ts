import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, cp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { createServer } from "node:net";
import mineflayer, { type Bot } from "mineflayer";
import type { Run } from "@mlcraft/core";
import { Store } from "../apps/control/src/store.js";
import { MinecraftServer } from "../apps/control/src/server.js";
import { config, root } from "../apps/control/src/config.js";
import { buildViewerPlugin } from "./build-viewer-plugin.js";

// Mineflayer exposes this runtime getter but currently omits it from Bot typings.
type HudBot = Bot & {
  bossBars: { title: { toString(): string }; health: number }[];
};

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((ok, fail) => {
    listener.once("error", fail);
    listener.listen(0, "127.0.0.1", ok);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>((ok) => listener.close(() => ok()));
  return port;
}
async function until(check: () => boolean, label: string, timeout = 10000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const original = config.serverDir;
const plugin = await buildViewerPlugin();
const runtime = resolve(root, "runtime");
await mkdir(runtime, { recursive: true });
const testDir = await mkdtemp(join(runtime, "viewer-verification-"));
const port = await availablePort();
const store = new Store(":memory:");
const bots: Bot[] = [];
const teamPackets = new Map<Bot, Map<string, string>>();
let previous = "";
const server = new MinecraftServer(store, () => {
  const log = store.logs(undefined, 1).at(-1);
  if (log && log.message !== previous) {
    previous = log.message;
    if (/ViewerGuard|Done \(|All dimensions|Server stopped/.test(log.message))
      console.log(log.message);
  }
});
async function connect(username: string) {
  const bot = mineflayer.createBot({
    host: "127.0.0.1",
    port,
    version: "1.18.1",
    auth: "offline",
    username,
  }) as HudBot;
  bots.push(bot);
  const teams = new Map<string, string>();
  teamPackets.set(bot, teams);
  bot._client.on(
    "teams",
    (packet: { team: string; mode: number; prefix?: unknown }) => {
      if (packet.mode === 1) teams.delete(packet.team);
      else if (packet.prefix !== undefined)
        teams.set(packet.team, JSON.stringify(packet.prefix));
    },
  );
  bot.on("error", (err) => console.error(username, err.message));
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`${username} did not spawn`)),
      30000,
    );
    bot.once("spawn", () => {
      clearTimeout(timer);
      ok();
    });
    bot.once("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
  });
  return bot;
}
function latestStatus(name: string) {
  return (
    store
      .logs()
      .filter((l) => l.message.includes(`ViewerGuard ${name} viewer=`))
      .at(-1)?.message ?? ""
  );
}
try {
  await copyFile(
    resolve(original, "server.jar"),
    resolve(testDir, "server.jar"),
  );
  // Reuse immutable bootstrap files; never copy or touch the actual training world.
  for (const directory of ["libraries", "cache", "versions"])
    if (existsSync(resolve(original, directory)))
      await cp(resolve(original, directory), resolve(testDir, directory), {
        recursive: true,
      });
  await mkdir(resolve(testDir, "plugins"));
  await copyFile(plugin, resolve(testDir, "plugins/RLCraftViewerGuard.jar"));
  await writeFile(resolve(testDir, "eula.txt"), "eula=true\n");
  await writeFile(
    resolve(testDir, "server.properties"),
    `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nlevel-name=viewer-test\nlevel-type=flat\ngamemode=survival\nspawn-protection=0\nview-distance=2\nsimulation-distance=2\nspawn-monsters=false\nspawn-animals=false\n`,
  );
  config.serverDir = testDir;
  config.MC_MIN_MEMORY = "512M";
  config.MC_MAX_MEMORY = "1G";
  server.start();
  await until(
    () => {
      if (server.state.status === "failed") throw new Error(server.state.error);
      return server.state.status === "running";
    },
    "Paper readiness",
    180000,
  );
  const agent = await connect("rl_test");
  const viewer = await connect("ChilledVibe");
  await until(
    () => viewer.game.gameMode === "spectator",
    "viewer spectator mode",
  );
  server.command("viewerguard ChilledVibe");
  await until(
    () => latestStatus("ChilledVibe").includes("spectatorChunks=false"),
    "viewer diagnostics",
  );
  for (const expected of [
    "viewer=true",
    "op=true",
    "mode=SPECTATOR",
    "collision=false",
    "pickup=false",
    "affectsSpawning=false",
    "sleepingIgnored=true",
  ])
    assert.ok(latestStatus("ChilledVibe").includes(expected), expected);
  server.command("tp ChilledVibe rl_test");
  server.command("gamemode creative ChilledVibe");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(viewer.game.gameMode, "spectator");
  server.command("deop ChilledVibe");
  await new Promise((r) => setTimeout(r, 1500));
  server.command("viewerguard ChilledVibe");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(latestStatus("ChilledVibe").includes("op=true"));
  const laterAgent = await connect("rl_later");
  await new Promise((r) => setTimeout(r, 500));
  server.command("tp rl_later rl_test");
  await until(
    () =>
      Object.values(laterAgent.entities).some((e) => e.username === "rl_test"),
    "agents see each other",
  );
  for (const bot of [agent, laterAgent])
    assert.ok(
      !Object.values(bot.entities).some((e) => e.username === "ChilledVibe"),
      "viewer hidden from agent entities",
    );
  server.command("viewerguard rl_test");
  await until(
    () => latestStatus("rl_test").includes("mode=SURVIVAL"),
    "agent unchanged",
  );
  assert.ok(latestStatus("rl_test").includes("op=false"));
  assert.ok(latestStatus("rl_test").includes("affectsSpawning=true"));
  assert.equal(server.state.hudReady, true);
  const timestamp = new Date().toISOString();
  const run: Run = {
    id: "abcdef12-1234-1234-1234-123456789abc",
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    episode: 3,
    progress: 0.25,
    spec: {
      stage: "wood_collection",
      mode: "minecraft",
      component: "pipeline",
      agents: 2,
      episodes: 10,
      ticksPerEpisode: 100,
      tickMs: 100,
      seed: 42,
    },
    timing: {
      sampledAt: Date.now(),
      totalElapsedMs: 125000,
      generationElapsedMs: 15000,
      lastGenerationMs: 20000,
      tick: 25,
      ticks: 100,
      phase: "training",
      advancing: true,
    },
  };
  const other: Run = {
    ...run,
    id: "12345678-1234-1234-1234-123456789abc",
    spec: { ...run.spec, stage: "movement" },
    updatedAt: new Date(Date.now() - 1000).toISOString(),
  };
  store.saveRun(run);
  store.saveRun(other);
  server.syncViewerHud();
  const line = (bot: Bot, text: string) =>
    [...teamPackets.get(bot)!.values()].some((v) => v.includes(text));
  await until(
    () =>
      line(viewer, "Generation: 3/10") &&
      line(viewer, "Total runtime: 0:02:05"),
    "live viewer sidebar",
  );
  await until(
    () =>
      viewer.bossBars.some((bar) =>
        bar.title.toString().includes("wood collection"),
      ),
    "viewer boss bar",
  );
  assert.ok(viewer.bossBars.some((bar) => Math.abs(bar.health - 0.25) < 0.001));
  assert.ok(line(viewer, "Previous gen: 0:00:20"));
  assert.equal(agent.bossBars.length, 0);
  assert.equal(laterAgent.bossBars.length, 0);
  assert.equal(agent.scoreboards.rlcraft_hud, undefined);
  assert.equal(laterAgent.scoreboards.rlcraft_hud, undefined);
  viewer.chat("/rlcrafthud next");
  await until(
    () => line(viewer, "Experiment: 12345678"),
    "manual experiment switch",
  );
  viewer.chat("/rlcrafthud abcdef12");
  await until(() => line(viewer, "Experiment: abcdef12"), "pinned experiment");
  run.status = "paused";
  run.timing!.advancing = false;
  run.updatedAt = new Date().toISOString();
  store.saveRun(run);
  server.syncViewerHud();
  await until(() => line(viewer, "Status: paused"), "paused HUD");
  await new Promise((r) => setTimeout(r, 1200));
  server.syncViewerHud();
  await until(
    () => line(viewer, "Gen elapsed: 0:00:15"),
    "generation timer frozen during pause",
  );
  viewer.chat("/rlcrafthud off");
  run.playback = {
    speed: 4,
    ticksPerGeneration: 100000,
    generationSeconds: 30,
  };
  run.timing!.trainingElapsedMs = 15000;
  store.saveRun(run);
  server.syncViewerHud();
  viewer.chat("/rlcrafthud on");
  viewer.chat("/rlcrafthud abcdef12");
  await until(
    () =>
      line(viewer, "Active limit: 0:00:30") &&
      line(viewer, "Pace: 4.00x / effective 2.00x"),
    "time budget and effective capped sampling HUD",
  );
  assert.ok(viewer.bossBars.some((bar) => Math.abs(bar.health - 0.5) < 0.001));
  viewer.chat("/rlcrafthud off");
  // Automatic selection follows a spectated agent even when another run is active.
  const trackedAgent = await connect("rl_123456_0");
  run.status = "running";
  run.updatedAt = new Date().toISOString();
  store.saveRun(run);
  server.syncViewerHud();
  viewer.chat("/rlcrafthud auto");
  await until(
    () => line(viewer, "Experiment: abcdef12"),
    "default active experiment",
  );
  server.command("spectate rl_123456_0 ChilledVibe");
  await until(
    () => line(viewer, "Experiment: 12345678"),
    "HUD follows spectated agent",
  );
  assert.equal(trackedAgent.bossBars.length, 0);
  assert.equal(trackedAgent.scoreboards.rlcraft_hud, undefined);
  viewer.chat("/spectate");
  viewer.chat("/rlcrafthud off");
  await until(
    () => viewer.bossBars.length === 0 && !viewer.scoreboards.rlcraft_hud,
    "HUD disable and scoreboard restoration",
  );
  viewer.chat("/rlcrafthud on");
  await until(
    () => !!viewer.scoreboards.rlcraft_hud && viewer.bossBars.length === 1,
    "HUD enable",
  );
  await until(
    () => line(viewer, "Control disconnected"),
    "stale control status",
    10000,
  );
  server.syncViewerHud();
  await until(() => line(viewer, "Live training state"), "control reconnect");
  viewer.quit();
  await until(
    () =>
      store.logs().some((l) => l.message.includes("ChilledVibe left the game")),
    "viewer disconnect",
  );
  const rejoined = await connect("ChilledVibe");
  await until(
    () => rejoined.game.gameMode === "spectator",
    "rejoin spectator protection",
  );
  server.syncViewerHud();
  await until(
    () => !!rejoined.scoreboards.rlcraft_hud && rejoined.bossBars.length === 1,
    "HUD restored after rejoin",
  );
  console.log(
    "PASS: viewer protection; personal sidebar and boss bar; generation progress/timers; multiple experiment selection; pause, hide/show, stale-control and reconnect; no HUD packets sent to agents.",
  );
} finally {
  for (const bot of bots) bot.quit();
  await server.stop();
  store.close();
  if (resolve(testDir).startsWith(runtime + sep))
    await rm(testDir, { recursive: true, force: true });
}
