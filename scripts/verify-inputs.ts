import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { config, root } from "../apps/control/src/config.js";
import { createApp } from "../apps/control/src/app.js";
import { Store } from "../apps/control/src/store.js";
import { loadBackendRegistry } from "@rlcraft/agents/backends";
import {
  defaultInputs,
  type AgentInputConfig,
  type AgentInputFrame,
  type Environment,
} from "@rlcraft/core";
const listener = createServer();
await new Promise<void>((yes) => listener.listen(0, "127.0.0.1", yes));
const address = listener.address();
if (!address || typeof address === "string") throw new Error("No test port");
const port = address.port;
await new Promise<void>((yes) => listener.close(() => yes()));
const original = config.serverDir,
  assetDirectory = resolve(config.dataDir, "observation-assets"),
  fixture = await mkdtemp(resolve(root, "runtime/input-verification-"));
config.serverDir = fixture;
config.dataDir = resolve(fixture, "data");
config.artifactDir = resolve(fixture, "artifacts");
config.MC_PORT = port;
config.MC_MIN_MEMORY = "512M";
config.MC_MAX_MEMORY = "1G";
const { app, server } = createApp(new Store(":memory:"));
let environment: Environment | undefined;
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 45000,
) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((yes) => setTimeout(yes, 50));
  }
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
    `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nlevel-type=flat\nlevel-name=input-world\ngenerate-structures=false\nview-distance=2\nsimulation-distance=2\nspawn-protection=0\nmax-players=100\n`,
  );
  await app.ready();
  server.start();
  await until(
    () => server.state.status === "running",
    "isolated Paper startup",
  );
  const profile: AgentInputConfig = structuredClone(defaultInputs);
  profile.channels["protocol.packets"].enabled = true;
  profile.channels["audio.pcm"].enabled = true;
  profile.channels["vision.rgb"].enabled = true;
  profile.channels["audio.capture"].enabled = true;
  const registry = await loadBackendRegistry();
  const backend = registry.select(
    {
      backend: "mineflayer",
      mode: "minecraft",
      stage: "movement",
      component: "environment",
      agents: 1,
      episodes: 1,
      ticksPerEpisode: 1,
      tickMs: 100,
      seed: 42,
    },
    "1.18.1",
  );
  environment = await registry.create(backend, {
    mode: "minecraft",
    runId: "input-verification",
    username: "rl_input_test",
    connection: { host: "127.0.0.1", port, version: "1.18.1", auth: "offline" },
    inputs: profile,
    assetDirectory,
    managed: {
      async applySetup() {
        throw new Error("Setup is not used in this sensor verification");
      },
      async moveToArena() {
        throw new Error("Arena is not used in this sensor verification");
      },
    },
  });
  await environment.connect();
  const sample = async () => (await environment!.observe(0)).inputs!;
  await until(
    async () => (await sample()).channels["vision.geometry"].status === "ready",
    "native geometry",
  );
  const first = await sample();
  assert.equal(first.channels["self.vitals"].status, "ready");
  assert.equal(first.channels["self.inventory"].status, "ready");
  assert.equal(first.channels["vision.rgb"].status, "unavailable");
  assert.equal(first.channels["audio.capture"].status, "unavailable");
  assert.ok((first.channels["protocol.packets"].data as any).events.length);
  assert.ok(!first.channels["server.exhaustion"]);
  await until(
    async () => (await sample()).channels["audio.pcm"].status === "ready",
    "vanilla sound assets",
  );
  server.command(
    "playsound minecraft:entity.player.levelup master rl_input_test ~ ~ ~ 1 1 1",
  );
  let loud: AgentInputFrame | undefined;
  await until(
    async () => {
      const current = await sample(),
        audio = current.channels["audio.pcm"];
      if (audio.status !== "ready") return false;
      const buffer = Buffer.from((audio.data as any).data, "base64");
      for (let i = 0; i < buffer.length; i += 4)
        if (Math.abs(buffer.readFloatLE(i)) > 0.00001) {
          loud = current;
          return true;
        }
      return false;
    },
    "real decoded sound waveform",
    10000,
  );
  assert.ok(loud);
  await environment.capture!({
    kind: "rgb",
    encoding: "rgb8",
    sequence: 1,
    capturedAt: Date.now(),
    width: 1,
    height: 1,
    data: Buffer.from([100, 150, 200]).toString("base64"),
  });
  assert.equal((await sample()).channels["vision.rgb"].status, "ready");
  await writeFile(
    resolve(fixture, "observation.json"),
    JSON.stringify(loud, null, 2),
  );
  console.log(
    `PASS: real Paper client state, incoming PLAY packets, native depth/semantics, unavailable capture indicators, decoded vanilla PCM and capture ingestion. Fixture: ${fixture}`,
  );
} finally {
  await environment?.close();
  await app.close();
}
