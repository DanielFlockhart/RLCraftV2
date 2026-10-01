import { mkdir, writeFile, appendFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type {
  AgentState,
  Environment,
  Run,
  WorkerMessage,
  Policy,
  TrainingTiming,
  PlaybackCommand,
  AgentInputFrame,
  CaptureFrame,
  ArenaPoint,
} from "@mlcraft/core";
import {
  motorDelta,
  motorReachedTarget,
  motorReward,
  motorTarget,
  motorTrialPlan,
} from "../../../packages/core/src/motor.js";
import {
  effectiveStepMs,
  DEFAULT_AGENT_SETUP,
  defaultInputs,
} from "@mlcraft/core";
import { initialPlayback, changePlayback } from "./playback.js";
import { trainingPlugins } from "../../../packages/agents/src/registry.js";
import { prepareStage, reward } from "../../../packages/agents/src/stages.js";
import { inspectModels } from "../../../packages/agents/src/inspection.js";
import { backendRegistry } from "./backends.js";
import { config } from "./config.js";
import { arenaSpawn } from "../../../packages/core/src/arenas.js";
const run = JSON.parse(process.env.RUN_PAYLOAD!) as Run;
const spec = run.spec;
const setup =
  spec.setup ?? (spec.mode === "minecraft" ? DEFAULT_AGENT_SETUP : undefined);
const memberSetup = (index: number) =>
  setup && {
    ...setup,
    ...(spec.arena ? { spawn: arenaSpawn(spec.arena, index) } : {}),
  };
let playback = run.playback ?? initialPlayback(spec);
const policyObservation = (
  observation: import("@mlcraft/core").Observation,
  target?: ArenaPoint,
): import("@mlcraft/core").PolicyObservation => {
  if (!observation.inputs)
    throw new Error("Environment must expose selected agent input channels");
  return {
    tick: observation.tick,
    inputs: observation.inputs,
    ...(target ? { motor: motorDelta(observation, target) } : {}),
  };
};
let forceEndGeneration = false;
let playbackJournal: Promise<void> = Promise.resolve();
let inputJournal: Promise<void> = Promise.resolve();
async function recordInputs(
  username: string,
  phase: string,
  frame: AgentInputFrame | undefined,
) {
  if (!spec.inputs?.record || !frame) return;
  inputJournal = inputJournal.then(() =>
    appendFile(
      resolve(dir, "inputs.jsonl"),
      JSON.stringify({ username, phase, frame }) + "\n",
    ),
  );
  await inputJournal;
}
const send = (m: WorkerMessage) => {
  if (process.connected) process.send?.(m);
};
const setupRequests = new Map<
  string,
  {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function requestSetup(username: string) {
  const requestId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      setupRequests.delete(requestId);
      reject(new Error("Control service did not acknowledge agent setup"));
    }, 15000);
    setupRequests.set(requestId, { resolve, reject, timer });
    send({ type: "agent-setup", requestId, username });
  });
}
function requestRules() {
  const requestId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      setupRequests.delete(requestId);
      reject(new Error("Training rules acknowledgement timed out"));
    }, 15000);
    setupRequests.set(requestId, { resolve, reject, timer });
    send({ type: "rules-apply", requestId });
  });
}
function requestArena(username?: string) {
  const requestId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        setupRequests.delete(requestId);
        reject(new Error("Arena control acknowledgement timed out"));
      },
      username ? 20000 : 315000,
    );
    setupRequests.set(requestId, { resolve, reject, timer });
    send(
      username
        ? { type: "arena-spawn", requestId, username }
        : { type: "arena-build", requestId },
    );
  });
}
let paused = spec.startPaused ?? false,
  stopping = false;
