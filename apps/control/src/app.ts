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
  type MotorFullRun,
  type MotorFullRunStage,
  type Run,
} from "@mlcraft/core";
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
import { GoalModelManager } from "./goal-models.js";
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
import { inputCatalog } from "@mlcraft/core";
import { protocolCatalog } from "../../../packages/agents/src/inputs/catalog.js";
import { playbackSchema } from "./playback.js";
import { backendRegistry } from "./backends.js";
import {
  fabricRoot,
  readFabricManifest,
  renderSchema,
} from "../../../packages/runtime/src/fabric.js";
import { backendIdSchema } from "../../../packages/agents/src/backends/registry.js";
import { motorArena, motorSessions, motorTrialPlan } from "../../../packages/core/src/motor.js";
import { MotorNeat } from "../../../packages/agents/src/motor-neat.js";
import { motorInputConfig } from "./motor-inputs.js";
import { summarizeMotorTrials } from "./motor-full-run.js";
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
      "motor",
      "wood_collection",
      "block_collection",
      "survival",
      "pvp",
    ]),
    motor: z.enum(["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"]).optional(),
    motorSource: z.uuid().optional(),
    motorResume: z.uuid().optional(),
    motorFullRunId: z.uuid().optional(),
    motorFullRunStage: z.number().int().min(0).max(8).optional(),
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
    preview: z.boolean().optional(),
    setup: agentSetupSchema.optional(),
    inputs: inputConfigSchema.optional(),
    arena: arenaSpecSchema.optional(),
    rules: trainingRulesSchema.optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.stage === "motor" && !spec.motor)
      ctx.addIssue({ code: "custom", path: ["motor"], message: "Select a motor session M0–M8" });
    if (spec.motor && spec.stage !== "motor")
      ctx.addIssue({ code: "custom", path: ["motor"], message: "Motor session requires the motor stage" });
    if (spec.motorSource && spec.stage !== "motor")
      ctx.addIssue({ code: "custom", path: ["motorSource"], message: "Motor source requires the motor stage" });
    if (spec.motorResume && (spec.stage !== "motor" || spec.motorSource))
      ctx.addIssue({ code: "custom", path: ["motorResume"], message: "Motor resume requires the motor stage and cannot use a champion source" });
    if ((spec.motorFullRunId === undefined) !== (spec.motorFullRunStage === undefined) ||
        (spec.motorFullRunId && spec.stage !== "motor"))
      ctx.addIssue({ code: "custom", path: ["motorFullRunId"], message: "Full Run ID and stage require each other and the motor stage" });
  })
  .transform((spec) => ({
    ...spec,
    backend:
      spec.backend ??
      (spec.mode === "simulator" ? "simulator" : config.MC_AGENT_BACKEND),
    inputs:
      spec.inputs ??
      (spec.stage === "motor"
        ? motorInputConfig()
        : structuredClone(defaultInputConfig)),
    ...(spec.mode === "minecraft" && !spec.rules
      ? { rules: structuredClone(DEFAULT_TRAINING_RULES) }
      : {}),
    ...(spec.mode === "minecraft" && !spec.setup
      ? { setup: structuredClone(DEFAULT_AGENT_SETUP) }
      : {}),
  }));
