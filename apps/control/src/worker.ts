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
  RunSpec,
} from "@mlcraft/core";
import {
  motorDelta,
  motorReachedTarget,
  motorReward,
  motorTarget,
  motorTrialPlan,
  motorNaturalTarget,
} from "../../../packages/core/src/motor.js";
import {
  combatReward,
  combatSession,
  combatArena,
} from "../../../packages/core/src/combat.js";
import { interactionRequest } from "../../../packages/core/src/interaction.js";
import type { SkillResult } from "../../../packages/core/src/interaction.js";
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
import {
  arenaCellOrigin,
  arenaSpawn,
} from "../../../packages/core/src/arenas.js";
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
    ...(target
      ? { motor: motorDelta(observation, target) }
      : spec.stage === "pvp" && observation.combat?.targets[0]
        ? {
            motor: motorDelta(
              observation,
              observation.combat.targets[0].position,
            ),
          }
        : {}),
    ...(spec.stage === "pvp"
      ? (() => {
          const nearest = observation.combat?.targets[0];
          const second = observation.combat?.targets[1];
          const projectile = observation.combat?.projectiles?.[0];
          const weapon = Object.keys(observation.inventory).find(
            (item) =>
              /_(sword|axe)$/.test(item) ||
              ["bow", "crossbow", "trident"].includes(item),
          );
          const armorMaterial = Object.keys(observation.inventory)
            .find((item) => /_(helmet|chestplate|leggings|boots)$/.test(item))
            ?.split("_")[0];
          return {
            combat: {
              health: observation.health,
              food: observation.food,
              targets: observation.combat?.targets.length ?? 0,
              targetDx: nearest
                ? nearest.position.x - observation.position.x
                : 0,
              targetDy: nearest
                ? nearest.position.y - observation.position.y
                : 0,
              targetDz: nearest
                ? nearest.position.z - observation.position.z
                : 0,
              targetHealth: nearest?.health ?? 0,
              attackReady: observation.combat?.attackReady ?? 0,
              sword: Object.keys(observation.inventory).some((item) =>
                item.endsWith("_sword"),
              )
                ? 1
                : 0,
              axe: Object.keys(observation.inventory).some((item) =>
                item.endsWith("_axe"),
              )
                ? 1
                : 0,
              armor:
                Object.keys(observation.inventory).filter((item) =>
                  /_(helmet|chestplate|leggings|boots)$/.test(item),
                ).length / 4,
              shield: observation.inventory.shield ? 1 : 0,
              targetType: nearest?.type,
              secondType: second?.type,
              secondDx: second ? second.position.x - observation.position.x : 0,
              secondDy: second ? second.position.y - observation.position.y : 0,
              secondDz: second ? second.position.z - observation.position.z : 0,
              targetVx: nearest?.velocity?.x ?? 0,
              targetVy: nearest?.velocity?.y ?? 0,
              targetVz: nearest?.velocity?.z ?? 0,
              targetOnFire: nearest?.onFire ? 1 : 0,
              targetRecentlyHurt: nearest?.recentlyHurt ? 1 : 0,
              creeperFuse: nearest?.creeperFuse ?? 0,
              creeperCharged: nearest?.creeperCharged ? 1 : 0,
              creeperIgnited: nearest?.creeperIgnited ? 1 : 0,
              weapon,
              ammo: observation.inventory.arrow ?? 0,
              itemUseTicks: observation.combat?.itemUseTicks ?? 0,
              weaponLoaded: observation.combat?.weaponLoaded ? 1 : 0,
              projectileCount: observation.combat?.projectiles?.length ?? 0,
              projectileDx: projectile
                ? projectile.position.x - observation.position.x
                : 0,
              projectileDy: projectile
                ? projectile.position.y - observation.position.y
                : 0,
              projectileDz: projectile
                ? projectile.position.z - observation.position.z
                : 0,
              projectileVx: projectile?.velocity.x ?? 0,
              projectileVy: projectile?.velocity.y ?? 0,
              projectileVz: projectile?.velocity.z ?? 0,
              selfOnFire: observation.combat?.selfOnFire ? 1 : 0,
              poisoned: observation.combat?.poisoned ? 1 : 0,
              slowed: observation.combat?.slowed ? 1 : 0,
              withered: observation.combat?.withered ? 1 : 0,
              targetHealthKnown: nearest?.health === undefined ? 0 : 1,
              armorMaterial,
              shieldRaised: observation.combat?.shieldRaised ? 1 : 0,
            },
          };
        })()
      : {}),
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
type CombatStatus = Array<{ alive: number; kills: number }>;
const combatStatusRequests = new Map<string, {
  resolve: (status: CombatStatus) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
function requestCombatStatus(): Promise<CombatStatus> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      combatStatusRequests.delete(requestId);
      reject(new Error("Combat arena status timed out"));
    }, 20000);
    combatStatusRequests.set(requestId, { resolve, reject, timer });
    send({ type: "arena-status", requestId });
  });
}
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
function requestNaturalSpawn(username: string, radius: number) {
  const requestId = randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      setupRequests.delete(requestId);
      reject(new Error("Natural terrain spawn was not acknowledged"));
    }, 15000);
    setupRequests.set(requestId, { resolve, reject, timer });
    send({ type: "natural-spawn", requestId, username, radius });
  });
}
const targetRequests = new Map<
  string,
  {
    resolve: (target: ArenaPoint) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function requestNaturalTarget(
  username: string,
  target: ArenaPoint,
): Promise<ArenaPoint> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      targetRequests.delete(requestId);
      reject(new Error("Natural terrain target lookup timed out"));
    }, 30000);
    targetRequests.set(requestId, { resolve, reject, timer });
    send({ type: "natural-target", requestId, username, target });
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
function requestArena(username?: string, arena?: NonNullable<RunSpec["arena"]>) {
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
        : { type: "arena-build", requestId, arena },
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
    target?: ArenaPoint;
    status?: CombatStatus;
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
      const combatRequest = combatStatusRequests.get(m.requestId);
      if (combatRequest) {
        clearTimeout(combatRequest.timer);
        combatStatusRequests.delete(m.requestId);
        m.error ? combatRequest.reject(new Error(m.error)) : m.status ? combatRequest.resolve(m.status) : combatRequest.reject(new Error("Combat status missing"));
        return;
      }
      const targetRequest = targetRequests.get(m.requestId);
      if (targetRequest) {
        clearTimeout(targetRequest.timer);
        targetRequests.delete(m.requestId);
        m.error
          ? targetRequest.reject(new Error(m.error))
          : m.target
            ? targetRequest.resolve(m.target)
            : targetRequest.reject(
                new Error("Natural target lookup returned no position"),
              );
        return;
      }
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
  combatInitialTargets?: number;
  combatStatusIndex?: number;
}> = [];
function reportAgents() {
  send({ type: "agents", agents: members.map((m) => ({ ...m.state })) });
}
function meanAgentReward() {
  const evaluated =
    spec.stage === "motor" || spec.stage === "pvp"
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
  if ((spec.stage === "motor" || spec.stage === "pvp") && !force) return;
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
  const fullJson = JSON.stringify(snapshot);
  if (Buffer.byteLength(fullJson) > 900000) {
    await writeFile(resolve(dir, "models-detail.json.tmp"), fullJson);
    await rename(resolve(dir, "models-detail.json.tmp"), resolve(dir, "models-detail.json"));
    snapshot.variants = snapshot.variants.map((variant) => ({
      ...variant,
      inspection: {
        ...variant.inspection,
        nodes: [],
        edges: [],
        hyperparameters: {
          ...variant.inspection.hyperparameters,
          detailAvailable: true,
          nodeCount: variant.inspection.nodes.length,
          edgeCount: variant.inspection.edges.length,
        },
      },
    }));
  }
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
// Arena builds can change the spawn between combat trials. Respawns must use
// the arena currently installed on the server, including mid-trial deaths.
let activeArena = spec.arena;
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
  if (activeArena)
    await bounded(member.env.teleport!(arenaSpawn(activeArena, index)));
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
        : spec.stage === "interaction"
          ? `Minecraft interaction session ${spec.interaction}: deterministic player-control baseline with per-trial skill results. No neural weights are trained.`
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
          ...(spec.stage === "pvp" && spec.arena
            ? (() => {
                const origin = arenaCellOrigin(spec.arena, i);
                return {
                  combatBounds: {
                    minX: origin.x + 1,
                    maxX: origin.x + spec.arena.blueprint.width + 1,
                    minZ: origin.z + 1,
                    maxZ: origin.z + spec.arena.blueprint.depth + 1,
                  },
                };
              })()
            : {}),
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
    if (spec.stage === "interaction") {
      if (!spec.arena || !spec.interaction)
        throw new Error("Interaction run requires a session and isolated arena");
      if (members.some((member) => !member.env.executeSkill))
        throw new Error("Selected backend does not execute Phase 3C skill requests");
      await reportModels(true);
      for (let episode = 1; episode <= spec.episodes && !stopping; episode++) {
        if (paused) {
          send({ type: "paused" });
          while (paused && !stopping) await sleep(100);
          if (!stopping) send({ type: "resumed" });
        }
        if (stopping) break;
        timingEpisode = episode;
        timingTick = 0;
        timingPhase = "preparing";
        reportTiming();
        await bounded(requestArena(), 320000);
        for (let index = 0; index < members.length; index++) {
          const member = members[index];
          member.state.status = "resetting";
          await bounded(member.env.reset!(memberSetup(index)!));
          await bounded(member.env.teleport!(arenaSpawn(spec.arena, index)));
        }
        // Static scenarios have no unseen variation to evaluate. Only label
        // seeded orientation and distance variants as held-out trials.
        const heldOut = ["A1", "M1", "M2"].includes(spec.interaction) && episode % 5 === 0;
        timingPhase = "training";
        reportTiming();
        const results = await Promise.all(members.map(async (member, index) => {
          const request = interactionRequest(
            spec.interaction!, spec.arena!, index, episode,
            spec.seed + (heldOut ? 1000003 : 0),
          );
          let result: SkillResult;
          try {
            result = await bounded(member.env.executeSkill!(request), 30000);
          } catch (error) {
            result = {
              status: (error as Error).message.includes("deadline") ? "TIMEOUT" : "FAILURE",
              reason: (error as Error).message.includes("deadline") ? "TIMEOUT" : "INTERACTION_FAILED",
              state_delta: {}, duration_ms: 30000, metrics: { actions: 0 },
            };
          }
          member.state.reward = result.status === "SUCCESS" ? 1 : 0;
          member.state.ticks += result.metrics.actions;
          await updateObservation(member);
          member.state.status = "active";
          return { username: member.state.username, request, result };
        }));
        const successes = results.filter(({ result }) => result.status === "SUCCESS").length;
        const failures: Record<string, number> = {};
        for (const { result } of results)
          if (result.reason) failures[result.reason] = (failures[result.reason] ?? 0) + 1;
        const outcome = {
          trials: results.length,
          successes,
          successRate: results.length ? successes / results.length : 0,
          meanDurationMs: results.length
            ? results.reduce((sum, row) => sum + row.result.duration_ms, 0) / results.length
            : 0,
          failures,
          heldOut,
        };
        const metric: import("@mlcraft/core").Metric = {
          kind: "interaction-trial", at: Date.now(), runId: run.id,
          episode, reward: outcome.successRate, stepsPerSecond: 0,
          tickMs: 0, workerMemoryMb: process.memoryUsage().rss / 1024 / 1024,
          interaction: outcome,
        };
        send({ type: "metric", metric, agents: members.map((member) => ({ ...member.state })) });
        await appendFile(resolve(dir, "metrics.jsonl"), JSON.stringify(metric) + "\n");
        await appendFile(resolve(dir, "interaction-trials.jsonl"), JSON.stringify({ episode, at: metric.at, ...outcome }) + "\n");
        await appendFile(resolve(dir, "skill-results.jsonl"), results.map((row) => JSON.stringify({ episode, heldOut, ...row })).join("\n") + "\n");
        await saveCheckpoint({ kind: "interaction-baseline", runId: run.id, session: spec.interaction, episode, ...outcome, createdAt: new Date().toISOString() });
        send({ type: "progress", episode, progress: episode / spec.episodes });
      }
      if (!stopping) {
        timingPhase = "finishing";
        reportTiming();
        await new Promise<void>((resolve, reject) => {
          if (!process.connected)
            return reject(new Error("Control service disconnected before completion"));
          process.send?.(
            { type: "done", checkpoint: { kind: "interaction-baseline", runId: run.id } },
            (error) => error ? reject(error) : resolve(),
          );
        });
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
    const firstEpisode =
      spec.motorResume || spec.combatResume
        ? Number((await bounded(trainer.checkpoint())).episode) + 1
        : 1;
    if (firstEpisode > 1)
      send({
        type: "progress",
        episode: firstEpisode - 1,
        progress: (firstEpisode - 1) / spec.episodes,
      });
    for (
      let episode = firstEpisode;
      episode <= spec.episodes && !stopping;
      episode++
    ) {
      if (episode > firstEpisode) await hold();
      if (stopping) break;
      const combatTrialArena = spec.stage === "pvp"
        ? (() => {
            const trial = motorTrialPlan(episode, spec.agents);
            return combatArena(spec.combat!, spec.seed + trial.evolution * 17 + trial.scenario * 7);
          })()
        : undefined;
      activeArena = combatTrialArena ?? spec.arena;
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
      // Combat mobs placed before clients connect can be lost when their chunks
      // unload. Rebuild once all clients are present before the first trial.
      if (
        spec.arena?.resetEachEpisode &&
        (episode > firstEpisode || spec.stage === "pvp")
      ) {
        for (const member of members) await bounded(member.env.apply({}));
        await bounded(requestArena(undefined, combatTrialArena), 320000);
      }
      if (episode > firstEpisode && setup?.applyEachEpisode)
        for (let i = 0; i < members.length; i++)
          await bounded(members[i].env.reset!(memberSetup(i)!));
      if (spec.stage === "motor")
        for (const member of members) await bounded(member.env.apply({}));
      // Spawn placement resets every generation even when terrain is preserved.
      if (episode > 1 && spec.arena && spec.stage !== "pvp")
        for (let i = 0; i < members.length; i++)
          await bounded(members[i].env.teleport!(arenaSpawn(spec.arena, i)));
      if (spec.motorTerrain) {
        const previous = members.map((member) => member.state.position);
        await Promise.all(
          members.map((member) =>
            bounded(
              requestNaturalSpawn(
                member.state.username,
                spec.motorTerrain!.spreadRadius,
              ),
            ),
          ),
        );
        await Promise.all(
          members.map(async (member, index) => {
            const deadline = Date.now() + 45000;
            while (!stopping && Date.now() < deadline) {
              const position = (
                await bounded(
                  Promise.resolve(member.env.observe(member.state.ticks)),
                  5000,
                )
              ).position;
              if (
                !previous[index] ||
                Math.hypot(
                  position.x - previous[index]!.x,
                  position.z - previous[index]!.z,
                ) > 4
              )
                return;
              await sleep(250);
            }
            if (!stopping)
              throw new Error(
                `${member.state.username} did not reach a natural terrain spawn`,
              );
          }),
        );
      }
      if (spec.stage === "pvp") {
        const session = combatSession(spec.combat!);
        const expected =
          ("count" in session ? session.count : 1) +
          ("secondMob" in session ? 1 : 0);
        const missingOpponents = async (timeoutMs: number) => {
          const visible = await Promise.all(
            members.map(async (member) => {
              const deadline = Date.now() + timeoutMs;
              while (!stopping && Date.now() < deadline) {
                const observation = await bounded(
                  Promise.resolve(member.env.observe(member.state.ticks)),
                  5000,
                );
                if ((observation.combat?.targets.length ?? 0) >= expected)
                  return true;
                await sleep(100);
              }
              return false;
            }),
          );
          return members.filter((_, index) => !visible[index]);
        };
        let missing = await missingOpponents(10000);
        if (missing.length && !stopping) {
          const status = await requestCombatStatus();
          const absent = missing.filter((member) => {
            const index = Number(member.state.id.slice(member.state.id.lastIndexOf(":") + 1));
            return (status[index]?.alive ?? 0) < expected;
          });
          send({
            type: "log",
            level: "warn",
            message: `${missing.length} combat agent${missing.length === 1 ? "" : "s"} had no visible opponent; ${absent.length ? "rebuilding missing server opponents" : "refreshing client positions"}.`,
          });
          if (absent.length) {
            for (const member of members) await bounded(member.env.apply({}));
            await bounded(requestArena(undefined, combatTrialArena), 320000);
          } else {
            for (const member of missing) await bounded(member.env.teleport!(arenaSpawn(combatTrialArena!, Number(member.state.id.slice(member.state.id.lastIndexOf(":") + 1)))));
          }
          missing = await missingOpponents(20000);
        }
        if (missing.length && !stopping)
          throw new Error(
            `${missing.map((member) => member.state.username).join(", ")} did not receive ${expected} combat opponent${expected === 1 ? "" : "s"} after arena rebuild`,
          );
      }
      const naturalTargets = spec.motorTerrain
        ? await Promise.all(
            members.map(async (member) => {
              const index = Number(
                member.state.id.slice(member.state.id.lastIndexOf(":") + 1),
              );
              let spawn = (
                await bounded(
                  Promise.resolve(member.env.observe(member.state.ticks)),
                )
              ).position;
              for (let placement = 0; placement < 4; placement++) {
                for (let attempt = 0; attempt < 24; attempt++) {
                  const candidate = motorNaturalTarget(
                    spawn,
                    spec.seed,
                    spec.motorTerrain!.worldSeed,
                    episode,
                    index + (placement * 24 + attempt) * spec.agents,
                    spec.motorTerrain!.minDistance,
                    spec.motorTerrain!.maxDistance,
                  );
                  try {
                    const target = await requestNaturalTarget(
                      member.state.username,
                      candidate,
                    );
                    return { spawn, target };
                  } catch (error) {
                    if (
                      !(error instanceof Error) ||
                      !error.message.includes(
                        "No standable surface near target",
                      )
                    )
                      throw error;
                  }
                }
                if (placement === 3) break;
                const previous = spawn;
                await requestNaturalSpawn(
                  member.state.username,
                  spec.motorTerrain!.spreadRadius,
                );
                const deadline = Date.now() + 45000;
                while (!stopping && Date.now() < deadline) {
                  spawn = (
                    await bounded(
                      Promise.resolve(member.env.observe(member.state.ticks)),
                      5000,
                    )
                  ).position;
                  if (
                    Math.hypot(spawn.x - previous.x, spawn.z - previous.z) > 4
                  )
                    break;
                  await sleep(250);
                }
                if (
                  stopping ||
                  Math.hypot(spawn.x - previous.x, spawn.z - previous.z) <= 4
                )
                  throw new Error(
                    `${member.state.username} did not reach a new natural terrain spawn`,
                  );
                send({
                  type: "log",
                  level: "warn",
                  message: `${member.state.username} moved to a new spawn because nearby targets were all unsuitable.`,
                });
              }
              throw new Error(
                `${member.state.username} found no standable target after four natural terrain spawn locations`,
              );
            }),
          )
        : undefined;
      for (const m of members) {
        if (
          (spec.stage === "motor" || spec.stage === "pvp") &&
          (spec.arena || spec.motorTerrain)
        ) {
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
          if (spec.stage === "pvp") {
            const session = combatSession(spec.combat!);
            m.combatInitialTargets =
              ("count" in session ? session.count : 1) +
              ("secondMob" in session ? 1 : 0);
            m.state.combatKills = 0;
            m.combatStatusIndex = Number(m.state.id.slice(m.state.id.lastIndexOf(":") + 1));
          }
          const natural = naturalTargets?.[index];
          m.target =
            spec.stage === "motor"
              ? natural
                ? natural.target
                : motorTarget(
                    spec.arena!,
                    spec.motor!,
                    index,
                    episode,
                    spec.seed,
                    spec.agents,
                  )
              : undefined;
          m.state.motorSpawn = natural?.spawn;
          m.state.motorTarget = m.target;
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
          spec.stage === "motor" || spec.stage === "pvp"
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
        let combatStatusForTick: Promise<CombatStatus> | undefined;
        await Promise.all(
          members.map(async (m, index) => {
            if (
              (spec.stage === "motor" || spec.stage === "pvp") &&
              m.motorTrialDone
            )
              return;
            const stepStarted = performance.now();
            const before = await bounded(
              Promise.resolve(m.env.observe(m.state.ticks)),
              5000,
            );
            if (before.health <= 0) {
              if (spec.stage === "motor" || spec.stage === "pvp") {
                m.motorTrialDone = true;
                m.state.status = "dead";
                reportAgents();
              } else await respawnMember(m, index);
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
            let verifiedKills = 0;
            let verifiedWin = false;
            let verifiedLoss = false;
            if (spec.stage === "pvp" && ((after.combat?.targets.length ?? 0) === 0 || (after.combat?.targets.length ?? 0) < (before.combat?.targets.length ?? 0))) {
              const status = await (combatStatusForTick ??= requestCombatStatus());
              const cell = status[m.combatStatusIndex ?? index];
              if (!cell) throw new Error("Combat arena status missing agent cell");
              verifiedKills = Math.max(0, cell.kills - (m.state.combatKills ?? 0));
              m.state.combatKills = cell.kills;
              verifiedWin = cell.alive === 0 && cell.kills >= (m.combatInitialTargets ?? 0);
              verifiedLoss = cell.alive === 0 && !verifiedWin;
            }
            const value =
              spec.stage === "pvp"
                ? combatReward(before, after, action, verifiedKills)
                : m.target
                  ? motorReward(
                      before,
                      after,
                      m.target,
                      m.motorSuccess,
                      !!spec.motorTerrain,
                    )
                  : reward(spec.stage, before, after);
            const reached =
              after.health > 0 &&
              (spec.stage === "pvp"
                ? verifiedWin
                : !!m.target &&
                  motorReachedTarget(after, m.target, !!spec.motorTerrain));
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
                  won: spec.stage === "pvp" && reached,
                  nextObservation: policyObservation(after, m.target),
                  done:
                    reached ||
                    verifiedLoss ||
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
            if ((spec.stage === "motor" || spec.stage === "pvp") && reached) {
              m.motorTrialDone = true;
              m.motorSuccess = true;
              m.motorSuccessSteps = tick;
              m.state.targetReached = true;
              m.state.targetSteps = tick;
              await bounded(m.env.apply({}), 5000);
            }
            if (spec.stage === "pvp" && verifiedLoss) {
              m.motorTrialDone = true;
              await bounded(m.env.apply({}), 5000);
            }
            if (after.health <= 0) {
              if (spec.stage === "motor" || spec.stage === "pvp") {
                m.motorTrialDone = true;
                m.state.status = "dead";
                reportAgents();
              } else await respawnMember(m, index);
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
          (spec.stage === "motor" || spec.stage === "pvp") &&
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
        const combatOutcome =
          spec.stage === "pvp"
            ? {
                trials: activeTrials,
                wins: successful.length,
                winRate: activeTrials ? successful.length / activeTrials : 0,
                meanWinSteps: successful.length
                  ? successful.reduce(
                      (sum, member) => sum + (member.motorSuccessSteps ?? 0),
                      0,
                    ) / successful.length
                  : null,
                kills: members.reduce(
                  (sum, member) => sum + (member.state.combatKills ?? 0),
                  0,
                ),
                heldOut: motorTrialPlan(episode, spec.agents).scenario === 2,
              }
            : undefined;
        let motorCheckpoint: Record<string, unknown> | undefined;
        if (spec.stage === "motor" || spec.stage === "pvp") {
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
        if (combatOutcome) {
          const trialMetric: import("@mlcraft/core").Metric = {
            kind: "combat-trial",
            at: Date.now(),
            runId: run.id,
            episode,
            reward: meanAgentReward(),
            stepsPerSecond: 0,
            tickMs: 0,
            workerMemoryMb: process.memoryUsage().rss / 1024 / 1024,
            combat: combatOutcome,
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
            resolve(dir, "combat-trials.jsonl"),
            JSON.stringify({ episode, at: trialMetric.at, ...combatOutcome }) +
              "\n",
          );
        }
        if (
          (spec.stage === "motor" || spec.stage === "pvp") &&
          report.generation
        ) {
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
                ...(spec.stage === "pvp" ? {
                  bestWins: report.bestWins ?? 0,
                  generationBestWins: report.generationBestWins ?? 0,
                } : {}),
                ...(spec.stage === "pvp" ? { heldoutPopulationMeanReward: report.heldoutPopulationMeanReward ?? 0 } : {}),
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
            ...(combatOutcome ? { combat: combatOutcome } : {}),
            ...(spec.motorTerrain
              ? {
                  terrain: {
                    worldSeed: spec.motorTerrain.worldSeed,
                    spreadRadius: spec.motorTerrain.spreadRadius,
                    targets: members.map((m) => ({
                      username: m.state.username,
                      spawn: m.state.motorSpawn,
                      target: m.state.motorTarget,
                    })),
                  },
                }
              : {}),
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
