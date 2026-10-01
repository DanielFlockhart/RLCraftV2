import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BackendRegistry,
  loadBackendRegistry,
} from "../packages/agents/src/backends/registry.js";
import { selectedEnvironment } from "../packages/agents/src/backends/selected.js";
import { StdioEnvironment } from "../packages/agents/src/backends/stdio.js";
import { parseBackendObservation } from "../packages/agents/src/backends/observation.js";
import type { BackendContext } from "../packages/agents/src/backends/contract.js";
import type {
  BackendDescriptor,
  Environment,
  Observation,
  RunSpec,
} from "@mlcraft/core";
import { defaultInputs, DEFAULT_AGENT_SETUP } from "@mlcraft/core";
const root = fileURLToPath(new URL("../", import.meta.url));
const spec: RunSpec = {
  mode: "simulator",
  stage: "movement",
  component: "pipeline",
  agents: 1,
  episodes: 2,
  ticksPerEpisode: 3,
  tickMs: 20,
  seed: 42,
};
function context(): BackendContext {
  const inputs: BackendContext["inputs"] = structuredClone(defaultInputs);
  for (const channel of Object.values(inputs.channels)) channel.enabled = false;
  inputs.channels["self.vitals"] = {
    enabled: true,
    intervalMs: 0,
    fields: ["health"],
  };
  return {
    mode: "simulator",
    runId: "test",
    username: "rl_test_0",
    connection: {
      host: "127.0.0.1",
      port: 25565,
      version: "1.18.1",
      auth: "offline",
    },
    inputs,
    assetDirectory: "unused",
    managed: { async applySetup() {}, async moveToArena() {} },
  };
}
const snapshot = (): Observation => ({
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  food: 20,
  inventory: {},
  tick: 0,
  inputs: {
    schemaVersion: 1,
    at: Date.now(),
    tick: 0,
    sequence: 0,
    channels: {
      "self.vitals": {
        status: "ready",
        source: "fixture",
        sampledAt: Date.now(),
        data: { health: 20, food: 20 },
      },
      "self.pose": {
        status: "ready",
        source: "fixture",
        sampledAt: Date.now(),
        data: { position: { x: 0, y: 64, z: 0 } },
      },
    },
    diagnostics: { droppedEvents: 0, droppedBytes: 0, eventBytes: 0 },
  },
});

test("registry rejects unknown, incompatible and changed backends and preserves capability selection", async () => {
  const registry = await loadBackendRegistry();
  assert.equal(registry.select(spec, "1.18.1").descriptor.id, "simulator");
  assert.throws(
    () => registry.select({ ...spec, backend: "unknown" }, "1.18.1"),
    /not registered/,
  );
  assert.throws(
    () => registry.select({ ...spec, backend: "mineflayer" }, "1.18.1"),
    /mode/,
  );
  const selected = registry.select(spec, "1.18.1");
  await assert.rejects(
    registry.create({ ...selected, revision: "changed" }, context()),
    /changed/,
  );
  const environment = await registry.create(selected, context());
  try {
    await environment.connect();
    const observation = await environment.observe(3);
    assert.deepEqual(Object.keys(observation.inputs!.channels), [
      "self.vitals",
    ]);
    assert.deepEqual(observation.inputs!.channels["self.vitals"].data, {
      health: 20,
    });
    await assert.rejects(
      environment.apply({ dig: true }),
      /does not support action/,
    );
  } finally {
    await environment.close();
  }
  const descriptor: BackendDescriptor = {
    ...selected.descriptor,
    id: "wrong-version",
    mode: "minecraft",
    minecraftVersions: ["1.21.1"],
    lifecycle: { reset: true, respawn: true, teleport: false, capture: false },
  };
  registry.register(descriptor, () => {
    throw new Error("must not construct");
  });
  assert.throws(
    () =>
      registry.select(
        { ...spec, mode: "minecraft", backend: descriptor.id },
        "1.18.1",
      ),
    /declare support/,
  );
  assert.throws(
    () =>
      registry.register(descriptor, () => {
        throw new Error("duplicate");
      }),
    /Duplicate/,
  );
});

test("common input boundary strips unselected channels/fields and marks missing data unavailable", async () => {
  const environment: Environment = {
    async connect() {},
    async close() {},
    async apply() {},
    async observe() {
      return snapshot();
    },
  };
  const inputs = context().inputs;
  inputs.channels["audio.capture"].enabled = true;
  const selected = selectedEnvironment(environment, inputs);
  const result = await selected.observe(7);
  assert.equal(result.tick, 7);
  assert.deepEqual(Object.keys(result.inputs!.channels), [
    "self.vitals",
    "audio.capture",
  ]);
  assert.deepEqual(result.inputs!.channels["self.vitals"].data, { health: 20 });
  assert.equal(result.inputs!.channels["audio.capture"].status, "unavailable");
  const bad = { ...snapshot(), inputs: undefined };
  environment.observe = () => bad;
  await assert.rejects(
    selected.observe(8) as Promise<Observation>,
    /schemaVersion/,
  );
});

