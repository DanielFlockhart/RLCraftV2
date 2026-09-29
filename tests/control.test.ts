import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const dir = await mkdtemp(join(tmpdir(), "rlcraft-v2-test-"));
process.env.DATA_DIR = dir;
process.env.SERVER_DIR = join(dir, "server");
process.env.ARTIFACT_DIR = join(dir, "separate-artifact-volume");
process.env.MAX_CONCURRENT_RUNS = "1";
process.env.MAX_AGENTS = "4";
process.env.AGENT_BACKENDS_FILE = fileURLToPath(
  new URL("../examples/backends/backends.example.json", import.meta.url),
);
const { createApp } = await import("../apps/control/src/app.js");
const { Store } = await import("../apps/control/src/store.js");
const { token } = await import("../apps/control/src/config.js");
const { DEFAULT_AGENT_SETUP } = await import("@rlcraft/core");
const { app, store, server, worlds } = createApp(
  new Store(join(dir, "test.sqlite")),
);
const headers = { authorization: `Bearer ${token}` };
before(async () => {
  await app.ready();
});
after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});
const post = (url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url, headers, payload });
async function waitFor(id: string, status: string, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const run = store.getRun(id);
    if (run?.status === status) return run;
    if (run?.status === "failed") throw new Error(run.error);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out waiting for ${status}: ${JSON.stringify(store.getRun(id))}`,
  );
}
const base = {
  stage: "movement",
  mode: "simulator",
  agents: 2,
  episodes: 2,
  ticksPerEpisode: 5,
  tickMs: 20,
  seed: 42,
};
test("dataset API authenticates and exposes only registered generators", async () => {
  assert.equal(
    (await app.inject({ method: "GET", url: "/datasets" })).statusCode,
    401,
  );
  const res = await app.inject({ method: "GET", url: "/datasets", headers });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().generators[0].id, "phase1a");
  assert.equal(res.json().generators[0].script, undefined);
  assert.equal(
    (await post("/datasets", { generatorId: "unregistered-script" }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await post("/datasets", {
        generatorId: "phase1a",
        parameters: { seed: -1 },
      })
    ).statusCode,
    400,
  );
  assert.equal((await post("/datasets/not-an-id/cancel")).statusCode, 400);
});
test(
  "dataset API generates downloadable results and reruns into a new version",
  {
    skip:
      spawnSync(
        process.env.PYTHON_PATH ??
          (process.platform === "win32" ? "python" : "python3"),
        ["--version"],
      ).status !== 0,
  },
  async () => {
    const created = await post("/datasets", {
      generatorId: "phase1a",
      parameters: { trainSize: 8, validationSize: 2, testSize: 2, oodSize: 1 },
    });
    assert.equal(created.statusCode, 200);
    const id = created.json().id;
    const deadline = Date.now() + 15000;
    let job;
    do {
      await new Promise((r) => setTimeout(r, 50));
      const state = await app.inject({
        method: "GET",
        url: "/datasets",
        headers,
      });
      job = state.json().jobs.find((item: { id: string }) => item.id === id);
    } while (job.status === "running" && Date.now() < deadline);
    assert.equal(job.status, "completed", job.error);
    const download = `/datasets/${id}/artifacts/train.csv`;
    assert.equal(
      (await app.inject({ method: "GET", url: download })).statusCode,
      401,
    );
    const csv = await app.inject({ method: "GET", url: download, headers });
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers["content-type"]), /text\/csv/);
    assert.match(String(csv.headers["content-disposition"]), /attachment/);
    assert.equal(csv.body.trim().split("\n").length, 9);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/datasets/${id}/artifacts/job.json`,
          headers,
        })
      ).statusCode,
      400,
    );
    const repeat = await post(`/datasets/${id}/rerun`);
    assert.equal(repeat.statusCode, 200);
    assert.notEqual(repeat.json().id, id);
    await post(`/datasets/${repeat.json().id}/cancel`);
  },
);
test("Progress API is authenticated, complete, filterable and rejects invalid scope", async () => {
  assert.equal(
    (await app.inject({ method: "GET", url: "/progress" })).statusCode,
    401,
  );
  const res = await app.inject({ method: "GET", url: "/progress", headers });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().catalog.steps.length, 75);
  assert.equal(res.json().scope, "all-runs");
  assert.equal(res.json().supportedVersion, true);
  assert.equal(res.json().attributionReady, false);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/progress?runId=invalid",
        headers,
      })
    ).statusCode,
    400,
  );
  const empty = await app.inject({
    method: "GET",
    url: "/progress?runId=11111111-1111-4111-8111-111111111111",
    headers,
  });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().scope, "run");
  assert.deepEqual(empty.json().summaries, []);
});
test("client preparation and live feed routes require authentication and valid active ownership", async () => {
  assert.equal((await app.inject({ url: "/clients" })).statusCode, 401);
  const clients = await app.inject({ url: "/clients", headers });
  assert.equal(clients.statusCode, 200);
  assert.equal(clients.json().version, "1.18.1");
  assert.equal(clients.json().maxClients, 2);
  const route =
    "/runs/11111111-1111-4111-8111-111111111111/agents/rl_111111_0/feed";
  assert.equal((await app.inject({ url: route })).statusCode, 401);
  assert.equal((await app.inject({ url: route, headers })).statusCode, 400);
  assert.equal(
    (
      await app.inject({
        url: route.replace("rl_111111_0", "ChilledVibe"),
        headers,
      })
    ).statusCode,
    400,
  );
  const over = await post("/runs", {
    ...base,
    mode: "minecraft",
    backend: "fabric",
    agents: 3,
  });
  assert.equal(over.statusCode, 400);
  assert.match(over.json().error, /renderer capacity/);
});
test("backend catalog is authenticated and module/sidecar swaps run through the same worker lifecycle", async () => {
  assert.equal((await app.inject({ url: "/backends" })).statusCode, 401);
  const response = await app.inject({ url: "/backends", headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response
      .json()
      .backends.map((entry: any) => entry.descriptor.id)
      .sort(),
    [
      "fabric",
      "mineflayer",
      "module-simulator",
      "sidecar-simulator",
      "simulator",
    ],
  );
  assert.equal(
    (await post("/runs", { ...base, backend: "not-installed" })).statusCode,
    400,
  );
  assert.equal(
    (await post("/runs", { ...base, backend: "mineflayer" })).statusCode,
    400,
  );
  assert.equal(
    (
      await post("/runs", {
        ...base,
        backend: "simulator",
        module: "untrusted.js",
      })
    ).statusCode,
    400,
  );
  for (const backend of ["module-simulator", "sidecar-simulator"]) {
    const createdResponse = await post("/runs", {
      ...base,
      backend,
      agents: 1,
      episodes: 2,
      ticksPerEpisode: 2,
      setup: {
        ...DEFAULT_AGENT_SETUP,
        items: [{ item: "minecraft:stone", count: 4, slot: 0 }],
      },
    });
    assert.equal(createdResponse.statusCode, 201, createdResponse.body);
    const created = createdResponse.json();
    await waitFor(created.id, "completed");
    const artifact = await app.inject({
      url: `/runs/${created.id}/artifacts/config.json`,
      headers,
    });
    assert.equal(artifact.json().spec.backend, backend);
    assert.equal(artifact.json().backend.descriptor.id, backend);
    assert.match(artifact.json().backend.revision, /^[a-f0-9]{64}$/);
    assert.ok(
      store
        .logs(created.id)
        .some((entry) => entry.message.includes("Agent backend:")),
    );
  }
});
test("model endpoints inspect registered factories and persist actual runtime snapshots", async () => {
  assert.equal((await app.inject({ url: "/models" })).statusCode, 401);
  assert.equal(
    (await app.inject({ url: "/models/stage/unknown", headers })).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ url: "/models/run/invalid", headers })).statusCode,
    404,
  );
  const previewResponse = await app.inject({
    url: "/models/stage/movement",
    headers,
  });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  const preview = previewResponse.json();
  assert.equal(preview.source, "configured");
  assert.match(preview.codeVersion, /^[a-f0-9]{64}$/);
  assert.equal(preview.variants[0].inspection.parameters, 0);
  assert.equal(preview.variants[0].inspection.status, "placeholder");
  const created = (await post("/runs", { ...base, startPaused: true })).json();
  await waitFor(created.id, "paused");
  const live = await app.inject({ url: `/models/run/${created.id}`, headers });
  assert.equal(live.statusCode, 200, live.body);
  const snapshot = live.json();
  assert.equal(snapshot.source, "runtime");
  assert.equal(snapshot.runId, created.id);
  assert.equal(snapshot.episode, 1);
  assert.equal(snapshot.tick, 0);
  assert.equal(snapshot.variants[0].agents.length, 2);
  assert.equal(snapshot.variants[1].role, "trainer");
  const artifact = await app.inject({
    url: `/runs/${created.id}/artifacts/models.json`,
    headers,
  });
  assert.equal(artifact.statusCode, 200);
  assert.deepEqual(artifact.json().variants, snapshot.variants);
  await post(`/runs/${created.id}/cancel`);
  await waitUntil(
    () =>
      !store
        .agents()
        .some(
          (agent) => agent.runId === created.id && agent.status !== "stopped",
        ),
    "model worker shutdown",
  );
  const recovered = createApp(new Store(join(dir, "test.sqlite")));
  try {
    const fromDisk = await recovered.app.inject({
      url: `/models/run/${created.id}`,
      headers,
    });
    assert.equal(fromDisk.statusCode, 200, fromDisk.body);
    assert.deepEqual(fromDisk.json().variants, snapshot.variants);
    const currentPreview = await recovered.app.inject({
      url: "/models/stage/movement?fresh=1",
      headers,
    });
    assert.equal(currentPreview.statusCode, 200);
    const stillHistorical = await recovered.app.inject({
      url: `/models/run/${created.id}`,
      headers,
    });
    assert.deepEqual(
      stillHistorical.json(),
      fromDisk.json(),
      "current model preview must not replace a saved runtime model",
    );
  } finally {
    await recovered.app.close();
  }
});
test("selected inputs reach agents and recordings without leaking unselected fields", async () => {
  const { defaultInputs } = await import("@rlcraft/core");
  const profile: import("@rlcraft/core").AgentInputConfig =
    structuredClone(defaultInputs);
  for (const channel of Object.values(profile.channels))
    channel.enabled = false;
  profile.channels["self.vitals"] = {
    enabled: true,
    intervalMs: 0,
    fields: ["health"],
  };
  profile.record = true;
  const catalog = await app.inject({ url: "/inputs/catalog.json", headers });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().clientboundPlayPackets.length, 104);
  assert.equal(
    (
      await post("/runs", {
        ...base,
        inputs: {
          ...profile,
          channels: { unknown: { enabled: true, intervalMs: 0 } },
        },
      })
    ).statusCode,
    400,
  );
  const run = (
    await post("/runs", {
      ...base,
      agents: 1,
      startPaused: true,
      inputs: profile,
    })
  ).json();
  await waitFor(run.id, "paused");
  const username = store.agents(run.id)[0].username;
  const frame = await app.inject({
    url: `/runs/${run.id}/agents/${username}/inputs`,
    headers,
  });
  assert.equal(frame.statusCode, 200, frame.body);
  assert.deepEqual(frame.json().channels["self.vitals"].data, { health: 20 });
  assert.deepEqual(Object.keys(frame.json().channels), ["self.vitals"]);
  assert.equal(
    (
      await app.inject({
        url: `/runs/${run.id}/agents/ChilledVibe/inputs`,
        headers,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await post(`/runs/${run.id}/agents/${username}/capture`, {
        kind: "rgb",
        encoding: "rgb8",
        sequence: 1,
        capturedAt: Date.now(),
        width: 10,
        height: 10,
        data: "AAAA",
      })
    ).statusCode,
    400,
  );
  await post(`/runs/${run.id}/resume`);
  await waitFor(run.id, "completed");
  const recorded = await app.inject({
    url: `/runs/${run.id}/artifacts/inputs.jsonl`,
    headers,
  });
  assert.equal(recorded.statusCode, 200);
  const events = recorded.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(events.length);
  assert.ok(
    events.every(
      (event) =>
        Object.keys(event.frame.channels).length === 1 && !event.frame.health,
    ),
  );
  const saved = await app.inject({
    url: `/runs/${run.id}/artifacts/config.json`,
    headers,
  });
  assert.deepEqual(saved.json().spec.inputs, profile);
});
async function waitUntil(check: () => boolean, label: string, timeout = 15000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
test("manual playback advances exact steps across generations, edits limits live, and ends partial generations", async () => {
  const run = (
    await post("/runs", {
      ...base,
      agents: 1,
      episodes: 4,
      ticksPerEpisode: 8,
      tickMs: 40,
      startPaused: true,
    })
  ).json();
  await waitFor(run.id, "paused");
  assert.equal(store.getRun(run.id)!.timing!.tick, 0);
  assert.equal(
    (await post(`/runs/${run.id}/playback`, { action: "speed", speed: 2 }))
      .statusCode,
    200,
  );
  assert.equal(store.getRun(run.id)!.playback!.speed, 2);
  assert.equal(
    (
      await post(`/runs/${run.id}/playback`, {
        action: "advance",
        unit: "steps",
        value: 3,
      })
    ).statusCode,
    200,
  );
  await waitUntil(
    () =>
      store.getRun(run.id)!.status === "paused" &&
      store.getRun(run.id)!.timing!.tick === 3,
    "three exact manual steps",
  );
  assert.equal(store.agents(run.id)[0].ticks, 3);
  assert.equal(
    (
      await post(`/runs/${run.id}/playback`, {
        action: "length",
        unit: "steps",
        value: 4,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await post(`/runs/${run.id}/playback`, {
        action: "advance",
        unit: "steps",
        value: 3,
      })
    ).statusCode,
    200,
  );
  await waitUntil(
    () =>
      store.getRun(run.id)!.status === "paused" &&
      store.getRun(run.id)!.episode === 2 &&
      store.getRun(run.id)!.timing!.tick === 2,
    "step budget crossing generation boundary",
  );
  assert.equal(store.agents(run.id)[0].ticks, 6);
  assert.equal(
    (await post(`/runs/${run.id}/playback`, { action: "end-generation" }))
      .statusCode,
    200,
  );
  await waitUntil(
    () =>
      store.getRun(run.id)!.status === "paused" &&
      store.getRun(run.id)!.timing!.phase === "between",
    "partial generation finished",
  );
  assert.equal(store.getRun(run.id)!.episode, 2);
  assert.equal(
    (
      await post(`/runs/${run.id}/playback`, {
        action: "advance",
        unit: "generation",
        value: 1,
      })
    ).statusCode,
    200,
  );
  await waitUntil(
    () =>
      store.getRun(run.id)!.status === "paused" &&
      store.getRun(run.id)!.episode === 3 &&
      store.getRun(run.id)!.timing!.phase === "between",
    "generation boundary pause",
  );
  assert.equal(store.agents(run.id)[0].ticks, 10);
  assert.equal(
    (
      await post(`/runs/${run.id}/playback`, {
        action: "length",
        unit: "seconds",
        value: 0.15,
      })
    ).statusCode,
    200,
  );
  assert.equal((await post(`/runs/${run.id}/resume`)).statusCode, 200);
  await waitFor(run.id, "completed");
  const artifact = await app.inject({
    url: `/runs/${run.id}/artifacts/episodes.jsonl`,
    headers,
  });
  const rows = artifact.body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows[1].endedBy, "manual");
  assert.equal(rows[1].steps, 2);
  assert.ok(rows[3].trainingElapsedMs >= 150);
  const controls = await app.inject({
    url: `/runs/${run.id}/artifacts/controls.jsonl`,
    headers,
  });
  assert.equal(controls.statusCode, 200);
  assert.ok(controls.body.includes('"end-generation"'));
  assert.equal(
    (await post(`/runs/${run.id}/playback`, { action: "speed", speed: 1 }))
      .statusCode,
    400,
  );
});
test("manual time increments auto-pause and live time limits exclude acknowledged pauses", async () => {
  const run = (
    await post("/runs", {
      ...base,
      agents: 1,
      episodes: 1,
      generationSeconds: 0.4,
      startPaused: true,
      tickMs: 20,
    })
  ).json();
  await waitFor(run.id, "paused");
  assert.equal(
    (
      await post(`/runs/${run.id}/playback`, {
        action: "advance",
        unit: "seconds",
        value: 0.1,
      })
    ).statusCode,
    200,
  );
  await waitUntil(
    () =>
      store.getRun(run.id)!.status === "paused" &&
      store.getRun(run.id)!.timing!.trainingElapsedMs! >= 100,
    "manual active time increment",
  );
  const active = store.getRun(run.id)!.timing!.trainingElapsedMs!;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(store.getRun(run.id)!.timing!.trainingElapsedMs, active);
  assert.equal(
    (await post(`/runs/${run.id}/playback`, { action: "extend", seconds: 0.1 }))
      .statusCode,
    200,
  );
  assert.equal(store.getRun(run.id)!.playback!.generationSeconds, 0.5);
  await post(`/runs/${run.id}/resume`);
  await waitFor(run.id, "completed");
  assert.ok(store.getRun(run.id)!.timing!.trainingElapsedMs! >= 500);
});
test("queued playback survives launch and lowering a paused limit finalizes only completed work", async () => {
  const first = (
    await post("/runs", {
      ...base,
      agents: 1,
      episodes: 2,
      ticksPerEpisode: 8,
      startPaused: true,
    })
  ).json();
  await waitFor(first.id, "paused");
  const second = (
    await post("/runs", {
      ...base,
      agents: 1,
      episodes: 1,
      ticksPerEpisode: 4,
      startPaused: true,
    })
  ).json();
  assert.equal(second.status, "queued");
  assert.equal(
    (await post(`/runs/${second.id}/playback`, { action: "speed", speed: 2 }))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await post(`/runs/${second.id}/playback`, {
        action: "length",
        unit: "steps",
        value: 2,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await post(`/runs/${second.id}/playback`, {
        action: "advance",
        unit: "steps",
        value: 1,
      })
    ).statusCode,
    400,
  );
  await post(`/runs/${first.id}/playback`, {
    action: "advance",
    unit: "steps",
    value: 3,
  });
  await waitUntil(
    () =>
      store.getRun(first.id)!.status === "paused" &&
      store.getRun(first.id)!.timing!.tick === 3,
    "three completed steps before shortening",
  );
  await post(`/runs/${first.id}/playback`, {
    action: "length",
    unit: "steps",
    value: 2,
  });
  await waitUntil(
    () =>
      store.getRun(first.id)!.status === "paused" &&
      store.getRun(first.id)!.timing!.phase === "between",
    "shortened paused generation finished",
  );
  const artifact = await app.inject({
    url: `/runs/${first.id}/artifacts/episodes.jsonl`,
    headers,
  });
  const completed = JSON.parse(artifact.body.trim());
  assert.equal(completed.steps, 3);
  assert.equal(completed.endedBy, "limit");
  await post(`/runs/${first.id}/cancel`);
  await waitFor(second.id, "paused");
  assert.equal(store.getRun(second.id)!.playback!.speed, 2);
  assert.equal(store.getRun(second.id)!.playback!.ticksPerGeneration, 2);
  await post(`/runs/${second.id}/playback`, {
    action: "advance",
    unit: "generation",
    value: 1,
  });
  await waitFor(second.id, "completed");
  const launch = await app.inject({
    url: `/runs/${second.id}/artifacts/config.json`,
    headers,
  });
  assert.equal(launch.json().spec.ticksPerEpisode, 4);
  assert.equal(launch.json().playback.ticksPerGeneration, 2);
});
test("authorization and invalid input cannot launch workers", async () => {
  assert.equal(
    (await app.inject({ method: "POST", url: "/runs", payload: base }))
      .statusCode,
    401,
  );
  assert.equal((await post("/runs", { ...base, agents: -1 })).statusCode, 400);
  assert.equal(
    (await post("/runs", { ...base, stage: "unknown" })).statusCode,
    400,
  );
  assert.equal((await post("/runs", { ...base, agents: 5 })).statusCode, 400);
  assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
});
test("default Minecraft admission requires reset support and simulator players cannot be watched", async () => {
  const absentServer = await post("/runs", { stage: "movement", agents: 1 });
  assert.equal(absentServer.statusCode, 400);
  assert.match(absentServer.json().error, /spawning and generation resets/);
  const runResponse = await post("/runs", {
    ...base,
    agents: 1,
    startPaused: true,
  });
  assert.equal(runResponse.statusCode, 201);
  const run = runResponse.json();
  await waitFor(run.id, "paused");
  assert.equal(store.agents(run.id).length, 1);
  assert.equal(store.agents(run.id)[0].ticks, 0);
  assert.ok(store.agents(run.id)[0].position);
  const watch = await post(`/runs/${run.id}/watch`, {
    username: `rl_${run.id.slice(0, 6)}_0`,
  });
  assert.equal(watch.statusCode, 400);
  await post(`/runs/${run.id}/cancel`);
});
test("isolated simulator run completes, persists measurements and exports checkpoint", async () => {
  const response = await post("/runs", base);
  assert.equal(response.statusCode, 201);
  const run = response.json();
  await waitFor(run.id, "completed");
  assert.ok(store.metrics(run.id).length >= 2);
  assert.equal(store.getRun(run.id)?.progress, 1);
  const timing = store.getRun(run.id)!.timing!;
  assert.equal(timing.tick, base.ticksPerEpisode);
  assert.ok(timing.totalElapsedMs >= timing.generationElapsedMs);
  assert.ok(timing.lastGenerationMs! >= base.ticksPerEpisode * base.tickMs);
  assert.equal(timing.advancing, false);
  assert.ok(store.logs(run.id).some((l) => l.message.includes("placeholders")));
  const artifact = await app.inject({
    url: `/runs/${run.id}/artifacts/checkpoint.json`,
    headers,
  });
  assert.equal(artifact.statusCode, 200);
  assert.equal(artifact.json().kind, "placeholder");
  assert.equal(artifact.json().model, null);
  const invalid = await app.inject({
    url: `/runs/${run.id}/artifacts/secret`,
    headers,
  });
  assert.equal(invalid.statusCode, 400);
});
test("pause acknowledges at a tick boundary, resume continues, queue respects capacity and cancellation frees slots", async () => {
  const first = (
    await post("/runs", { ...base, ticksPerEpisode: 1000, tickMs: 50 })
  ).json();
  const second = (await post("/runs", base)).json();
  assert.equal(second.status, "queued");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal((await post(`/runs/${first.id}/pause`)).statusCode, 200);
  await waitFor(first.id, "paused");
  const pausedTiming = store.getRun(first.id)!.timing!;
  assert.equal(pausedTiming.advancing, false);
  const progress = store.getRun(first.id)!.progress;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(store.getRun(first.id)!.progress, progress);
  assert.deepEqual(store.getRun(first.id)!.timing, pausedTiming);
  assert.equal((await post(`/runs/${first.id}/resume`)).statusCode, 200);
  await waitFor(first.id, "running");
  assert.equal((await post(`/runs/${first.id}/cancel`)).statusCode, 200);
  assert.equal(store.getRun(first.id)!.status, "cancelled");
  await waitFor(second.id, "completed");
  assert.equal((await post(`/runs/${second.id}/pause`)).statusCode, 400);
});
test("environment component and evaluation execute independently", async () => {
  for (const component of ["environment", "evaluation"]) {
    const run = (await post("/runs", { ...base, component })).json();
    await waitFor(run.id, "completed");
    assert.equal(store.getRun(run.id)?.spec.component, component);
  }
});
test("server start reports missing jar clearly", async () => {
  const response = await post("/server/start");
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /jar missing/);
});
test("restart marks orphaned runs interrupted, retains queue and durable history", () => {
  const path = join(dir, "recovery.sqlite");
  const database = new Store(path);
  const now = new Date().toISOString();
  const running = {
    id: "running",
    status: "running" as const,
    spec: {
      ...base,
      component: "pipeline" as const,
      stage: "movement" as const,
      mode: "simulator" as const,
    },
    createdAt: now,
    updatedAt: now,
    episode: 1,
    progress: 0.3,
  };
  database.saveRun(running);
  database.saveRun({ ...running, id: "queued", status: "queued" });
  database.close();
  const reopened = new Store(path);
  reopened.recover();
  assert.equal(reopened.getRun("running")?.status, "interrupted");
  assert.equal(reopened.queued()[0].id, "queued");
  reopened.close();
});
test("server lifecycle observes readiness, samples TPS, rejects multi-line commands and stops its owned process", async () => {
  const { MinecraftServer } = await import("../apps/control/src/server.js");
  await mkdir(join(dir, "server"), { recursive: true });
  await writeFile(join(dir, "server", "server.jar"), "test fixture");
  await writeFile(join(dir, "server", "eula.txt"), "eula=false\n");
  const fixture = join(dir, "fake-server.cjs");
  await writeFile(
    fixture,
    `console.log('Done (0.1s)!');process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{for(const command of s.trim().split(/\\r?\\n/)){if(command==='stop')process.exit(0);if(command==='tps')console.log('TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0');}});`,
  );
  const server = new MinecraftServer(
    store,
    () => {},
    (_command, _args, options) => spawn(process.execPath, [fixture], options),
  );
  assert.throws(() => server.start(), /EULA/);
  await writeFile(join(dir, "server", "eula.txt"), "eula=true\n");
  async function until(predicate: () => boolean) {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 5000)
        throw new Error("Server fixture timed out");
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  try {
    server.start();
    await until(() => server.state.status === "running");
    assert.throws(() => server.start(), /already exists/);
    assert.throws(() => server.command("say hello\nstop"), /Invalid/);
    assert.throws(() => server.command("stop"), /lifecycle/);
    server.command("tps");
    await until(() => server.state.tps === 20);
    await server.stop();
    assert.equal(server.state.status, "stopped");
  } finally {
    await server.stop();
  }
});
test("unsupported Java is retained as the startup error even when Paper exits with code zero", async () => {
  const { MinecraftServer } = await import("../apps/control/src/server.js");
  const fixture = join(dir, "unsupported-java.cjs");
  await writeFile(
    fixture,
    "console.log('Unsupported Java detected (69.0). Only up to Java 17 is supported.');",
  );
  const server = new MinecraftServer(
    store,
    () => {},
    (_command, _args, options) => spawn(process.execPath, [fixture], options),
  );
  server.start();
  const start = Date.now();
  while (
    !store
      .logs()
      .some(
        (l) =>
          l.message === server.state.error &&
          l.message.includes("requires Java 17"),
      )
  ) {
    if (Date.now() - start > 5000)
      throw new Error("Unsupported Java fixture timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.equal(server.state.status, "failed");
  assert.match(server.state.error!, /requires Java 17/);
  assert.match(server.state.error!, /JAVA_PATH/);
  await server.stop();
});

test("world API blocks changes during server activity and queued Minecraft runs, validates input, and records run world provenance", async () => {
  const settings = {
    type: "survival",
    seed: "123",
    difficulty: "normal",
    gamemode: "survival",
    structures: true,
    flat: {
      biome: "minecraft:plains",
      layers: [{ block: "minecraft:bedrock", height: 1 }],
    },
  };
  server.state = { status: "running" };
  assert.equal(
    (await post("/worlds", { name: "Protected", settings })).statusCode,
    400,
  );
  server.state = { status: "stopped" };
  const now = new Date().toISOString();
  const id = "44444444-4444-4444-8444-444444444444";
  store.saveRun({
    id,
    spec: {
      ...base,
      stage: "movement",
      mode: "minecraft",
      component: "pipeline",
    },
    status: "queued",
    episode: 0,
    progress: 0,
    createdAt: now,
    updatedAt: now,
  });
  assert.equal(
    (await post("/worlds", { name: "Protected", settings })).statusCode,
    400,
  );
  store.saveRun({ ...store.getRun(id)!, status: "cancelled" });
  assert.equal(
    (
      await post("/worlds", {
        name: "Invalid",
        settings: { ...settings, seed: "\nserver-ip=evil" },
      })
    ).statusCode,
    400,
  );
  const response = await post("/worlds", { name: "Survival trial", settings });
  assert.equal(response.statusCode, 200, response.body);
  const catalog = response.json();
  const context = await worlds.context();
  assert.equal(context?.generationId, catalog.active.generationId);
  const simulator = (
    await post("/runs", { ...base, ticksPerEpisode: 1000, tickMs: 50 })
  ).json();
  // Admission requires the generation-reset plugin even for queued live runs.
  server.state = { status: "running", setupReady: true, rulesReady: true };
  const queuedResponse = await post("/runs", { ...base, mode: "minecraft" });
  server.state = { status: "stopped" };
  assert.equal(queuedResponse.statusCode, 201, queuedResponse.body);
  const queued = queuedResponse.json();
  assert.equal(queued.status, "queued");
  assert.equal(queued.world.generationId, context?.generationId);
  assert.equal(
    (
      await post(`/worlds/${catalog.active.profileId}/reset`, {
        generationId: catalog.active.generationId,
      })
    ).statusCode,
    400,
  );
  await post(`/runs/${queued.id}/cancel`);
  await post(`/runs/${simulator.id}/cancel`);
  const recordedId = "55555555-5555-4555-8555-555555555555";
  store.saveRun({
    id: recordedId,
    spec: {
      ...base,
      stage: "movement",
      mode: "minecraft",
      component: "pipeline",
    },
    world: context,
    status: "completed",
    episode: 2,
    progress: 1,
    createdAt: now,
    updatedAt: now,
  });
  await post(`/worlds/${catalog.active.profileId}/reset`, {
    generationId: catalog.active.generationId,
    randomSeed: false,
  });
  server.state = { status: "running", setupReady: true, rulesReady: true };
  const rerun = await post(`/runs/${recordedId}/rerun`);
  server.state = { status: "stopped" };
  assert.equal(rerun.statusCode, 400);
  assert.match(rerun.json().error, /recorded world generation/);
});
test("dashboard preset CRUD persists setups and editing/deleting a preset cannot change a queued run snapshot", async () => {
  const setup = {
    ...DEFAULT_AGENT_SETUP,
    items: [
      { slot: 0, item: "minecraft:iron_axe", count: 1 },
      { slot: 1, item: "minecraft:stone", count: 16 },
    ],
  };
  const preset = (
    await post("/agent-presets", { name: "Wood tools", setup })
  ).json();
  assert.ok(preset.id);
  assert.equal(
    (await app.inject({ url: "/agent-presets", headers })).json().presets[0]
      .name,
    "Wood tools",
  );
  const first = (
    await post("/runs", { ...base, setup, ticksPerEpisode: 1000, tickMs: 50 })
  ).json();
  const queued = (await post("/runs", { ...base, setup })).json();
  assert.equal(queued.status, "queued");
  await post(`/agent-presets/${preset.id}`, {
    name: "Changed",
    setup: { ...setup, items: [] },
  });
  await post(`/agent-presets/${preset.id}/delete`);
  assert.equal(store.getRun(queued.id)?.spec.setup?.items.length, 2);
  await post(`/runs/${first.id}/cancel`);
  await waitFor(queued.id, "completed");
  assert.deepEqual(store.agents(queued.id)[0].inventory, {
    iron_axe: 1,
    stone: 16,
  });
  assert.equal(store.agents(queued.id)[0].reward, 0);
  const artifact = await app.inject({
    url: `/runs/${queued.id}/artifacts/config.json`,
    headers,
  });
  assert.equal(artifact.json().spec.setup.items.length, 2);
  assert.equal(
    (await post("/runs", { ...base, mode: "minecraft", setup })).statusCode,
    400,
  );
  assert.equal(
    (
      await post("/agent-presets", {
        name: "Bad",
        setup: {
          ...setup,
          items: [{ slot: 0, item: "minecraft:iron_axe", count: 64 }],
        },
      })
    ).statusCode,
    400,
  );
});

test("preparation is supervised, excludes live operations and reports failure without altering worlds", async () => {
  server.state = { status: "running" };
  const blocked = await post("/server/prepare");
  assert.equal(blocked.statusCode, 400);
  assert.match(blocked.json().error, /Stop Minecraft/);
  server.state = { status: "stopped" };
  const beforeWorld = await worlds.context();
  const started = await post("/server/prepare", {
    sourceJar: join(dir, "missing-paper.jar"),
  });
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().status, "running");
  const startServer = await post("/server/start");
  assert.equal(startServer.statusCode, 400);
  assert.match(startServer.json().error, /preparation/);
  assert.equal((await post("/server/prepare")).statusCode, 400);
  const live = await post("/runs", { ...base, mode: "minecraft" });
  assert.equal(live.statusCode, 400);
  assert.match(live.json().error, /preparation/);
  const change = await post("/worlds", {
    name: "Cannot overlap preparation",
    settings: beforeWorld!.settings,
  });
  assert.equal(change.statusCode, 400);
  assert.match(change.json().error, /preparation/);
  const deadline = Date.now() + 10000;
  let status = "running";
  while (Date.now() < deadline && status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = (await app.inject({ url: "/snapshot", headers })).json()
      .preparation.status;
  }
  assert.equal(status, "failed");
  assert.ok(
    store
      .logs()
      .some(
        (entry) =>
          entry.source === "preparation" &&
          entry.level === "error" &&
          entry.message.length > 0,
      ),
    JSON.stringify(
      store.logs().filter((entry) => entry.source === "preparation"),
    ),
  );
  assert.deepEqual(await worlds.context(), beforeWorld);
});
test("arena preset API validates geometry, preserves submitted blueprints, and requires managed plugin readiness for runs", async () => {
  const { DEFAULT_ARENA_SPEC } = await import("@rlcraft/core");
  const created = await post("/arena-presets", {
    name: "Training cage",
    blueprint: DEFAULT_ARENA_SPEC.blueprint,
  });
  assert.equal(created.statusCode, 200, created.body);
  const preset = created.json();
  assert.equal(
    (await app.inject({ url: "/arena-presets", headers })).json().presets[0].id,
    preset.id,
  );
  assert.equal(
    (
      await post(`/arena-presets/${preset.id}`, {
        name: "Updated",
        blueprint: { ...preset.blueprint, width: 9 },
      })
    ).statusCode,
    200,
  );
  assert.equal(store.arenaPreset(preset.id)!.blueprint.width, 9);
  assert.equal(
    (await post(`/arena-presets/${preset.id}/delete`)).statusCode,
    200,
  );
  assert.equal(
    (
      await post("/arena-presets", {
        name: "Invalid",
        blueprint: { ...preset.blueprint, width: 100 },
      })
    ).statusCode,
    400,
  );
  const unready = await post("/runs", {
    ...base,
    mode: "minecraft",
    arena: DEFAULT_ARENA_SPEC,
  });
  assert.equal(unready.statusCode, 400);
  assert.match(unready.json().error, /arena plugin/);
  assert.equal(
    (await post("/runs", { ...base, arena: DEFAULT_ARENA_SPEC })).statusCode,
    400,
  );
});