process.on(
  "message",
  async (m: {
    type: string;
    username?: string;
    frame?: CaptureFrame;
    requestId?: string;
    muted?: boolean;
    error?: string;
    command?: PlaybackCommand;
  }) => {
    if (m.type === "sound-request") {
      try {
        const member = members.find(
          (member) => member.state.username === m.username,
        );
        if (!member?.env.sound)
          throw new Error("Agent sound control is unavailable");
        const result = await bounded(member.env.sound(m.muted), 4500);
        send({ type: "sound", requestId: m.requestId!, muted: result.muted });
      } catch (error) {
        send({
          type: "sound",
          requestId: m.requestId!,
          error: (error as Error).message,
        });
      }
      return;
    }
    if (m.type === "feed-request") {
      try {
        const member = members.find(
          (member) => member.state.username === m.username,
        );
        if (!member) throw new Error("Agent is not connected");
        const frame = member.env.feed
          ? await bounded(member.env.feed(), 4500)
          : undefined;
        send({ type: "feed", requestId: m.requestId!, frame });
      } catch (error) {
        send({
          type: "feed",
          requestId: m.requestId!,
          error: (error as Error).message,
        });
      }
      return;
    }
    if (m.type === "observation-request" || m.type === "capture") {
      const member = members.find(
        (member) => member.state.username === m.username,
      );
      try {
        if (!member) throw new Error("Agent is not connected");
        if (m.type === "capture") {
          if (!member.env.capture || !m.frame)
            throw new Error("Capture provider is unavailable");
          await bounded(Promise.resolve(member.env.capture(m.frame)), 4500);
        }
        send({
          type: "observation",
          requestId: m.requestId!,
          frame: (
            await bounded(
              Promise.resolve(member.env.observe(member.state.ticks)),
              4500,
            )
          ).inputs,
        });
      } catch (error) {
        send({
          type: "observation",
          requestId: m.requestId!,
          error: (error as Error).message,
        });
      }
      return;
    }
    if (m.type === "setup-result" && m.requestId) {
      const request = setupRequests.get(m.requestId);
      if (request) {
        clearTimeout(request.timer);
        setupRequests.delete(m.requestId);
        m.error ? request.reject(new Error(m.error)) : request.resolve();
      }
    }
    if (m.type === "playback" && m.requestId && m.command) {
      try {
        if (
          m.command.action === "end-generation" &&
          (!timingEpisode ||
            timingPhase === "finishing" ||
            timingPhase === "between")
        )
          throw new Error("No active generation to end");
        playback = changePlayback(playback, m.command, spec, paused);
        if (m.command.action === "advance") paused = false;
        if (m.command.action === "end-generation") {
          forceEndGeneration = true;
          paused = true;
        }
        const event = {
          at: Date.now(),
          episode: timingEpisode,
          tick: timingTick,
          command: m.command,
          playback: structuredClone(playback),
        };
        playbackJournal = playbackJournal
          .then(async () => {
            await mkdir(dir, { recursive: true });
            await appendFile(
              resolve(dir, "controls.jsonl"),
              JSON.stringify(event) + "\n",
            );
          })
          .catch((error) => {
            send({
              type: "log",
              level: "error",
              message: `Cannot record playback change: ${error.message}`,
            });
            stopping = true;
          });
        send({
          type: "playback",
          requestId: m.requestId,
          playback: structuredClone(playback),
        });
      } catch (error) {
        send({
          type: "playback",
          requestId: m.requestId,
          playback: structuredClone(playback),
          error: (error as Error).message,
        });
      }
    }
    if (m.type === "pause") {
      paused = true;
      delete playback.manual;
    }
    if (m.type === "resume") {
      paused = false;
      delete playback.manual;
    }
    if (m.type === "cancel") {
      stopping = true;
      paused = false;
    }
  },
);
// Parent loss requests agent cleanup immediately.
process.on("disconnect", () => {
  stopping = true;
  paused = false;
});
process.on("SIGTERM", () => {
  stopping = true;
  paused = false;
});
const dir = resolve(config.artifactDir, run.id);
async function saveCheckpoint(checkpoint: Record<string, unknown>) {
  const path = resolve(dir, "checkpoint.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(checkpoint, null, 2), {
    flag: "wx",
  });
  await rename(temporary, path);
}
const plugin = trainingPlugins[spec.stage];
const trainer = plugin.createTrainer(spec);
const members: Array<{
  state: AgentState;
  env: Environment;
  policy: Policy;
  target?: ArenaPoint;
  motorTrialActive?: boolean;
  motorTrialDone?: boolean;
  motorSuccess?: boolean;
  motorSuccessSteps?: number;
}> = [];
function reportAgents() {
  send({ type: "agents", agents: members.map((m) => ({ ...m.state })) });
}
function meanAgentReward() {
  const evaluated =
    spec.stage === "motor"
      ? members.filter((member) => member.motorTrialActive)
      : members;
  return evaluated.length
    ? evaluated.reduce((sum, member) => sum + member.state.reward, 0) /
        evaluated.length
    : 0;
}
let lastModelSample = 0;
async function reportModels(force = false) {
  // Motor genomes only change when assignments rotate or evolution completes.
  if (spec.stage === "motor" && !force) return;
  if (!force && Date.now() - lastModelSample < 2000) return;
  const snapshot: import("@mlcraft/core").ModelSnapshot = {
    source: "runtime",
    stage: spec.stage,
    runId: run.id,
    episode: timingEpisode,
    tick: timingTick,
    sampledAt: Date.now(),
    variants: await inspectModels(
      spec.stage,
      spec.component === "environment"
        ? []
        : members.map((m) => ({
            username: m.state.username,
            policy: m.policy,
          })),
      spec.component === "pipeline" ? trainer : undefined,
    ),
  };
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json) > 1048576)
    throw new Error(
      "Combined model metadata exceeds 1 MiB; reduce inspector detail",
    );
  await writeFile(resolve(dir, "models.json.tmp"), json);
  await rename(resolve(dir, "models.json.tmp"), resolve(dir, "models.json"));
  send({ type: "models", snapshot });
  lastModelSample = Date.now();
}
async function updateObservation(member: (typeof members)[number]) {
  const observation = await bounded(
    Promise.resolve(member.env.observe(member.state.ticks)),
    5000,
  );
  Object.assign(member.state, {
    health: observation.health,
    food: observation.food,
    inventory: observation.inventory,
    position: observation.position,
  });
}
async function respawnMember(member: (typeof members)[number], index: number) {
  member.state.status = "dead";
  reportAgents();
  send({
    type: "log",
    level: "warn",
    message: `${member.state.username} died; respawning now.`,
  });
  await bounded(member.env.apply({}), 5000);
  if (!member.env.respawn)
    throw new Error(`Backend cannot respawn ${member.state.username}`);
  member.state.status = "resetting";
  reportAgents();
  await bounded(member.env.respawn(), 20000);
  if (spec.arena)
    await bounded(member.env.teleport!(arenaSpawn(spec.arena, index)));
  await updateObservation(member);
  if (member.state.health <= 0)
    throw new Error(`${member.state.username} remained dead after respawn`);
  member.state.status = paused ? "paused" : "active";
  reportAgents();
  send({
    type: "log",
    level: "info",
    message: `${member.state.username} respawned.`,
  });
}
const bounded = async <T>(promise: Promise<T>, ms = 30000): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Component exceeded ${ms}ms deadline`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout!);
  }
};
const started = performance.now();
let generationStarted = started,
  generationPausedMs = 0;
let timingEpisode = 0,
  timingTick = 0;
let trainingElapsedMs = 0;
let timingPhase: TrainingTiming["phase"] = "preparing";
let timingAdvancing = false,
  lastGenerationMs: number | undefined;
function reportTiming() {
  send({
    type: "timing",
    episode: timingEpisode,
    timing: {
      sampledAt: Date.now(),
      totalElapsedMs: performance.now() - started,
      generationElapsedMs:
        (timingPhase === "finishing" || timingPhase === "between") &&
        lastGenerationMs !== undefined
          ? lastGenerationMs
          : timingEpisode === 0
            ? 0
            : Math.max(
                0,
                performance.now() - generationStarted - generationPausedMs,
              ),
      lastGenerationMs,
      tick: timingTick,
      ticks: playback.ticksPerGeneration,
      trainingElapsedMs,
      phase: timingPhase,
      advancing: timingAdvancing,
    },
  });
  send({
    type: "playback",
    requestId: "",
    playback: structuredClone(playback),
  });
}
async function main() {
  reportTiming();
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "controls.jsonl"), "", { flag: "wx" }).catch(
    (error) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  await writeFile(resolve(dir, "config.json"), JSON.stringify(run, null, 2));
  send({
    type: "log",
    level: "info",
    message:
      spec.stage === "motor"
        ? `Minecraft motor session ${spec.motor}: NEAT population evolves from target-reaching rewards.`
        : `${spec.mode} · ${spec.component} · ${spec.stage}. Policy and trainer are placeholders; no learning is performed.`,
  });
  try {
    const registry = await backendRegistry;
    const backend =
      run.backend ??
      registry.select(
        {
          ...spec,
          backend:
            spec.backend ??
            (spec.mode === "simulator" ? "simulator" : "mineflayer"),
        },
        config.MC_VERSION,
      );
    // Legacy runs acquire a runtime snapshot while retaining their original default backend.
    run.backend = backend;
    await writeFile(resolve(dir, "config.json"), JSON.stringify(run, null, 2));
    send({
      type: "log",
      level: "info",
      message: `Agent backend: ${backend.descriptor.label} ${backend.descriptor.version} (${backend.revision.slice(0, 12)}).`,
    });
    if (spec.mode === "minecraft" && spec.rules) await bounded(requestRules());
    if (spec.arena) await bounded(requestArena(), 320000);
    for (let i = 0; i < spec.agents && !stopping; i++) {
      const username = `rl_${run.id.slice(0, 6)}_${i}`;
      const env: Environment = await bounded(
        registry.create(backend, {
          mode: spec.mode,
          runId: run.id,
          username,
          connection: {
            host: config.MC_HOST,
            port: config.MC_PORT,
            version: config.MC_VERSION,
            auth: config.MC_AUTH,
          },
          inputs: spec.inputs ?? structuredClone(defaultInputs),
          render: spec.render,
          assetDirectory: resolve(config.dataDir, "observation-assets"),
          managed: {
            applySetup: () => requestSetup(username),
            moveToArena: () => requestArena(username),
          },
        }),
      );
      const state: AgentState = {
        id: `${run.id}:${i}`,
        runId: run.id,
        username,
        status: "connecting",
        ticks: 0,
        reward: 0,
        health: 20,
      };
      const member = {
        state,
        env,
        policy: plugin.createPolicy(username, spec),
      };
      members.push(member);
      if (spec.mode === "minecraft") {
        const supported = !!env.watchProgress && config.MC_VERSION === "1.18.1";
        send({
          type: "progress-tracker",
          agent: {
            runId: run.id,
            agentId: state.id,
            username,
            backend: backend.descriptor.id,
            minecraftVersion: config.MC_VERSION,
            supported,
            startedAt: Date.now(),
            ...(!supported
              ? {
                  reason:
                    "This backend/version does not supply the 1.18.1 progress evidence hook.",
                }
              : {}),
          },
        });
        if (supported)
          env.watchProgress!((evidence) =>
            send({
              type: "game-progress",
              record: {
                ...evidence,
                runId: run.id,
                agentId: state.id,
                username,
                episode: timingEpisode,
                minecraftVersion: config.MC_VERSION,
              },
            }),
          );
      }
      reportAgents();
      await bounded(
        env.connect(),
        backend.descriptor.id === "fabric" ? 120000 : 30000,
      );
      state.status = "resetting";
      await updateObservation(member);
      reportAgents();
      if (setup && env.reset) await bounded(env.reset(memberSetup(i)!));
      if (spec.arena) await bounded(env.teleport!(arenaSpawn(spec.arena, i)));
      state.status = "active";
      await updateObservation(member);
      reportAgents();
      send({
        type: "log",
        level: "info",
        message: `${username} spawned and ready at ${Object.values(
          state.position!,
        )
          .map((value) => value.toFixed(1))
          .join(", ")}.`,
      });
    }
    if (stopping) return;
    if (spec.preview) {
      send({
        type: "log",
        level: "info",
        message:
          "Phase 0 preview ready. Agent is idle; no training steps or checkpoints will run.",
      });
      while (!stopping) {
        await sleep(500);
        for (const [index, member] of members.entries()) {
          try {
            await updateObservation(member);
            reportAgents();
          } catch (error) {
            send({
              type: "log",
              level: "warn",
              message: `Preview observation unavailable: ${(error as Error).message}`,
            });
            continue;
          }
          if (member.state.health <= 0) await respawnMember(member, index);
        }
      }
      return;
    }
    if (spec.component === "environment") {
      await prepareStage(spec.stage, 1);
      send({
        type: "log",
        level: "info",
        message:
          "Environment connectivity check completed; configured starting state and arena placement are applied. Task-specific preparation is an extension hook.",
      });
    }
    let lastSample = performance.now(),
      sampleSteps = 0,
      tickTotal = 0,
      tickCount = 0;
    async function hold() {
      if (!paused) return;
      for (const m of members) {
        await bounded(m.env.apply({}));
        if (m.state.status !== "dead") m.state.status = "paused";
      }
      reportAgents();
      const pauseStarted = performance.now();
      timingAdvancing = false;
      reportTiming();
      send({ type: "paused" });
      const limitReached = () =>
        timingPhase === "training" &&
        (timingTick >= playback.ticksPerGeneration ||
          (playback.generationSeconds !== undefined &&
            trainingElapsedMs >= playback.generationSeconds * 1000));
      let lastDeathCheck = 0;
      while (paused && !stopping && !forceEndGeneration && !limitReached()) {
        await reportModels();
        if (Date.now() - lastDeathCheck >= 500) {
          for (const [index, member] of members.entries()) {
            await updateObservation(member);
            if (member.state.health <= 0) await respawnMember(member, index);
          }
          lastDeathCheck = Date.now();
        }
        await sleep(50);
      }
      generationPausedMs += performance.now() - pauseStarted;
      if (stopping || forceEndGeneration || (paused && limitReached())) return;
      for (const m of members)
        if (m.state.status !== "dead") m.state.status = "active";
      reportAgents();
      timingAdvancing = timingPhase !== "between";
      reportTiming();
      send({ type: "resumed" });
      lastSample = performance.now();
      sampleSteps = 0;
      tickTotal = 0;
      tickCount = 0;
    }
    const firstEpisode = spec.motorResume
      ? Number((await bounded(trainer.checkpoint())).episode) + 1
      : 1;
    if (firstEpisode > 1)
      send({ type: "progress", episode: firstEpisode - 1, progress: (firstEpisode - 1) / spec.episodes });
    for (let episode = firstEpisode; episode <= spec.episodes && !stopping; episode++) {
      if (episode > firstEpisode) await hold();
      if (stopping) break;
      timingEpisode = episode;
      timingTick = 0;
      generationStarted = performance.now();
      generationPausedMs = 0;
      trainingElapsedMs = 0;
      timingPhase = "preparing";
      timingAdvancing = true;
      reportTiming();
      send({
        type: "log",
        level: "info",
        message: `Preparing ${spec.stage === "motor" ? "trial episode" : "generation"} ${episode}/${spec.episodes}.`,
      });
      await bounded(prepareStage(spec.stage, episode));
      if (episode > firstEpisode) {
        for (const member of members) {
          member.state.status = "resetting";
          await bounded(member.env.apply({}));
          await bounded(member.env.respawn?.() ?? Promise.resolve());
        }
        reportAgents();
      }
      if (episode > firstEpisode && spec.arena?.resetEachEpisode) {
        for (const member of members) await bounded(member.env.apply({}));
        await bounded(requestArena(), 320000);
      }
      if (episode > firstEpisode && setup?.applyEachEpisode)
        for (let i = 0; i < members.length; i++)
          await bounded(members[i].env.reset!(memberSetup(i)!));
      if (spec.stage === "motor")
        for (const member of members) await bounded(member.env.apply({}));
      // Spawn placement resets every generation even when terrain is preserved.
      if (episode > 1 && spec.arena)
        for (let i = 0; i < members.length; i++)
          await bounded(members[i].env.teleport!(arenaSpawn(spec.arena, i)));
      for (const m of members) {
        if (spec.stage === "motor" && spec.motor && spec.arena) {
          const index = Number(
            m.state.id.slice(m.state.id.lastIndexOf(":") + 1),
          );
          const trial = motorTrialPlan(episode, spec.agents);
          m.motorTrialActive =
            trial.batch * spec.agents + index < trial.population;
          m.motorTrialDone = !m.motorTrialActive;
          m.motorSuccess = false;
          m.motorSuccessSteps = undefined;
          m.state.targetReached = false;
          m.state.targetSteps = undefined;
          m.target = motorTarget(
            spec.arena,
            spec.motor,
            index,
            episode,
            spec.seed,
            spec.agents,
          );
        }
        await bounded(m.policy.reset(spec.seed + episode));
        m.state.reward = 0;
        m.state.status = "active";
        await updateObservation(m);
      }
      reportAgents();
      timingPhase = "training";
      await reportModels(true);
      lastSample = performance.now();
      sampleSteps = 0;
      tickTotal = 0;
      tickCount = 0;
      reportTiming();
      send({
        type: "log",
        level: "info",
        message:
          spec.stage === "motor"
            ? `Trial episode ${episode} ready: ${members.filter((member) => member.motorTrialActive).length} genomes are being evaluated.`
            : `Generation ${episode} ready: ${members.length} agents. Waiting for policy actions (placeholder policies remain idle).`,
      });
      let motorAllDone = false;
      for (let tick = 1; !stopping; tick++) {
        await hold();
        if (
          stopping ||
          forceEndGeneration ||
          tick > playback.ticksPerGeneration ||
          (playback.generationSeconds !== undefined &&
            trainingElapsedMs >= playback.generationSeconds * 1000)
        )
          break;
        const began = performance.now();
        const stepMs = effectiveStepMs(spec, playback.speed);
        let completedSteps = 0;
        await Promise.all(
          members.map(async (m, index) => {
            if (spec.stage === "motor" && m.motorTrialDone) return;
            const stepStarted = performance.now();
            const before = await bounded(
              Promise.resolve(m.env.observe(m.state.ticks)),
              5000,
            );
            if (before.health <= 0) {
              if (spec.stage === "motor") m.motorTrialDone = true;
              await respawnMember(m, index);
              return;
            }
            await recordInputs(m.state.username, "before", before.inputs);
            const action =
              spec.component === "environment"
                ? {}
                : await bounded(
                    m.policy.act(policyObservation(before, m.target)),
                    5000,
                  );
            await bounded(m.env.apply(action), 10000);
            // Keep the requested interval from step start without adding a full
            // extra sleep when observation or action processing is already slow.
            const remainingMs = stepMs - (performance.now() - stepStarted);
            if (remainingMs > 0) await sleep(remainingMs);
            const after = await bounded(
              Promise.resolve(m.env.observe(++m.state.ticks)),
              5000,
            );
            await recordInputs(m.state.username, "after", after.inputs);
            const value = m.target
              ? motorReward(before, after, m.target, m.motorSuccess)
              : reward(spec.stage, before, after);
            const reached =
              after.health > 0 &&
              !!m.target &&
              motorReachedTarget(after, m.target);
            m.state.reward += value;
            m.state.health = after.health;
            m.state.food = after.food;
            m.state.inventory = after.inventory;
            m.state.position = after.position;
            if (spec.component === "pipeline")
              await bounded(
                trainer.observe(m.state.id, {
                  observation: policyObservation(before, m.target),
                  action,
                  reward: value,
                  nextObservation: policyObservation(after, m.target),
                  done:
                    reached ||
                    tick >= playback.ticksPerGeneration ||
                    (playback.generationSeconds !== undefined &&
                      trainingElapsedMs + performance.now() - began >=
                        playback.generationSeconds * 1000) ||
                    forceEndGeneration ||
                    after.health <= 0,
                }),
                5000,
              );
            completedSteps++;
            if (spec.stage === "motor" && reached) {
              m.motorTrialDone = true;
              m.motorSuccess = true;
              m.motorSuccessSteps = tick;
              m.state.targetReached = true;
              m.state.targetSteps = tick;
              await bounded(m.env.apply({}), 5000);
            }
            if (after.health <= 0) {
              if (spec.stage === "motor") m.motorTrialDone = true;
              await respawnMember(m, index);
            }
          }),
        );
        sampleSteps += completedSteps;
        const stepDuration = performance.now() - began;
        trainingElapsedMs += stepDuration;
        tickTotal += stepDuration;
        tickCount++;
        const now = performance.now();
        timingTick = tick;
        motorAllDone =
          spec.stage === "motor" &&
          members.every((member) => member.motorTrialDone);
        const generationDone =
          tick >= playback.ticksPerGeneration ||
          (playback.generationSeconds !== undefined &&
            trainingElapsedMs >= playback.generationSeconds * 1000) ||
          forceEndGeneration ||
          motorAllDone;
        if (playback.manual && playback.manual.kind !== "generation") {
          playback.manual.remaining -=
            playback.manual.kind === "steps" ? 1 : stepDuration / 1000;
          if (playback.manual.remaining <= 0) {
            delete playback.manual;
            paused = true;
          }
        }
        if (now - lastSample >= 1000 || generationDone || paused) {
          await reportModels();
          reportTiming();
          const metric = {
            at: Date.now(),
            runId: run.id,
            episode,
            reward: meanAgentReward(),
            stepsPerSecond: sampleSteps / ((now - lastSample) / 1000),
            tickMs: tickTotal / tickCount,
            workerMemoryMb: process.memoryUsage().rss / 1024 / 1024,
          };
          send({
            type: "metric",
            metric,
            agents: members.map((m) => ({ ...m.state })),
          });
          send({
            type: "progress",
            episode,
            progress:
              (episode -
                1 +
                (playback.generationSeconds !== undefined
                  ? Math.min(
                      1,
                      trainingElapsedMs / (playback.generationSeconds * 1000),
                    )
                  : Math.min(1, tick / playback.ticksPerGeneration))) /
              spec.episodes,
          });
          await appendFile(
            resolve(dir, "metrics.jsonl"),
            JSON.stringify(metric) + "\n",
          );
          sampleSteps = 0;
          tickTotal = 0;
          tickCount = 0;
          lastSample = now;
        }
        if (generationDone) break;
      }
      if (!stopping) {
        const report =
          spec.component === "pipeline" || spec.stage === "motor"
            ? await bounded(trainer.endEpisode(episode))
            : {};
        const successful = members.filter((member) => member.motorSuccess);
        const activeTrials = members.filter(
          (member) => member.motorTrialActive,
        ).length;
        const motorOutcome =
          spec.stage === "motor"
            ? {
                trials: activeTrials,
                successes: successful.length,
                successRate: activeTrials
                  ? successful.length / activeTrials
                  : 0,
                meanSuccessSteps: successful.length
                  ? successful.reduce(
                      (sum, member) => sum + (member.motorSuccessSteps ?? 0),
                      0,
                    ) / successful.length
                  : null,
                evolutionGeneration: report.generation ?? 0,
                species: report.species ?? 1,
                bestFitness: report.bestFitness ?? 0,
                generationBestFitness: report.generationBestFitness ?? 0,
              }
            : undefined;
        let motorCheckpoint: Record<string, unknown> | undefined;
        if (spec.stage === "motor") {
          motorCheckpoint = await bounded(trainer.checkpoint());
          await saveCheckpoint({
            ...motorCheckpoint,
            runId: run.id,
            stage: spec.stage,
            seed: spec.seed,
            episode,
            createdAt: new Date().toISOString(),
          });
        }
        if (motorOutcome) {
          const trialMetric: import("@mlcraft/core").Metric = {
            kind: "motor-trial",
            at: Date.now(),
            runId: run.id,
            episode,
            reward: meanAgentReward(),
            stepsPerSecond: 0,
            tickMs: 0,
            workerMemoryMb: process.memoryUsage().rss / 1024 / 1024,
            motor: {
              trials: motorOutcome.trials,
              successes: motorOutcome.successes,
              successRate: motorOutcome.successRate,
              meanSuccessSteps: motorOutcome.meanSuccessSteps,
            },
          };
          send({
            type: "metric",
            metric: trialMetric,
            agents: members.map((m) => ({ ...m.state })),
          });
          await appendFile(
            resolve(dir, "metrics.jsonl"),
            JSON.stringify(trialMetric) + "\n",
          );
          await appendFile(
            resolve(dir, "motor-trials.jsonl"),
            JSON.stringify({ episode, at: trialMetric.at, ...motorOutcome }) +
              "\n",
          );
        }
        if (spec.stage === "motor" && report.generation) {
          const previous = motorTrialPlan(episode, spec.agents).evolution;
          if (report.generation > previous) {
            const speciesHistory = motorCheckpoint?.speciesHistory as
              | Array<{
                  species: NonNullable<
                    import("@mlcraft/core").Metric["neat"]
                  >["speciesDetails"];
                }>
              | undefined;
            const evolutionMetric: import("@mlcraft/core").Metric = {
              kind: "evolution",
              at: Date.now(),
              runId: run.id,
              episode,
              reward: meanAgentReward(),
              stepsPerSecond: 0,
              tickMs: 0,
              workerMemoryMb: process.memoryUsage().rss / 1024 / 1024,
              neat: {
                generation: report.generation,
                species: report.species ?? 1,
                bestFitness: report.bestFitness ?? 0,
                population: report.population ?? Math.max(8, spec.agents),
                generationBestFitness: report.generationBestFitness ?? 0,
                speciesDetails: speciesHistory?.at(-1)?.species,
              },
            };
            send({
              type: "metric",
              metric: evolutionMetric,
              agents: members.map((m) => ({ ...m.state })),
            });
            await appendFile(
              resolve(dir, "metrics.jsonl"),
              JSON.stringify(evolutionMetric) + "\n",
            );
            await appendFile(
              resolve(dir, "evolution.jsonl"),
              JSON.stringify({
                runId: run.id,
                episode,
                at: evolutionMetric.at,
                ...evolutionMetric.neat,
              }) + "\n",
            );
          }
        }
        await reportModels(true);
        await appendFile(
          resolve(dir, "episodes.jsonl"),
          JSON.stringify({
            episode,
            steps: timingTick,
            trainingElapsedMs,
            playback: structuredClone(playback),
            endedBy: forceEndGeneration
              ? "manual"
              : motorAllDone && motorOutcome?.successes === motorOutcome?.trials
                ? "targets-reached"
                : motorAllDone
                  ? "trials-finished"
                  : "limit",
            durationMs:
              performance.now() - generationStarted - generationPausedMs,
            totalElapsedMs: performance.now() - started,
            report,
            ...(motorOutcome ? { motor: motorOutcome } : {}),
            agents: members.map((m) => m.state),
            at: Date.now(),
          }) + "\n",
        );
        lastGenerationMs =
          performance.now() - generationStarted - generationPausedMs;
        if (playback.manual?.kind === "generation") {
          delete playback.manual;
          paused = true;
        }
        if (forceEndGeneration) {
          forceEndGeneration = false;
          paused = true;
        }
        timingPhase = "between";
        timingAdvancing = false;
        reportTiming();
        send({ type: "progress", episode, progress: episode / spec.episodes });
        send({
          type: "log",
          level: "info",
          message: `${spec.stage === "motor" ? "Trial episode" : "Generation"} ${episode} finished after ${timingTick} steps.`,
        });
      }
    }
    if (!stopping) {
      await playbackJournal;
      timingPhase = "finishing";
      timingAdvancing = false;
      reportTiming();
      const checkpoint: Record<string, unknown> = {
        ...(await bounded(trainer.checkpoint())),
        runId: run.id,
        stage: spec.stage,
        seed: spec.seed,
        createdAt: new Date().toISOString(),
      };
      await saveCheckpoint(checkpoint);
      await reportModels(true);
      // The full NEAT population is stored on disk. Keep IPC completion small and
      // wait for the send callback before the worker disconnects.
      await new Promise<void>((resolve, reject) => {
        if (!process.connected)
          return reject(
            new Error("Control service disconnected before completion"),
          );
        process.send?.(
          {
            type: "done",
            checkpoint: {
              kind: checkpoint.kind,
              generation: checkpoint.generation,
              bestFitness: checkpoint.bestFitness,
              runId: run.id,
            },
          },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }
  } finally {
    delete playback.manual;
    timingAdvancing = false;
    reportTiming();
    await Promise.allSettled(
      members.map(async (m) => {
        await bounded(m.env.close(), 2000);
        await bounded(m.policy.close(), 2000);
        m.state.status = "stopped";
      }),
    );
    reportAgents();
  }
}
main()
  .catch((error) => {
    send({
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(() => {
    for (const request of setupRequests.values()) clearTimeout(request.timer);
    setupRequests.clear();
    if (process.connected) process.disconnect();
  });