test("manifest loads working TypeScript and process adapters without exposing transport configuration", async () => {
  const registry = await loadBackendRegistry(
    resolve(root, "examples/backends/backends.example.json"),
  );
  for (const id of ["module-simulator", "sidecar-simulator"]) {
    const selected = registry.select({ ...spec, backend: id }, "1.18.1");
    assert.ok(!JSON.stringify(registry.list()).includes('"stdio"'));
    assert.ok(!JSON.stringify(registry.list()).includes('"command":'));
    const environment = await registry.create(selected, context());
    try {
      await environment.connect();
      await environment.reset!({ ...DEFAULT_AGENT_SETUP, health: 12 });
      const result = await environment.observe(2);
      assert.deepEqual(result.inputs!.channels["self.vitals"].data, {
        health: 12,
      });
    } finally {
      await environment.close();
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "rlcraft-backend-manifest-"));
  try {
    const original = JSON.parse(
      await readFile(
        resolve(root, "examples/backends/backends.example.json"),
        "utf8",
      ),
    );
    original.backends[0].descriptor.id = "mineflayer";
    const path = join(dir, "duplicate.json");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, backends: [original.backends[0]] }),
    );
    await assert.rejects(loadBackendRegistry(path), /Duplicate/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const fixture = `import { createInterface } from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if (process.env.FIXTURE==='timeout') continue;
 if (process.env.FIXTURE==='oversize') { process.stdout.write('x'.repeat(4096)); continue; }
 if (process.env.FIXTURE==='invalid') { process.stdout.write('{}\\n'); continue; }
 let result=null;
 if (r.method==='observe') result={position:{x:0,y:64,z:0},health:20,food:20,inventory:{},tick:r.params.tick,inputs:{schemaVersion:1,at:Date.now(),tick:r.params.tick,sequence:r.id,channels:{'self.vitals':{status:'ready',sampledAt:Date.now(),source:'fixture',data:{health:20,controlTokenInherited:!!process.env.CONTROL_TOKEN}}},diagnostics:{droppedEvents:0,droppedBytes:0,eventBytes:0}}};
 process.stdout.write(JSON.stringify({protocol:1,id:r.id,result})+'\\n');
 if (r.method==='close') break;
}`;
test("sidecar RPC handles lifecycle hooks, isolates credentials and closes timed-out or invalid sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rlcraft-backend-rpc-"));
  const file = join(dir, "sidecar.mjs");
  const originalToken = process.env.CONTROL_TOKEN;
  process.env.CONTROL_TOKEN = "must-not-inherit";
  try {
    await writeFile(file, fixture);
    const ctx = context();
    ctx.mode = "minecraft";
    const calls: string[] = [];
    ctx.managed.applySetup = async () => {
      calls.push("setup");
    };
    ctx.managed.moveToArena = async () => {
      calls.push("arena");
    };
    const environment = new StdioEnvironment(ctx, {
      command: process.execPath,
      args: [file],
      cwd: dir,
      requestTimeoutMs: 1000,
    });
    try {
      await environment.connect();
      await environment.apply({});
      await environment.respawn();
      await environment.reset(DEFAULT_AGENT_SETUP);
      await environment.teleport({ x: 1, y: 64, z: 1 });
      assert.deepEqual(calls, ["setup", "arena"]);
      const frame = await environment.observe(5);
      assert.equal(
        (frame.inputs!.channels["self.vitals"].data as any)
          .controlTokenInherited,
        false,
      );
    } finally {
      await environment.close();
    }
    for (const mode of ["timeout", "invalid", "oversize"]) {
      const minimal = context();
      minimal.inputs.channels = {
        "self.vitals": minimal.inputs.channels["self.vitals"],
      };
      const failing = new StdioEnvironment(minimal, {
        command: process.execPath,
        args: [file],
        cwd: dir,
        env: { FIXTURE: mode },
        requestTimeoutMs: 250,
        maxMessageBytes: 2048,
      });
      try {
        await assert.rejects(
          failing.connect(),
          /timed out|envelope|byte limit/,
        );
      } finally {
        await failing.close();
      }
    }
  } finally {
    if (originalToken === undefined) delete process.env.CONTROL_TOKEN;
    else process.env.CONTROL_TOKEN = originalToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test("sidecar observations reject malformed schema, nonfinite state and stale frames", () => {
  assert.equal(parseBackendObservation(snapshot()).health, 20);
  assert.throws(() =>
    parseBackendObservation({ ...snapshot(), health: Infinity }),
  );
  const stale = snapshot();
  stale.inputs!.at -= 6000;
  assert.throws(() => parseBackendObservation(stale), /stale/);
  const invalid = snapshot();
  (invalid.inputs!.channels["self.vitals"] as any).status = "made-up";
  assert.throws(() => parseBackendObservation(invalid));
});
