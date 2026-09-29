import Fastify from "fastify";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { z } from "zod";
import { resolve } from "node:path";
import { stat, readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import {
  stages,
  DEFAULT_AGENT_SETUP,
  DEFAULT_TRAINING_RULES,
  type Snapshot,
} from "@rlcraft/core";
import {
  trainingRulesSchema,
  validateRulesCompatibility,
} from "./training-rules.js";
import { Store } from "./store.js";
import { progressionCatalog } from "./progress.js";
import { Scheduler } from "./scheduler.js";
import { MinecraftServer } from "./server.js";
import { config, token, root } from "./config.js";
import { DatasetManager } from "./datasets.js";
import {
  WorldManager,
  worldCreateSchema,
  worldSettingsSchema,
} from "./worlds.js";
import { isLoopback } from "../../../packages/runtime/src/settings.js";
import {
  agentSetupSchema,
  agentPresetSchema,
  itemCatalog,
} from "./agent-setup.js";
import { ServerPreparation } from "./preparation.js";
import { CloudArchive } from "./archive.js";
import { ModelCatalog, modelCodeVersion } from "./models.js";
import {
  inputConfigSchema,
  captureSchema,
  defaultInputConfig,
} from "./inputs.js";
import { inputCatalog } from "@rlcraft/core";
import { protocolCatalog } from "../../../packages/agents/src/inputs/catalog.js";
import { playbackSchema } from "./playback.js";
import { backendRegistry } from "./backends.js";
import {
  fabricRoot,
  readFabricManifest,
  renderSchema,
} from "../../../packages/runtime/src/fabric.js";
import { backendIdSchema } from "../../../packages/agents/src/backends/registry.js";
import {
  arenaSpecSchema,
  arenaPresetSchema,
  arenaBlockCatalog,
  validateArenaRun,
  arenaConflict,
} from "./arenas.js";
export const runSchema = z
  .object({
    stage: z.enum([
      "movement",
      "wood_collection",
      "block_collection",
      "survival",
      "pvp",
    ]),
    mode: z.enum(["simulator", "minecraft"]).default("minecraft"),
    backend: backendIdSchema.optional(),
    render: renderSchema.optional(),
    component: z
      .enum(["pipeline", "environment", "evaluation"])
      .default("pipeline"),
    agents: z.number().int().min(1).max(128).default(4),
    episodes: z.number().int().min(1).max(100000).default(10),
    ticksPerEpisode: z.number().int().min(1).max(100000).default(100),
    tickMs: z.number().int().min(20).max(5000).default(100),
    seed: z.number().int().min(0).max(2147483647).default(42),
    speed: z.number().min(0.25).max(8).default(1),
    generationSeconds: z.number().min(0.1).max(86400).optional(),
    startPaused: z.boolean().default(false),
    setup: agentSetupSchema.optional(),
    inputs: inputConfigSchema.optional(),
    arena: arenaSpecSchema.optional(),
    rules: trainingRulesSchema.optional(),
  })
  .strict()
  .transform((spec) => ({
    ...spec,
    backend:
      spec.backend ??
      (spec.mode === "simulator" ? "simulator" : config.MC_AGENT_BACKEND),
    inputs: spec.inputs ?? structuredClone(defaultInputConfig),
    ...(spec.mode === "minecraft" && !spec.rules
      ? { rules: structuredClone(DEFAULT_TRAINING_RULES) }
      : {}),
    ...(spec.mode === "minecraft" && !spec.setup
      ? { setup: structuredClone(DEFAULT_AGENT_SETUP) }
      : {}),
  }));
export function createApp(
  store = new Store(resolve(config.dataDir, "control.sqlite")),
) {
  const app = Fastify({ logger: true, bodyLimit: 32768 });
  const firebase = config.ARCHIVE_PROVIDER === "firebase";
  store.archive.configure(
    firebase
      ? JSON.stringify({
          project: config.FIREBASE_PROJECT_ID,
          bucket: config.FIREBASE_STORAGE_BUCKET,
          prefix: config.FIREBASE_ARCHIVE_PREFIX,
        })
      : undefined,
  );
  const archive = new CloudArchive(
    store.archive,
    firebase
      ? async () => {
          const { createFirebaseArchive } =
            await import("./firebase-archive.js");
          return createFirebaseArchive({
            projectId: config.FIREBASE_PROJECT_ID!,
            bucket: config.FIREBASE_STORAGE_BUCKET!,
            prefix: config.FIREBASE_ARCHIVE_PREFIX,
            artifactDir: config.artifactDir,
          });
        }
      : undefined,
  );
  const server = new MinecraftServer(store, () => {});
  const scheduler = new Scheduler(
    store,
    () => {},
    undefined,
    (id, username, setup) => server.setupAgent(id, username, setup),
    {
      build: (id, runId, arena, agents) =>
        server.prepareArena(id, runId, arena, agents),
      spawn: (id, runId, username, index) =>
        server.spawnArenaAgent(id, runId, username, index),
      cancel: (runId) => server.cancelArena(runId),
    },
    {
      apply: (id, runId, rules, agents) =>
        server.applyTrainingRules(id, runId, rules, agents),
      release: (runId) => server.releaseTrainingRules(runId),
    },
  );
  const preparation = new ServerPreparation(store, () => {
    if (
      server.hasProcess ||
      ["starting", "running", "stopping"].includes(server.state.status)
    )
      return "Stop Minecraft and wait for its save before preparing the server";
    if (worlds.busy) return "World change in progress";
    if (
      scheduler.hasMinecraftWorkers() ||
      store.queued().some((run) => run.spec.mode === "minecraft")
    )
      return "Cancel active and queued Minecraft runs first";
  });
  const worlds = new WorldManager(
    config.serverDir,
    () => {
      if (preparation.running) return "Server preparation in progress";
      if (
        server.hasProcess ||
        ["starting", "running", "stopping"].includes(server.state.status)
      )
        return "Stop Minecraft and wait for its world save before changing worlds";
      if (
        existsSync(
          resolve(
            config.serverDir,
            "plugins/RLCraftViewerGuard/training-world-rules.yml",
          ),
        )
      )
        return "Start Minecraft to restore interrupted experiment rules before changing worlds";
      if (
        scheduler.hasMinecraftWorkers() ||
        store.queued().some((run) => run.spec.mode === "minecraft")
      )
        return "Finish or cancel active and queued Minecraft runs before changing worlds";
    },
    (message) =>
      store.log({ at: Date.now(), level: "info", source: "worlds", message }),
  );
  async function enqueue(
    spec: ReturnType<typeof runSchema.parse>,
    expectedGeneration?: string,
    expectedBackendRevision?: string,
  ) {
    const backend = (await backendRegistry).select(spec, config.MC_VERSION);
    if (backend.descriptor.id === "fabric") {
      if (config.MC_AUTH !== "offline")
        throw new Error(
          "Fabric clients currently require offline training-server authentication",
        );
      if (spec.agents > config.MAX_RENDER_CLIENTS)
        throw new Error(
          `Rendered agent count exceeds renderer capacity ${config.MAX_RENDER_CLIENTS}`,
        );
      if (fabricPreparation.running)
        throw new Error("Fabric client preparation is still running");
      await readFabricManifest(fabricRoot(config.dataDir)).catch((error) => {
        throw new Error(
          `Prepare Fabric clients before creating this run. ${error.message}`,
        );
      });
    }
    if (expectedBackendRevision && backend.revision !== expectedBackendRevision)
      throw new Error(
        "This run's backend has changed. Create a new run with the current backend rather than rerunning with different client behavior.",
      );
    validateArenaRun(spec);
    if (
      spec.arena &&
      (!isLoopback(config.MC_HOST) ||
        server.state.status !== "running" ||
        !server.state.arenaReady)
    )
      throw new Error(
        "Training arenas require the managed Minecraft server's arena plugin. Prepare/update server, then start Minecraft.",
      );
    if (spec.mode === "minecraft" && worlds.busy)
      throw new Error("World change in progress");
    if (spec.mode === "minecraft" && preparation.running)
      throw new Error("Server preparation in progress");
    if (
      spec.mode === "minecraft" &&
      spec.setup &&
      (!isLoopback(config.MC_HOST) ||
        server.state.status !== "running" ||
        !server.state.setupReady ||
        !server.state.rulesReady)
    )
      throw new Error(
        "Minecraft agent spawning and generation resets require the managed server's training plugin. Use Prepare/update server, then Start server before launching a run.",
      );
    const world =
      spec.mode === "minecraft" && isLoopback(config.MC_HOST)
        ? await worlds.context()
        : undefined;
    if (spec.mode === "minecraft" && worlds.busy)
      throw new Error("World change in progress");
    if (spec.mode === "minecraft" && preparation.running)
      throw new Error("Server preparation in progress");
    if (expectedGeneration && world?.generationId !== expectedGeneration)
      throw new Error(
        "Select this run's recorded world generation before rerunning it",
      );
    if (spec.mode === "minecraft") arenaConflict(spec, store.runs(1000));
    validateRulesCompatibility(spec, store.runs(1000));
    return scheduler.enqueue(spec, world, backend);
  }
  store.recover();
  app.addHook("onReady", async () => {
    await backendRegistry;
  });
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const supplied = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return reply.code(401).send({ error: "Unauthorized" });
  });
  app.setErrorHandler((err, _req, reply) => {
    const error = err as Error;
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    reply.code(400).send({ error: error.message });
  });
  const snapshot = (): Snapshot => ({
    runs: store.runs(),
    agents: store.agents(),
    metrics: store.metrics(),
    hostMetrics: store.hostMetrics(),
    logs: store.logs(),
    server: server.state,
    preparation: preparation.state,
    archive: archive.snapshot(),
    stages,
    capacity: scheduler.capacity(),
  });
  app.get("/health", async () => ({
    status: "ok",
    service: "rlcraft-control",
  }));
  app.get("/snapshot", async () => snapshot());
  const datasets = new DatasetManager(
    resolve(config.artifactDir, "datasets"),
    root,
    config.PYTHON_PATH,
  );
  app.get("/datasets", async () => datasets.snapshot());
  app.get("/datasets/:id/examples", async (req) =>
    datasets.examples((req.params as { id: string }).id, req.query),
  );
  app.post("/datasets", async (req) => datasets.start(req.body));
  app.post("/datasets/:id/rerun", async (req) =>
    datasets.rerun((req.params as { id: string }).id),
  );
  app.post("/datasets/:id/cancel", async (req) =>
    datasets.cancel((req.params as { id: string }).id),
  );
  app.get("/datasets/:id/artifacts/:file", async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const path = datasets.artifact(id, file);
    reply.header("content-disposition", `attachment; filename="${id}-${file}"`);
    reply.type(
      file.endsWith(".csv")
        ? "text/csv"
        : file.endsWith(".jsonl")
          ? "application/x-ndjson"
          : "application/json",
    );
    return reply.send(createReadStream(path));
  });
  app.get("/progress", async (req) => {
    const query = z
      .object({ runId: z.uuid().optional() })
      .strict()
      .parse(req.query);
    return {
      catalog: progressionCatalog,
      configuredVersion: config.MC_VERSION,
      supportedVersion:
        config.MC_VERSION === progressionCatalog.minecraftVersion,
      attributionReady: !!server.state.progressReady,
      scope: query.runId ? "run" : "all-runs",
      ...(query.runId ? { runId: query.runId } : {}),
      summaries: store.progress(query.runId),
      tracking: store.progressTracking(query.runId),
    };
  });
  const inputPreparation = new ServerPreparation(
    store,
    () => undefined,
    "prepare-input-assets.ts",
  );
  app.get("/backends", async () => ({
    defaultMinecraft: config.MC_AGENT_BACKEND,
    backends: (await backendRegistry).list(),
  }));
  const fabricPreparation = new ServerPreparation(
    store,
    () =>
      scheduler.hasFabricWorkers()
        ? "Finish or cancel Fabric runs before updating client artifacts"
        : undefined,
    "prepare-fabric-client.ts",
    1200000,
  );
  app.get("/clients", async () => {
    let ready = false,
      reason = "";
    try {
      await readFabricManifest(fabricRoot(config.dataDir));
      ready = true;
    } catch (error) {
      reason = (error as Error).message;
    }
    return {
      ready,
      reason,
      preparation: fabricPreparation.state,
      maxClients: config.MAX_RENDER_CLIENTS,
      activeClients: scheduler.renderClients(),
      version: "1.18.1",
    };
  });
  app.post("/clients/prepare", async () => fabricPreparation.start());
  app.get("/inputs", async () => ({
    catalog: inputCatalog,
    defaults: defaultInputConfig,
    preparation: inputPreparation.state,
  }));
  app.post("/inputs/prepare", async () => inputPreparation.start());
  app.get("/inputs/catalog.json", async (req, reply) => {
    reply.header(
      "content-disposition",
      'attachment; filename="agent-inputs.catalog.json"',
    );
    return protocolCatalog(config.MC_VERSION);
  });
  app.get("/runs/:id/agents/:username/inputs", async (req) => {
    const { id, username } = req.params as { id: string; username: string };
    return scheduler.observeAgent(id, username);
  });
  app.get("/runs/:id/agents/:username/feed", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const { id, username } = z
      .object({
        id: z.uuid(),
        username: z.string().regex(/^rl_[a-f0-9]{6}_\d{1,3}$/),
      })
      .parse(req.params);
    const frame = await scheduler.viewAgent(id, username);
    return frame
      ? { status: "ready", frame }
      : {
          status: "unavailable",
          reason:
            "No fresh rendered frame is available for this agent. Use the Fabric client backend.",
        };
  });
  app.post(
    "/runs/:id/agents/:username/capture",
    { bodyLimit: 1100000 },
    async (req) => {
      const { id, username } = req.params as { id: string; username: string };
      return scheduler.observeAgent(
        id,
        username,
        captureSchema.parse(req.body),
      );
    },
  );
  const models = new ModelCatalog();
  app.get("/models", async () => ({
    stages,
    codeVersion: await modelCodeVersion(),
  }));
  app.get("/models/stage/:stage", async (req, reply) => {
    const stage = (req.params as { stage: string }).stage;
    const item = stages.find((entry) => entry.id === stage);
    if (!item) return reply.code(404).send({ error: "Unknown training stage" });
    return models.preview(
      item.id,
      (req.query as { fresh?: string }).fresh === "1",
    );
  });
  app.get("/models/run/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!z.string().uuid().safeParse(id).success || !store.getRun(id))
      return reply.code(404).send({ error: "Run not found" });
    const current = scheduler.modelSnapshot(id);
    if (current) return current;
    try {
      return JSON.parse(
        await readFile(resolve(config.artifactDir, id, "models.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return reply.code(404).send({
      error:
        "No model inspection yet. Start a new run; older runs have no model snapshot.",
    });
  });
  app.post("/archive/sync", async () => {
    if (!firebase)
      throw new Error(
        "Firebase archiving is disabled. Configure it on the control service first.",
      );
    void archive.sync(true);
    return archive.snapshot();
  });
  app.get("/agent-presets", async () => ({
    presets: store.presets(),
    items: itemCatalog,
    version: "1.18.1",
  }));
  app.get("/arena-presets", async () => ({
    presets: store.arenaPresets(),
    blocks: arenaBlockCatalog,
    items: itemCatalog,
    version: "1.18.1",
  }));
  app.post("/arena-presets", async (req) => {
    if (store.arenaPresets().length >= 100)
      throw new Error("Arena preset limit reached (100)");
    const input = arenaPresetSchema.parse(req.body),
      now = new Date().toISOString();
    const preset = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    store.saveArenaPreset(preset);
    return preset;
  });
  app.post("/arena-presets/:id", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params),
      current = store.arenaPreset(id);
    if (!current) throw new Error("Arena preset not found");
    const preset = {
      ...current,
      ...arenaPresetSchema.parse(req.body),
      updatedAt: new Date().toISOString(),
    };
    store.saveArenaPreset(preset);
    return preset;
  });
  app.post("/arena-presets/:id/delete", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!store.arenaPreset(id)) throw new Error("Arena preset not found");
    store.deleteArenaPreset(id);
    return { deleted: true };
  });
  app.post("/agent-presets", async (req) => {
    if (store.presets().length >= 100)
      throw new Error("Agent preset limit reached (100)");
    const input = agentPresetSchema.parse(req.body);
    const now = new Date().toISOString();
    const preset = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    store.savePreset(preset);
    return preset;
  });
  app.post("/agent-presets/:id", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const current = store.getPreset(id);
    if (!current) throw new Error("Agent preset not found");
    const preset = {
      ...current,
      ...agentPresetSchema.parse(req.body),
      updatedAt: new Date().toISOString(),
    };
    store.savePreset(preset);
    return preset;
  });
  app.post("/agent-presets/:id/delete", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!store.getPreset(id)) throw new Error("Agent preset not found");
    store.deletePreset(id);
    return { deleted: true };
  });
  app.get("/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return {
      run,
      agents: store.agents(id),
      metrics: store.metrics(id, 1000),
      logs: store.logs(id, 500),
    };
  });
  app.post("/runs", async (req, reply) =>
    reply.code(201).send(await enqueue(runSchema.parse(req.body))),
  );
  app.post("/runs/:id/playback", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return scheduler.playback(id, playbackSchema.parse(req.body));
  });
  app.post("/runs/:id/watch", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { username } = z
      .object({ username: z.string().regex(/^rl_[a-f0-9]{6}_\d+$/) })
      .strict()
      .parse(req.body);
    const run = store.getRun(id);
    const agent = store.agents(id).find((agent) => agent.username === username);
    if (
      !run ||
      run.spec.mode !== "minecraft" ||
      !["running", "paused", "pausing"].includes(run.status) ||
      !agent ||
      !["active", "paused"].includes(agent.status)
    )
      throw new Error(
        "Select a spawned, living Minecraft agent from an active run",
      );
    server.command(`tp ChilledVibe ${username}`);
    return server.command(`spectate ${username} ChilledVibe`);
  });
  app.post("/runs/:id/:action", async (req) => {
    const { id, action } = z
      .object({
        id: z.uuid(),
        action: z.enum(["pause", "resume", "cancel", "rerun"]),
      })
      .parse(req.params);
    if (action === "rerun") {
      const run = store.getRun(id);
      if (!run) throw new Error("Run not found");
      return enqueue(
        runSchema.parse(run.spec),
        run.world?.generationId,
        run.backend?.revision,
      );
    }
    return scheduler.action(id, action);
  });
  app.get("/runs/:id/artifacts/:name", async (req, reply) => {
    const { id, name } = z
      .object({
        id: z.uuid(),
        name: z.enum([
          "config.json",
          "metrics.jsonl",
          "episodes.jsonl",
          "checkpoint.json",
          "models.json",
          "inputs.jsonl",
          "controls.jsonl",
        ]),
      })
      .parse(req.params);
    if (!store.getRun(id))
      return reply.code(404).send({ error: "Run not found" });
    try {
      const path = resolve(config.artifactDir, id, name);
      if (!(await stat(path)).isFile()) throw new Error("Not a file");
      return reply
        .header("content-disposition", `attachment; filename="${name}"`)
        .type(
          name.endsWith("jsonl") ? "application/x-ndjson" : "application/json",
        )
        .send(createReadStream(path));
    } catch {
      return reply.code(404).send({ error: "Artifact not available yet" });
    }
  });
  app.get("/worlds", async () => worlds.catalog());
  app.post("/worlds", async (req) =>
    worlds.create(worldCreateSchema.parse(req.body)),
  );
  app.post("/worlds/:id/activate", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { generationId } = z
      .object({ generationId: z.uuid() })
      .strict()
      .parse(req.body);
    return worlds.activate(id, generationId);
  });
  app.post("/worlds/:id/reset", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { generationId, randomSeed, settings } = z
      .object({
        generationId: z.uuid(),
        randomSeed: z.boolean().default(false),
        settings: worldSettingsSchema.optional(),
      })
      .strict()
      .parse(req.body);
    return worlds.reset(id, generationId, randomSeed, settings);
  });
  app.post("/server/start", async () => {
    if (worlds.busy) throw new Error("World change in progress");
    if (preparation.running) throw new Error("Server preparation in progress");
    return server.start();
  });
  app.post("/server/prepare", async (req) => {
    const { sourceJar } = z
      .object({
        sourceJar: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .refine((value) => !/[\r\n\0]/.test(value))
          .optional(),
      })
      .strict()
      .parse(req.body ?? {});
    return preparation.start(sourceJar);
  });
  app.post("/server/stop", async () => {
    if (scheduler.hasMinecraftWorkers())
      throw new Error(
        "Cancel active Minecraft runs and wait for workers to exit before stopping their server",
      );
    void server.stop().catch((error: Error) =>
      store.log({
        at: Date.now(),
        level: "error",
        source: "minecraft",
        message: `Server stop failed: ${error.message}`,
      }),
    );
    return server.state;
  });
  app.post("/server/command", async (req) =>
    server.command(
      z.object({ command: z.string().trim().min(1).max(1000) }).parse(req.body)
        .command,
    ),
  );
  let previousCpu = process.cpuUsage(),
    previousTime = performance.now();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const sample = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    store.host({
      at: Date.now(),
      cpuPercent:
        ((cpu.user - previousCpu.user + (cpu.system - previousCpu.system)) /
          ((now - previousTime) * 1000)) *
        100,
      memoryMb: process.memoryUsage().rss / 1024 / 1024,
      eventLoopMs: Number.isFinite(lag.mean) ? lag.mean / 1e6 : 0,
    });
    previousCpu = cpu;
    previousTime = now;
    lag.reset();
  }, 2000);
  const hud = setInterval(() => server.syncViewerHud(), 1000);
  const prune = setInterval(() => store.prune(), 60000);
  app.addHook("onClose", async () => {
    clearInterval(hud);
    clearInterval(sample);
    clearInterval(prune);
    lag.disable();
    await scheduler.close();
    await preparation.close();
    await inputPreparation.close();
    await fabricPreparation.close();
    await datasets.close();
    await server.stop();
    await archive.close();
    store.close();
  });
  app.addHook("onReady", async () => {
    archive.start();
    scheduler.pump();
  });
  return { app, store, scheduler, server, worlds };
}