const fullRunStageSchema = z.object({
  session: z.enum(["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"]),
  agents: z.number().int().min(1).max(config.MAX_AGENTS),
  episodes: z.number().int().min(1).max(100000),
  ticksPerEpisode: z.number().int().min(1).max(100000),
  tickMs: z.number().int().min(20).max(5000),
  seed: z.number().int().min(0).max(2147483647),
  backend: z.enum(["mineflayer", "fabric"]),
  minSuccessRate: z.number().min(0).max(1).default(0),
  minBestFitness: z.number().finite().optional(),
  maxAttempts: z.number().int().min(1).max(10).default(1),
}).strict();
const fullRunRequestSchema = z.object({
  stages: z.array(fullRunStageSchema).length(9),
}).strict().superRefine(({ stages: configured }, ctx) => {
  configured.forEach((stage, index) => {
    if (stage.session !== motorSessions[index].id)
      ctx.addIssue({ code: "custom", path: ["stages", index, "session"], message: `Expected ${motorSessions[index].id}` });
    if (index < 8 && stage.episodes < motorTrialPlan(1, stage.agents).episodesPerEvolution)
      ctx.addIssue({ code: "custom", path: ["stages", index, "episodes"], message: "Complete at least one full NEAT evolution" });
    if (index === 8 && (stage.maxAttempts !== 1 || stage.minBestFitness !== undefined))
      ctx.addIssue({ code: "custom", path: ["stages", index], message: "M8 is frozen evaluation and runs once without a fitness gate" });
  });
  if (configured[7]?.seed === configured[8]?.seed)
    ctx.addIssue({ code: "custom", path: ["stages", 8, "seed"], message: "M8 needs a different terrain seed from M7" });
});
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
    if (spec.stage === "motor") {
      const activePlan = store.motorFullRuns().find((plan) => ["running", "paused"].includes(plan.status));
      if (activePlan && spec.motorFullRunId !== activePlan.id)
        throw new Error("A Phase 3A Full Run is active; pause or stop it before starting a separate motor run");
      if (store.runs(1000).some((run) => run.spec.mode === "minecraft" && ["queued", "running", "paused", "pausing"].includes(run.status)))
        throw new Error("Motor sessions run alone; finish or cancel other Minecraft runs first");
      const source = spec.motorSource ? store.getRun(spec.motorSource) : undefined;
      if (spec.motorResume) {
        const previous = store.getRun(spec.motorResume);
        if (!previous || !["completed", "interrupted", "failed", "cancelled"].includes(previous.status) ||
            previous.spec.stage !== "motor" || previous.spec.component !== "pipeline" ||
            previous.spec.motor !== spec.motor || previous.spec.agents !== spec.agents ||
            previous.spec.seed !== spec.seed || previous.spec.backend !== spec.backend ||
            previous.spec.ticksPerEpisode !== spec.ticksPerEpisode ||
            previous.spec.tickMs !== spec.tickMs ||
            previous.spec.speed !== spec.speed ||
            previous.spec.generationSeconds !== spec.generationSeconds ||
            JSON.stringify(previous.spec.arena) !== JSON.stringify(spec.arena) ||
            JSON.stringify(previous.spec.inputs) !== JSON.stringify(spec.inputs) ||
            JSON.stringify(previous.spec.rules) !== JSON.stringify(spec.rules) ||
            JSON.stringify(previous.spec.setup) !== JSON.stringify(spec.setup) ||
            JSON.stringify(previous.spec.render) !== JSON.stringify(spec.render))
          throw new Error("Resume requires a finished run with the same session, population, seed, backend, and training settings");
        const checkpoint = JSON.parse(await readFile(resolve(config.artifactDir, previous.id, "checkpoint.json"), "utf8"));
        const completedEpisodes = checkpoint.resumeState
          ? checkpoint.episode
          : checkpoint.generation * motorTrialPlan(1, spec.agents).episodesPerEvolution;
        if (checkpoint.kind !== "neat-rl" || checkpoint.session !== spec.motor ||
            checkpoint.seed !== spec.seed ||
            !Number.isSafeInteger(completedEpisodes) || completedEpisodes < 0 ||
            completedEpisodes >= spec.episodes)
          throw new Error("Run has no compatible population checkpoint or no new episodes to train");
        new MotorNeat(spec, config.artifactDir);
      }
      if (spec.motorSource) {
        if (source?.status !== "completed" || source.spec.stage !== "motor")
          throw new Error("Motor source must be a completed motor run");
      }
      if (spec.motor === "M8") {
        if (source?.spec.motor !== "M7" || source.spec.seed === spec.seed)
          throw new Error("M8 requires a completed M7 source and a different terrain seed");
        const checkpoint = JSON.parse(await readFile(resolve(config.artifactDir, source.id, "checkpoint.json"), "utf8"));
        if (checkpoint.kind !== "neat-rl" || checkpoint.generation < 1)
          throw new Error("M8 requires an evolved M7 champion");
      }
      const catalog = await worlds.catalog();
      const profile = catalog.profiles.find((profile) => profile.id === catalog.active?.profileId);
      if (spec.mode !== "minecraft" ||
        spec.component !== (spec.motor === "M8" ? "evaluation" : "pipeline") ||
        (spec.motor === "M8" && !spec.motorSource) || !spec.motor ||
        profile?.name !== "MLCraft Motor Superflat" || (await worlds.context())?.settings.type !== "flat" ||
        JSON.stringify(spec.arena) !== JSON.stringify(motorArena(spec.motor, spec.seed)))
        throw new Error("Motor sessions require the dedicated superflat world and their isolated stage arena");
    }
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
    if (spec.motorResume &&
        store.getRun(spec.motorResume)?.world?.generationId !== world?.generationId)
      throw new Error("Select the checkpoint run's recorded world generation before continuing training");
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
  const goalModels = new GoalModelManager(
    resolve(config.artifactDir, "goal-models"),
    root,
    config.PYTHON_PATH,
    datasets,
  );
  app.get("/goal-models", async () => goalModels.snapshot());
  app.post("/goal-models/:id/reload", async (req) =>
    goalModels.reload((req.params as { id: string }).id),
  );
  app.post("/goal-models", async (req) => goalModels.start(req.body));
  app.post("/goal-models/:id/cancel", async (req) =>
    goalModels.cancel((req.params as { id: string }).id),
  );
  app.post("/goal-models/:id/rerun", async (req) =>
    goalModels.rerun((req.params as { id: string }).id),
  );
  app.post("/goal-models/:id/predict", async (req) =>
    goalModels.predict((req.params as { id: string }).id, req.body),
  );
  app.get("/goal-models/:id/artifacts/:file", async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    reply.header("content-disposition", `attachment; filename="${id}-${file}"`);
    reply.type(
      file.endsWith(".json")
        ? "application/json"
        : file.endsWith(".jsonl")
          ? "application/x-ndjson"
          : "application/octet-stream",
    );
    return reply.send(createReadStream(goalModels.artifact(id, file)));
  });
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
  app.get("/runs/:id/agents/:username/sound", async (req) => {
    const { id, username } = z.object({
      id: z.uuid(),
      username: z.string().regex(/^rl_[a-f0-9]{6}_\d{1,3}$/),
    }).parse(req.params);
    return scheduler.soundAgent(id, username);
  });
  app.post("/runs/:id/agents/:username/sound", async (req) => {
    const { id, username } = z.object({
      id: z.uuid(),
      username: z.string().regex(/^rl_[a-f0-9]{6}_\d{1,3}$/),
    }).parse(req.params);
    const { muted } = z.object({ muted: z.boolean() }).strict().parse(req.body);
    return scheduler.soundAgent(id, username, muted);
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
  app.post("/phase0/preview", async (req, reply) => {
    const existing = store
      .runs(1000)
      .find(
        (run) =>
          run.spec.preview &&
          ["queued", "running", "paused", "pausing"].includes(run.status),
      );
    if (existing) return existing;
    const { backend } = z
      .object({
        backend: z.enum(["mineflayer", "fabric"]).default("mineflayer"),
      })
      .strict()
      .parse(req.body ?? {});
    const spec = runSchema.parse({
      stage: "movement",
      mode: "minecraft",
      backend,
      component: "environment",
      agents: 1,
      episodes: 1,
      ticksPerEpisode: 1,
      tickMs: 1000,
      seed: 42,
    });
    return reply.code(201).send(await enqueue({ ...spec, preview: true }));
  });
  const motorWorldName = "MLCraft Motor Superflat";
  async function motorWorldState() {
    const catalog = await worlds.catalog();
    const profile = catalog.profiles.find((profile) => profile.id === catalog.active?.profileId);
    const generation = profile?.generations.find((generation) => generation.id === catalog.active?.generationId);
    const ready = profile?.name === motorWorldName && generation?.settings.type === "flat" && server.state.status === "running" && !!server.state.arenaReady;
    return { ready, profile: profile?.name, server: server.state.status,
      reason: ready ? "" : profile?.name !== motorWorldName ? "Prepare the dedicated motor superflat world" : server.state.status !== "running" ? "Start the Minecraft server" : "Arena plugin is unavailable" };
  }
  app.get("/phase3a/world", motorWorldState);
  let motorWorldPreparation: Promise<void> | undefined;
  async function prepareMotorWorld() {
    if ((await motorWorldState()).ready) return;
    if (motorWorldPreparation) return motorWorldPreparation;
    motorWorldPreparation = (async () => {
    if (scheduler.hasMinecraftWorkers() || store.queued().some((run) => run.spec.mode === "minecraft"))
      throw new Error("Finish or cancel active Minecraft runs before switching to the motor world");
    if (server.state.status === "running") await server.stop();
    const catalog = await worlds.catalog();
    const existing = catalog.profiles.find((profile) => profile.name === motorWorldName);
    if (existing) await worlds.activate(existing.id, existing.generations[0].id);
    else await worlds.create({
      name: motorWorldName,
      settings: {
        type: "flat", seed: "31415926", difficulty: "peaceful", gamemode: "survival", structures: false,
        flat: { biome: "minecraft:plains", layers: [
          { block: "minecraft:bedrock", height: 1 },
          { block: "minecraft:dirt", height: 2 },
          { block: "minecraft:grass_block", height: 1 },
        ] },
      },
    });
    await server.start();
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const state = await motorWorldState();
      if (state.ready) return;
      if (server.state.status === "failed") throw new Error("Motor world server failed to start");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Motor world server did not become ready");
    })().finally(() => { motorWorldPreparation = undefined; });
    return motorWorldPreparation;
  }
  app.post("/phase3a/world", async () => { await prepareMotorWorld(); return motorWorldState(); });
  function motorSessionSpec(
    settings: Pick<MotorFullRunStage, "session" | "agents" | "episodes" | "ticksPerEpisode" | "tickMs" | "seed" | "backend">,
    sourceRunId?: string,
    fullRun?: { id: string; stage: number },
  ) {
    return runSchema.parse({
      stage: "motor", motor: settings.session, mode: "minecraft",
      component: settings.session === "M8" ? "evaluation" : "pipeline",
      ...(sourceRunId ? { motorSource: sourceRunId } : {}),
      ...(fullRun ? { motorFullRunId: fullRun.id, motorFullRunStage: fullRun.stage } : {}),
      agents: settings.agents, episodes: settings.episodes,
      ticksPerEpisode: settings.ticksPerEpisode, tickMs: settings.tickMs,
      seed: settings.seed, backend: settings.backend,
      arena: motorArena(settings.session, settings.seed),
      rules: { ...DEFAULT_TRAINING_RULES, noHungerLoss: true, pvp: false, fallDamage: false, drowningDamage: false,
        difficulty: "peaceful", world: { doMobSpawning: false, doDaylightCycle: false, doWeatherCycle: false } },
    });
  }
  app.post("/phase3a/sessions", async (req, reply) => {
    const { session, agents, episodes, ticksPerEpisode, tickMs, seed, backend } = z.object({
      session: z.enum(["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"]),
      agents: z.number().int().min(1).max(config.MAX_AGENTS).default(Math.min(32, config.MAX_AGENTS)),
      episodes: z.number().int().min(1).max(100000).default(64),
      ticksPerEpisode: z.number().int().min(1).max(100000).default(80),
      tickMs: z.number().int().min(20).max(5000).default(100),
      seed: z.number().int().min(0).max(2147483647).default(42),
      backend: z.enum(["mineflayer", "fabric"]).default("mineflayer"),
    }).strict().parse(req.body ?? {});
    await prepareMotorWorld();
    if (!motorSessions.some((entry) => entry.id === session)) throw new Error("Unknown motor session");
    const previous = Number(session.slice(1)) - 1;
    const source = previous >= 0 ? store.runs(1000).find((run) => run.status === "completed" && run.spec.stage === "motor" && run.spec.motor === `M${previous}`) : undefined;
    if (session === "M8" && !source)
      throw new Error("Complete an M7 run before testing generalisation on M8");
    const spec = motorSessionSpec({ session, agents, episodes, ticksPerEpisode, tickMs, seed, backend }, source?.id);
    return reply.code(201).send(await enqueue(spec));
  });
  app.post("/phase3a/resume", async (req, reply) => {
    const { runId, additionalEpisodes } = z.object({
      runId: z.uuid(),
      additionalEpisodes: z.number().int().min(1).max(100000),
    }).strict().parse(req.body);
    const source = store.getRun(runId);
    if (!source || source.spec.stage !== "motor" || source.spec.component !== "pipeline")
      throw new Error("Select a previous M0-M7 training run");
    const checkpoint = JSON.parse(await readFile(resolve(config.artifactDir, runId, "checkpoint.json"), "utf8"));
    const completedEpisodes = checkpoint.resumeState
      ? checkpoint.episode
      : checkpoint.generation * motorTrialPlan(1, source.spec.agents).episodesPerEvolution;
    if (!Number.isSafeInteger(completedEpisodes) || completedEpisodes < 0 ||
        completedEpisodes + additionalEpisodes > 100000)
      throw new Error("Checkpoint cannot continue for the requested number of episodes");
    const spec = runSchema.parse({
      ...source.spec,
      motorSource: undefined,
      motorResume: runId,
      episodes: completedEpisodes + additionalEpisodes,
      startPaused: false,
    });
    return reply.code(201).send(await enqueue(spec, source.world?.generationId, source.backend?.revision));
  });
  function saveFullRun(plan: MotorFullRun) {
    plan.updatedAt = new Date().toISOString();
    store.saveMotorFullRun(plan);
  }
  async function fullRunOutcome(run: Run, stage: MotorFullRunStage) {
    const priorCompleted = stage.runIds.slice(0, -1)
      .findLastIndex((id) => store.getRun(id)?.status === "completed");
    const segments = [] as Array<Array<{ episode: number; trials: number; successes: number }>>;
    for (const id of stage.runIds.slice(priorCompleted + 1)) {
      const body = await readFile(resolve(config.artifactDir, id, "motor-trials.jsonl"), "utf8");
      segments.push(body.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    }
    const { episodeCount, successRate } = summarizeMotorTrials(segments, stage.episodes);
    const checkpoint = JSON.parse(await readFile(resolve(config.artifactDir, run.id, "checkpoint.json"), "utf8"));
    const bestFitness = Number(checkpoint.bestFitness);
    if (!Number.isFinite(bestFitness) || episodeCount !== stage.episodes)
      throw new Error(`Stage ${stage.session} has no usable trial or fitness results`);
    return { successRate, bestFitness };
  }
  async function fullRunContinuation(run: Run, stage: MotorFullRunStage, interrupted: boolean) {
    if (stage.session === "M8") return undefined;
    try {
      const checkpoint = JSON.parse(await readFile(resolve(config.artifactDir, run.id, "checkpoint.json"), "utf8"));
      const completed = checkpoint.resumeState
        ? checkpoint.episode
        : checkpoint.generation * motorTrialPlan(1, stage.agents).episodesPerEvolution;
      if (!Number.isSafeInteger(completed) || completed < 0)
        throw new Error("Checkpoint has no recoverable episode");
      const target = interrupted
        ? Math.max(run.spec.episodes, completed + 1)
        : completed + stage.episodes;
      if (target > 100000) throw new Error("Full Run exceeds the 100,000 episode limit");
      return runSchema.parse({
        ...run.spec, motorSource: undefined, motorResume: run.id,
        episodes: target, startPaused: false,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }
  let fullRunTicking = false;
  let fullRunClosing = false;
  async function advanceFullRuns() {
    if (fullRunTicking || fullRunClosing) return;
    fullRunTicking = true;
    try {
      for (const plan of store.motorFullRuns(1000).filter((entry) => entry.status === "running")) {
        try {
          if (plan.stageIndex >= plan.stages.length) {
            plan.status = "completed";
            saveFullRun(plan);
            continue;
          }
          const stage = plan.stages[plan.stageIndex];
          const orphan = store.runs(1000).find((run) =>
            run.spec.motorFullRunId === plan.id &&
            run.spec.motorFullRunStage === plan.stageIndex &&
            !stage.runIds.includes(run.id));
          if (orphan) {
            stage.runIds.push(orphan.id);
            saveFullRun(plan);
          }
          const last = stage.runIds.length
            ? store.getRun(stage.runIds.at(-1)!) : undefined;
          if (stage.runIds.length && !last)
            throw new Error(`Full Run stage ${stage.session} lost its recorded run`);
          if (last && ["queued", "running", "paused", "pausing"].includes(last.status)) continue;
          if (scheduler.hasMinecraftWorkers()) continue;
          if (last?.status === "completed") {
            plan.retryRequested = false;
            const outcome = await fullRunOutcome(last, stage);
            stage.lastSuccessRate = outcome.successRate;
            stage.lastBestFitness = outcome.bestFitness;
            saveFullRun(plan);
            if (outcome.successRate >= stage.minSuccessRate &&
                (stage.minBestFitness === undefined || outcome.bestFitness >= stage.minBestFitness)) {
              plan.stageIndex++;
              if (plan.stageIndex === plan.stages.length) plan.status = "completed";
              saveFullRun(plan);
              continue;
            }
            const completedAttempts = stage.runIds.filter((id) => store.getRun(id)?.status === "completed").length;
            if (completedAttempts >= stage.maxAttempts) {
              plan.status = "failed";
              plan.error = `${stage.session} did not meet its conditions after ${completedAttempts} attempt${completedAttempts === 1 ? "" : "s"}: success ${(outcome.successRate * 100).toFixed(1)}%, best fitness ${outcome.bestFitness.toFixed(2)}`;
              saveFullRun(plan);
              continue;
            }
          } else if (last && last.status !== "interrupted" && last.status !== "failed" && last.status !== "cancelled") {
            throw new Error(`Unexpected run state ${last.status}`);
          } else if (last?.status === "failed" || last?.status === "cancelled") {
            if (!plan.retryRequested) {
              plan.status = "paused";
              plan.error = `${stage.session} run ${last.id.slice(0, 8)} ${last.status}. Resume the Full Run to retry this stage.`;
              saveFullRun(plan);
              continue;
            }
            plan.retryRequested = false;
            saveFullRun(plan);
          }
          const previous = plan.stageIndex
            ? plan.stages[plan.stageIndex - 1].runIds.at(-1) : undefined;
          if (plan.stageIndex && (!previous || store.getRun(previous)?.status !== "completed"))
            throw new Error(`Previous stage checkpoint for ${stage.session} is unavailable`);
          await prepareMotorWorld();
          if (fullRunClosing) return;
          const spec = last
            ? (await fullRunContinuation(last, stage, last.status !== "completed"))
              ?? motorSessionSpec(stage, previous, { id: plan.id, stage: plan.stageIndex })
            : motorSessionSpec(stage, previous, { id: plan.id, stage: plan.stageIndex });
          const run = await enqueue(spec);
          stage.runIds.push(run.id);
          plan.error = undefined;
          saveFullRun(plan);
        } catch (error) {
          plan.status = "paused";
          plan.error = (error as Error).message;
          saveFullRun(plan);
        }
      }
    } finally {
      fullRunTicking = false;
    }
  }
  app.get("/phase3a/full-runs", async () => store.motorFullRuns());
  app.post("/phase3a/full-runs", async (req, reply) => {
    const { stages: configured } = fullRunRequestSchema.parse(req.body);
    if (store.motorFullRuns(1000).some((plan) => ["running", "paused"].includes(plan.status)))
      throw new Error("Finish or stop the existing Phase 3A Full Run first");
    if (store.runs(1000).some((run) => run.spec.mode === "minecraft" &&
        ["queued", "running", "paused", "pausing"].includes(run.status)))
      throw new Error("Finish or cancel active Minecraft runs before starting a Full Run");
    configured.forEach((stage) => {
      validateArenaRun(motorSessionSpec(stage));
      if (stage.backend === "fabric" && stage.agents > config.MAX_RENDER_CLIENTS)
        throw new Error(`${stage.session} exceeds the rendered-client limit ${config.MAX_RENDER_CLIENTS}`);
    });
    const now = new Date().toISOString();
    const plan: MotorFullRun = {
      id: randomUUID(), status: "running", stageIndex: 0,
      stages: configured.map((stage) => ({ ...stage, runIds: [] })),
      createdAt: now, updatedAt: now,
    };
    store.saveMotorFullRun(plan);
    void advanceFullRuns();
    return reply.code(201).send(plan);
  });
  app.post("/phase3a/full-runs/:id/:action", async (req) => {
    const { id, action } = z.object({
      id: z.uuid(), action: z.enum(["pause", "resume", "cancel"]),
    }).parse(req.params);
    const plan = store.motorFullRun(id);
    if (!plan) throw new Error("Full Run not found");
    if (action === "pause" && plan.status === "running") {
      plan.status = "paused";
      plan.error = undefined;
    } else if (action === "resume" && plan.status === "paused") {
      plan.status = "running";
      plan.error = undefined;
      const stage = plan.stages[plan.stageIndex];
      const last = stage?.runIds.length ? store.getRun(stage.runIds.at(-1)!) : undefined;
      plan.retryRequested = last?.status === "failed" || last?.status === "cancelled";
    } else if (action === "cancel" && ["running", "paused"].includes(plan.status)) {
      plan.status = "cancelled";
      saveFullRun(plan);
      const stage = plan.stages[plan.stageIndex];
      const run = stage?.runIds.length ? store.getRun(stage.runIds.at(-1)!) : undefined;
      if (run && ["queued", "running", "paused", "pausing"].includes(run.status)) {
        try {
          scheduler.action(run.id, "cancel");
        } catch (error) {
          if (store.getRun(run.id)?.status !== "completed") throw error;
        }
      }
      return plan;
    } else throw new Error(`Cannot ${action} a ${plan.status} Full Run`);
    saveFullRun(plan);
    if (action === "resume") void advanceFullRuns();
    return plan;
  });
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
          "evolution.jsonl",
          "motor-trials.jsonl",
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
  const fullRunTimer = setInterval(() => void advanceFullRuns(), 2000);
  const prune = setInterval(() => store.prune(), 60000);
  app.addHook("onClose", async () => {
    fullRunClosing = true;
    clearInterval(fullRunTimer);
    clearInterval(hud);
    clearInterval(sample);
    clearInterval(prune);
    lag.disable();
    await scheduler.close();
    await preparation.close();
    await inputPreparation.close();
    await fabricPreparation.close();
    await datasets.close();
    await goalModels.close();
    await server.stop();
    await archive.close();
    store.close();
  });
  app.addHook("onReady", async () => {
    archive.start();
    scheduler.pump();
    void advanceFullRuns();
  });
  return { app, store, scheduler, server, worlds };
}
