import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { FabricEnvironment } from "../packages/agents/src/backends/fabric.js";
import { fabricRoot } from "../packages/runtime/src/fabric.js";
import {
  DEFAULT_AGENT_SETUP,
  DEFAULT_RENDER_SETTINGS,
  defaultInputs,
  type CaptureFrame,
  type AgentInputConfig,
} from "@rlcraft/core";
import { config, root, token } from "../apps/control/src/config.js";
import { createApp } from "../apps/control/src/app.js";
import { Store } from "../apps/control/src/store.js";

const listener = createServer();
await new Promise<void>((yes) => listener.listen(0, "127.0.0.1", yes));
const address = listener.address();
if (!address || typeof address === "string")
  throw new Error("No isolated port");
const port = address.port;
await new Promise<void>((yes) => listener.close(() => yes()));
const original = config.serverDir,
  originalData = config.dataDir,
  fixture = await mkdtemp(resolve(root, "runtime/fabric-verification-"));
process.env.FABRIC_DIR = fabricRoot(originalData);
config.serverDir = fixture;
config.dataDir = resolve(fixture, "data");
config.artifactDir = resolve(fixture, "artifacts");
config.MC_PORT = port;
process.env.MC_PORT = String(port);
config.MC_MIN_MEMORY = "512M";
config.MC_MAX_MEMORY = "1G";
const { app, server, store } = createApp(new Store(":memory:"));
let environment: FabricEnvironment | undefined;
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 30000,
) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (server.state.status === "failed") throw new Error(server.state.error);
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((yes) => setTimeout(yes, 100));
  }
  console.log(`PASS: ${label}`);
}
try {
  for (const file of ["server.jar", "eula.txt"])
    await copyFile(resolve(original, file), resolve(fixture, file));
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
    `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nlevel-type=flat\nlevel-name=fabric-test\ngenerate-structures=false\nview-distance=2\nsimulation-distance=2\nspawn-protection=0\nmax-players=100\nspawn-monsters=false\nspawn-animals=false\n`,
  );
  await app.ready();
  server.start();
  await until(
    () => server.state.status === "running" && !!server.state.setupReady,
    "isolated Paper startup",
    180000,
  );
  const runId = randomUUID(),
    username = `rl_${runId.slice(0, 6)}_0`,
    inputs = structuredClone(defaultInputs);
  for (const channel of Object.values(inputs.channels)) channel.enabled = false;
  inputs.channels["self.vitals"].enabled = true;
  inputs.channels["vision.rgb"].enabled = true;
  environment = new FabricEnvironment({
    mode: "minecraft",
    runId,
    username,
    connection: { host: "127.0.0.1", port, version: "1.18.1", auth: "offline" },
    inputs,
    render: { ...DEFAULT_RENDER_SETTINGS, width: 160, height: 120, fps: 5 },
    assetDirectory: resolve(originalData, "observation-assets"),
    managed: {
      applySetup: (setup) => server.setupAgent(randomUUID(), username, setup),
      moveToArena: async () => {
        throw new Error("Arena unused in this fixture");
      },
    },
  });
  const evidence: any[] = [];
  environment.watchProgress((e) => evidence.push(e));
  await environment.connect();
  console.log(
    "PASS: real Fabric game client connects using its own player session",
  );
  const setup = {
    ...DEFAULT_AGENT_SETUP,
    spawn: { x: 0.5, y: -60, z: 0.5 },
    items: [{ slot: 0, item: "minecraft:oak_log", count: 3 }],
  };
  await environment.reset(setup);
  await until(async () => {
    const o = await environment!.observe(0);
    return o.inventory.oak_log === 3 && Math.abs(o.position.x - 0.5) < 0.2;
  }, "managed inventory and position reset");
  let frame: CaptureFrame | undefined;
  await until(async () => {
    frame = await environment!.feed();
    return !!frame;
  }, "fresh real framebuffer RGB capture");
  assert.equal(frame!.width, 160);
  assert.equal(frame!.height, 120);
  assert.equal(Buffer.from(frame!.data, "base64").length, 160 * 120 * 3);
  const colors = new Set(Buffer.from(frame!.data, "base64"));
  assert(colors.size > 16, "Framebuffer must have actual visual content");
  await writeFile(
    resolve(fixture, "camera.ppm"),
    Buffer.concat([
      Buffer.from("P6\n160 120\n255\n"),
      Buffer.from(frame!.data, "base64"),
    ]),
  );
  const first = await environment.observe(0);
  assert.equal(
    first.inputs!.channels["vision.rgb"].source,
    "vanilla-framebuffer",
  );
  await environment.apply({
    look: { yaw: 0, pitch: 0 },
    controls: { forward: true },
  });
  await new Promise((yes) => setTimeout(yes, 600));
  await environment.apply({ controls: {} });
  const moved = await environment.observe(1);
  assert(
    moved.position.z < first.position.z - 0.1,
    "Real client should move toward -Z for common yaw zero",
  );
  console.log("PASS: real player movement and common camera-angle convention");
  const before = (await environment.feed())!.sequence;
  await until(
    async () => (await environment!.feed())!.sequence > before,
    "camera feed advances independently of training steps",
  );
  await environment.reset(setup);
  await until(async () => {
    const o = await environment!.observe(0);
    return Math.abs(o.position.z - 0.5) < 0.2 && o.inventory.oak_log === 3;
  }, "generation reset reuses the same connected client");
  assert(evidence.some((e) => e.milestoneId === "wood"));
  await writeFile(
    resolve(fixture, "verification.json"),
    JSON.stringify(
      { frame: { ...frame, data: "omitted" }, first, moved, evidence },
      null,
      2,
    ),
  );
  console.log(`PASS: Fabric client integration. Fixture: ${fixture}`);
  await environment.close();
  environment = undefined;
  const headers = { authorization: `Bearer ${token}` };
  const masked: AgentInputConfig = structuredClone(inputs);
  masked.channels["vision.rgb"].enabled = false;
  masked.channels["self.inventory"].enabled = true;
  masked.channels["self.inventory"].fields = ["quickBarSlot", "heldItem"];
  const queued = await app.inject({
    method: "POST",
    url: "/runs",
    headers,
    payload: {
      backend: "fabric",
      mode: "minecraft",
      stage: "movement",
      agents: 1,
      episodes: 2,
      ticksPerEpisode: 5,
      tickMs: 100,
      startPaused: true,
      setup,
      inputs: masked,
      render: { ...DEFAULT_RENDER_SETTINGS, width: 96, height: 72, fps: 5 },
    },
  });
  assert.equal(queued.statusCode, 201, queued.body);
  const managedId = queued.json().id,
    managedName = `rl_${managedId.slice(0, 6)}_0`;
  await until(
    () => {
      const run = store.getRun(managedId);
      if (run?.status === "failed") throw new Error(run.error);
      return run?.status === "paused";
    },
    "scheduler launches and pauses real Fabric run",
    120000,
  );
  const path = `/runs/${managedId}/agents/${managedName}`;
  const observation = await app.inject({ url: `${path}/inputs`, headers });
  assert.equal(observation.statusCode, 200, observation.body);
  assert(!observation.json().channels["vision.rgb"]);
  assert.deepEqual(
    Object.keys(observation.json().channels["self.inventory"].data).sort(),
    ["heldItem", "quickBarSlot"],
  );
  let feed: any;
  await until(async () => {
    const response = await app.inject({ url: `${path}/feed`, headers });
    assert.equal(response.statusCode, 200, response.body);
    feed = response.json();
    return feed.status === "ready";
  }, "authenticated worker feed works while policy RGB is disabled");
  assert.equal(feed.frame.width, 96);
  const number = feed.frame.sequence;
  await until(async () => {
    const response = await app.inject({ url: `${path}/feed`, headers });
    return response.json().frame?.sequence > number;
  }, "paused training still has a live dashboard camera");
  const advance = await app.inject({
    method: "POST",
    url: `/runs/${managedId}/resume`,
    headers,
    payload: {},
  });
  assert.equal(advance.statusCode, 200, advance.body);
  await until(
    () => store.getRun(managedId)?.status === "completed",
    "real Fabric generation pipeline completes and resets",
    30000,
  );
  await until(
    () =>
      !server.hasProcess ||
      store.agents(managedId).every((agent) => agent.status === "stopped"),
    "completed run disconnects owned Fabric agents",
    15000,
  );
  console.log(
    "PASS: worker IPC, authenticated feed API, policy field masking and generation lifecycle",
  );
} finally {
  await environment?.close();
  await app.close();
}
