import assert from "node:assert/strict";
import {
  DEFAULT_AGENT_SETUP,
  DEFAULT_ARENA_SPEC,
  DEFAULT_TRAINING_RULES,
  type AgentPreset,
  type RunSpec,
  type Snapshot,
  type ModelSnapshot,
} from "../packages/core/src/index.js";

// Exercises the actual dashboard -> remote runtime -> worker -> artifact path.
const origin = `http://127.0.0.1:${process.env.CLOUD_DASHBOARD_PORT ?? 3000}`;
const request = (path: string, init?: RequestInit) =>
  fetch(`${origin}/api/control/${path}`, {
    ...init,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
const invalid = await request("runs", {
  method: "POST",
  headers: { origin: "invalid", "content-type": "application/json" },
  body: "{}",
});
assert.equal(invalid.status, 403);
const snapshot = await request("snapshot");
assert.equal(snapshot.status, 200);
const state = (await snapshot.json()) as Snapshot;
const progression = await request("progress");
assert.equal(progression.status, 200);
assert.equal((await progression.json()).catalog.steps.length, 75);
const scopedProgress = await request(
  "progress?runId=11111111-1111-4111-8111-111111111111",
);
assert.equal(scopedProgress.status, 200);
assert.equal((await scopedProgress.json()).scope, "run");
assert.equal((await request("progress?runId=invalid")).status, 400);
const clients = await request("clients");
assert.equal(clients.status, 200);
assert.equal((await clients.json()).version, "1.18.1");
const missingFeed = await request(
  "runs/11111111-1111-4111-8111-111111111111/agents/rl_111111_0/feed",
);
assert.equal(missingFeed.status, 400);
assert.ok(state.archive);
const modelCatalog = await request("models");
assert.equal(modelCatalog.status, 200);
const modelPreview = await request("models/stage/movement?fresh=1");
assert.equal(modelPreview.status, 200, await modelPreview.clone().text());
const preview = (await modelPreview.json()) as ModelSnapshot;
assert.equal(preview.source, "configured");
assert.equal(preview.variants[0].inspection.parameters, 0);
assert.equal((await request("models/stage/invalid")).status, 404);
if (state.archive.provider === "local") {
  const disabledSync = await request("archive/sync", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(disabledSync.status, 400);
  assert.match(
    ((await disabledSync.json()) as { error: string }).error,
    /disabled/,
  );
}
const worlds = await request("worlds");
const backends = await request("backends");
assert.equal(backends.status, 200);
assert.ok(
  (await backends.json()).backends.some(
    (entry: any) => entry.descriptor.id === "mineflayer",
  ),
);
const inputs = await request("inputs/catalog.json");
assert.equal(inputs.status, 200);
assert.equal((await inputs.json()).clientboundPlayPackets.length, 104);
assert.equal(worlds.status, 200);
assert.ok(
  Array.isArray(((await worlds.json()) as { profiles: unknown[] }).profiles),
);
const invalidWorld = await request("worlds", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ name: "Invalid", settings: {} }),
});
assert.equal(invalidWorld.status, 400);
const headers = { origin, "content-type": "application/json" };
const catalog = await request("agent-presets");
assert.equal(catalog.status, 200);
const available = (await catalog.json()) as { items: { id: string }[] };
assert.ok(available.items.some((item) => item.id === "minecraft:iron_axe"));
const setup = {
  ...DEFAULT_AGENT_SETUP,
  items: [{ slot: 0, item: "minecraft:iron_axe", count: 1 }],
};
const created = await request("agent-presets", {
  method: "POST",
  headers,
  body: JSON.stringify({ name: "Cloud verification kit", setup }),
});
assert.equal(created.status, 200, await created.clone().text());
const preset = (await created.json()) as AgentPreset;
const updated = await request(`agent-presets/${preset.id}`, {
  method: "POST",
  headers,
  body: JSON.stringify({ name: "Updated cloud verification kit", setup }),
});
assert.equal(updated.status, 200);
const arenas = await request("arena-presets");
assert.equal(arenas.status, 200);
assert.ok(
  ((await arenas.json()) as { blocks: { id: string }[] }).blocks.some(
    (block) => block.id === "minecraft:glass",
  ),
);
const arenaPreset = await request("arena-presets", {
  method: "POST",
  headers,
  body: JSON.stringify({
    name: "Cloud verification cage",
    blueprint: DEFAULT_ARENA_SPEC.blueprint,
  }),
});
assert.equal(arenaPreset.status, 200, await arenaPreset.clone().text());
const arenaId = ((await arenaPreset.json()) as { id: string }).id;
assert.equal(
  (
    await request(`arena-presets/${arenaId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Updated verification cage",
        blueprint: DEFAULT_ARENA_SPEC.blueprint,
      }),
    })
  ).status,
  200,
);
assert.equal(
  (
    await request(`arena-presets/${arenaId}/delete`, {
      method: "POST",
      headers,
      body: "{}",
    })
  ).status,
  200,
);
const rules = {
  ...DEFAULT_TRAINING_RULES,
  noHungerLoss: true,
  keepInventory: false,
  world: { doDaylightCycle: false, randomTickSpeed: 0 },
};
const response = await request("runs", {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({
    stage: "movement",
    mode: "simulator",
    component: "pipeline",
    agents: 1,
    episodes: 1,
    ticksPerEpisode: 5,
    tickMs: 20,
    startPaused: true,
    seed: 42,
    setup,
    rules,
  }),
});
assert.equal(response.status, 201, await response.clone().text());
const run = (await response.json()) as { id: string };
async function untilStatus(status: string) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const res = await request(`runs/${run.id}`);
    const data = (await res.json()) as {
      run: { status: string; timing?: { tick: number } };
    };
    if (data.run.status === status) return data.run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Playback did not reach ${status}`);
}
await untilStatus("paused");
const inputAgent = await request(
  `runs/${run.id}/agents/rl_${run.id.slice(0, 6)}_0/inputs`,
);
assert.equal(inputAgent.status, 200, await inputAgent.clone().text());
assert.equal((await inputAgent.json()).schemaVersion, 1);
const liveModels = await request(`models/run/${run.id}`);
assert.equal(liveModels.status, 200, await liveModels.clone().text());
const inspected = (await liveModels.json()) as ModelSnapshot;
assert.equal(inspected.source, "runtime");
assert.equal(inspected.runId, run.id);
assert.equal(inspected.episode, 1);
assert.equal(inspected.tick, 0);
assert.equal(inspected.variants[0].inspection.status, "placeholder");
const watch = await request(`runs/${run.id}/watch`, {
  method: "POST",
  headers,
  body: JSON.stringify({ username: `rl_${run.id.slice(0, 6)}_0` }),
});
assert.equal(
  watch.status,
  400,
  "Watch must reach control through the production proxy and reject simulator agents",
);
assert.match((await watch.json()).error, /living Minecraft agent/);
const playback = await request(`runs/${run.id}/playback`, {
  method: "POST",
  headers,
  body: JSON.stringify({ action: "speed", speed: 2 }),
});
assert.equal(playback.status, 200, await playback.clone().text());
const advance = await request(`runs/${run.id}/playback`, {
  method: "POST",
  headers,
  body: JSON.stringify({ action: "advance", unit: "steps", value: 2 }),
});
assert.equal(advance.status, 200);
let stepped = false;
const stepDeadline = Date.now() + 10000;
while (Date.now() < stepDeadline) {
  const res = await request(`runs/${run.id}`);
  const detail = (await res.json()) as {
    run: { status: string; timing?: { tick: number } };
  };
  if (detail.run.status === "paused" && detail.run.timing?.tick === 2) {
    stepped = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
assert.ok(
  stepped,
  "Production proxy manual step did not pause after two steps",
);
assert.equal(
  (
    await request(`runs/${run.id}/resume`, {
      method: "POST",
      headers,
      body: "{}",
    })
  ).status,
  200,
);
let completed = false;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  const result = await request(`runs/${run.id}`);
  assert.equal(result.status, 200);
  const status = (
    (await result.json()) as { run: { status: string; error?: string } }
  ).run;
  assert.notEqual(status.status, "failed", status.error);
  if (status.status === "completed") {
    completed = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(completed, "Remote worker did not complete");
const modelArtifact = await request(`runs/${run.id}/artifacts/models.json`);
assert.equal(modelArtifact.status, 200);
const savedModels = (await modelArtifact.json()) as ModelSnapshot;
assert.equal(savedModels.episode, 1);
assert.equal(savedModels.tick, 5);
const artifact = await request(`runs/${run.id}/artifacts/checkpoint.json`);
const controlArtifact = await request(
  `runs/${run.id}/artifacts/controls.jsonl`,
);
assert.equal(controlArtifact.status, 200);
assert.ok((await controlArtifact.text()).includes('"advance"'));
assert.equal(artifact.status, 200);
assert.equal(((await artifact.json()) as { kind: string }).kind, "placeholder");
const config = await request(`runs/${run.id}/artifacts/config.json`);
assert.equal(config.status, 200);
const saved = (await config.json()) as { spec: RunSpec };
assert.deepEqual(saved.spec.setup, setup);
assert.deepEqual(saved.spec.rules, rules);
const deleted = await request(`agent-presets/${preset.id}/delete`, {
  method: "POST",
  headers,
  body: "{}",
});
assert.equal(deleted.status, 200);
const recorded = await request(`runs/${run.id}`);
assert.deepEqual(
  ((await recorded.json()) as { run: { spec: RunSpec } }).run.spec.setup,
  setup,
);
console.log(
  "PASS: dashboard proxy, Origin guard, remote credentials, preset CRUD, simulator execution and immutable setup artifact download.",
);
