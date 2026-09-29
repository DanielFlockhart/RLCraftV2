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
} from "@rlcraft/core";
import {
  effectiveStepMs,
  DEFAULT_AGENT_SETUP,
  defaultInputs,
} from "@rlcraft/core";
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
  observation: import("@rlcraft/core").Observation,
): import("@rlcraft/core").PolicyObservation => {
  if (!observation.inputs)
    throw new Error("Environment must expose selected agent input channels");
  return { tick: observation.tick, inputs: observation.inputs };
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
      username ? 20000 : 130000,
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
    error?: string;
    command?: PlaybackCommand;
  }) => {
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
const plugin = trainingPlugins[spec.stage];
const trainer = plugin.createTrainer();
const members: Array<{
  state: AgentState;
  env: Environment;
  policy: Policy;
}> = [];
function reportAgents() {
  send({ type: "agents", agents: members.map((m) => ({ ...m.state })) });
}
let lastModelSample = 0;
async function reportModels(force = false) {
  if (!force && Date.now() - lastModelSample < 2000) return;
  const snapshot: import("@rlcraft/core").ModelSnapshot = {
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
    message: `${spec.mode} · ${spec.component} · ${spec.stage}. Policy and trainer are placeholders; no learning is performed.`,
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
    if (spec.arena) await bounded(requestArena(), 135000);
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
      const member = { state, env, policy: plugin.createPolicy(username) };
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
      while (paused && !stopping && !forceEndGeneration && !limitReached()) {
        await reportModels();
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
    for (let episode = 1; episode <= spec.episodes && !stopping; episode++) {
      if (episode > 1) await hold();
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
        message: `Preparing generation ${episode}/${spec.episodes}.`,
      });
      await bounded(prepareStage(spec.stage, episode));
      if (episode > 1) {
        for (const member of members) {
          member.state.status = "resetting";
          await bounded(member.env.apply({}));
          await bounded(member.env.respawn?.() ?? Promise.resolve());
        }
        reportAgents();
      }
      if (episode > 1 && spec.arena?.resetEachEpisode) {
        for (const member of members) await bounded(member.env.apply({}));
        await bounded(requestArena(), 135000);
      }
      if (episode > 1 && setup?.applyEachEpisode)
        for (let i = 0; i < members.length; i++)
          await bounded(members[i].env.reset!(memberSetup(i)!));
      // Spawn placement resets every generation even when terrain is preserved.
      if (episode > 1 && spec.arena)
        for (let i = 0; i < members.length; i++)
          await bounded(members[i].env.teleport!(arenaSpawn(spec.arena, i)));
      for (const m of members) {
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
        message: `Generation ${episode} ready: ${members.length} agents. Waiting for policy actions (placeholder policies remain idle).`,
      });
      let allAgentsDead = false;
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
        await Promise.all(
          members.map(async (m) => {
            if (m.state.status === "dead") return;
            const before = await bounded(
              Promise.resolve(m.env.observe(m.state.ticks)),
              5000,
            );
            await recordInputs(m.state.username, "before", before.inputs);
            const action =
              spec.component === "environment"
                ? {}
                : await bounded(m.policy.act(policyObservation(before)), 5000);
            await bounded(m.env.apply(action), 10000);
            // The sample interval lets Minecraft physics advance before observation.
            await sleep(stepMs);
            const after = await bounded(
              Promise.resolve(m.env.observe(++m.state.ticks)),
              5000,
            );
            await recordInputs(m.state.username, "after", after.inputs);
            const value = reward(spec.stage, before, after);
            m.state.reward += value;
            m.state.health = after.health;
            m.state.food = after.food;
            m.state.inventory = after.inventory;
            m.state.position = after.position;
            if (spec.component === "pipeline")
              await bounded(
                trainer.observe(m.state.id, {
                  observation: policyObservation(before),
                  action,
                  reward: value,
                  nextObservation: policyObservation(after),
                  done:
                    tick >= playback.ticksPerGeneration ||
                    (playback.generationSeconds !== undefined &&
                      trainingElapsedMs + performance.now() - began >=
                        playback.generationSeconds * 1000) ||
                    forceEndGeneration ||
                    after.health <= 0,
                }),
                5000,
              );
            if (after.health <= 0) {
              m.state.status = "dead";
              await bounded(m.env.apply({}));
              send({
                type: "log",
                level: "warn",
                message: `${m.state.username} died in generation ${episode}; respawn is scheduled for the next generation.`,
              });
              reportAgents();
            }
          }),
        );
        sampleSteps += members.filter((m) => m.state.status !== "dead").length;
        allAgentsDead = members.every((m) => m.state.status === "dead");
        const stepDuration = performance.now() - began;
        trainingElapsedMs += stepDuration;
        tickTotal += stepDuration;
        tickCount++;
        const now = performance.now();
        timingTick = tick;
        const generationDone =
          tick >= playback.ticksPerGeneration ||
          (playback.generationSeconds !== undefined &&
            trainingElapsedMs >= playback.generationSeconds * 1000) ||
          forceEndGeneration ||
          allAgentsDead;
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
            reward:
              members.reduce((n, m) => n + m.state.reward, 0) / members.length,
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
          spec.component === "pipeline"
            ? await bounded(trainer.endEpisode(episode))
            : {};
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
              : allAgentsDead
                ? "agents-dead"
                : "limit",
            durationMs:
              performance.now() - generationStarted - generationPausedMs,
            totalElapsedMs: performance.now() - started,
            report,
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
          message: `Generation ${episode} finished after ${timingTick} steps${allAgentsDead ? " (all agents died)" : ""}.`,
        });
      }
    }
    if (!stopping) {
      await playbackJournal;
      timingPhase = "finishing";
      timingAdvancing = false;
      reportTiming();
      const checkpoint = {
        ...(await bounded(trainer.checkpoint())),
        runId: run.id,
        stage: spec.stage,
        seed: spec.seed,
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        resolve(dir, "checkpoint.json"),
        JSON.stringify(checkpoint, null, 2),
      );
      await reportModels(true);
      send({ type: "done", checkpoint });
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
