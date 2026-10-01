import type { RenderSettings } from "./rendering.js";
export type { RenderSettings } from "./rendering.js";
export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  width: 256,
  height: 192,
  fps: 10,
  viewDistance: 4,
  showHud: true,
  visibleWindow: false,
};
export type {
  BackendDescriptor,
  BackendSnapshot,
  InputSupport,
} from "./backends.js";
export type {
  ProgressRule,
  ProgressStep,
  ProgressEvidence,
  ProgressRecord,
  ProgressAgent,
  ProgressSummary,
  ProgressSnapshot,
} from "./progression.js";
export type {
  InputValue,
  InputChannelConfig,
  AgentInputConfig,
  InputSample,
  AgentInputFrame,
  PolicyObservation,
  CaptureFrame,
} from "./inputs.js";
export { default as inputCatalog } from "./input-catalog.json" with { type: "json" };
export { default as defaultInputs } from "./input-defaults.json" with { type: "json" };
export type RunStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";
export type Mode = "simulator" | "minecraft";
export const DEFAULT_VIEWERS = ["ChilledVibe"] as const;
export function isViewerUsername(
  username: string | undefined,
  viewers: readonly string[] = DEFAULT_VIEWERS,
): boolean {
  return (
    username !== undefined &&
    viewers.some((name) => name.toLowerCase() === username.toLowerCase())
  );
}
export type StageId =
  | "movement"
  | "motor"
  | "wood_collection"
  | "block_collection"
  | "survival"
  | "pvp";
export type MotorSession =
  "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8";
export interface MotorFullRunStage {
  session: MotorSession;
  agents: number;
  episodes: number;
  ticksPerEpisode: number;
  tickMs: number;
  seed: number;
  backend: "mineflayer" | "fabric";
  minSuccessRate: number;
  minBestFitness?: number;
  maxAttempts: number;
  runIds: string[];
  lastSuccessRate?: number;
  lastBestFitness?: number;
}
export interface MotorFullRun {
  id: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  stageIndex: number;
  stages: MotorFullRunStage[];
  error?: string;
  retryRequested?: boolean;
  createdAt: string;
  updatedAt: string;
}
export type Component = "pipeline" | "environment" | "evaluation";
export interface RunSpec {
  /** Keep one connected agent idle for Phase 0 inspection. */
  preview?: boolean;
  render?: RenderSettings;
  /** Registered backend ID. Omitted legacy runs retain their original default. */
  backend?: string;
  inputs?: import("./inputs.js").AgentInputConfig;
  stage: StageId;
  motor?: MotorSession;
  motorSource?: string;
  /** Continue the complete NEAT state from a terminal run checkpoint. */
  motorResume?: string;
  motorFullRunId?: string;
  motorFullRunStage?: number;
  mode: Mode;
  component: Component;
  agents: number;
  episodes: number;
  ticksPerEpisode: number;
  tickMs: number;
  seed: number;
  speed?: number;
  generationSeconds?: number;
  startPaused?: boolean;
  setup?: AgentSetup;
  arena?: ArenaSpec;
  rules?: TrainingRules;
}
export interface TrainingRules {
  keepInventory: boolean;
  noHungerLoss: boolean;
  creeperBlockDamage: boolean;
  creeperEntityDamage: boolean;
  pvp: boolean;
  fallDamage: boolean;
  drowningDamage: boolean;
  fireDamage: boolean;
  difficulty: "world" | "peaceful" | "easy" | "normal" | "hard";
  world: Partial<
    Record<
      | "doDaylightCycle"
      | "doWeatherCycle"
      | "doMobSpawning"
      | "mobGriefing"
      | "doFireTick"
      | "naturalRegeneration"
      | "doMobLoot"
      | "doTileDrops"
      | "doEntityDrops"
      | "doInsomnia"
      | "doPatrolSpawning"
      | "doTraderSpawning",
      boolean
    >
  > & { randomTickSpeed?: number; spawnRadius?: number };
}
export const DEFAULT_TRAINING_RULES: TrainingRules = {
  keepInventory: true,
  noHungerLoss: false,
  creeperBlockDamage: true,
  creeperEntityDamage: true,
  pvp: true,
  fallDamage: true,
  drowningDamage: true,
  fireDamage: true,
  difficulty: "world",
  world: {},
};
export interface ArenaPoint {
  x: number;
  y: number;
  z: number;
}
export interface ArenaBlueprint {
  width: number;
  depth: number;
  height: number;
  floor: string;
  walls: string;
  roof: string;
  spawn: ArenaPoint;
  regions: { from: ArenaPoint; to: ArenaPoint; block: string }[];
  containers: {
    position: ArenaPoint;
    block: "minecraft:chest" | "minecraft:barrel";
    items: { slot: number; item: string; count: number }[];
  }[];
  entities: {
    position: ArenaPoint;
    type:
      "cow" | "pig" | "sheep" | "chicken" | "zombie" | "skeleton" | "spider";
    count: number;
  }[];
}
export interface ArenaSpec {
  blueprint: ArenaBlueprint;
  origin: ArenaPoint;
  layout: "individual" | "shared";
  columns: number;
  gap: number;
  resetEachEpisode: boolean;
}
export interface ArenaPreset {
  id: string;
  name: string;
  blueprint: ArenaBlueprint;
  createdAt: string;
  updatedAt: string;
}
export const DEFAULT_ARENA_BLUEPRINT: ArenaBlueprint = {
  width: 7,
  depth: 7,
  height: 4,
  floor: "minecraft:stone",
  walls: "minecraft:glass",
  roof: "minecraft:glass",
  spawn: { x: 3, y: 0, z: 3 },
  regions: [],
  containers: [],
  entities: [],
};
export const DEFAULT_ARENA_SPEC: ArenaSpec = {
  blueprint: DEFAULT_ARENA_BLUEPRINT,
  origin: { x: 1000, y: 64, z: 1000 },
  layout: "individual",
  columns: 4,
  gap: 4,
  resetEachEpisode: true,
};
export interface AgentSetup {
  items: { slot: number; item: string; count: number }[];
  clearInventory: boolean;
  resetVitals: boolean;
  health: number;
  food: number;
  experienceLevel: number;
  heldSlot: number;
  gamemode: "world" | "survival" | "creative" | "adventure";
  applyEachEpisode: boolean;
  spawn?: { x: number; y: number; z: number };
}
export const DEFAULT_AGENT_SETUP: AgentSetup = {
  items: [],
  clearInventory: true,
  resetVitals: true,
  health: 20,
  food: 20,
  experienceLevel: 0,
  heldSlot: 0,
  gamemode: "world",
  applyEachEpisode: true,
};
export interface AgentPreset {
  id: string;
  name: string;
  setup: AgentSetup;
  createdAt: string;
  updatedAt: string;
}
export interface PreparationState {
  status: "idle" | "running" | "completed" | "failed";
  error?: string;
}
export interface Run {
  backend?: import("./backends.js").BackendSnapshot;
  id: string;
  spec: RunSpec;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  episode: number;
  progress: number;
  error?: string;
  world?: WorldRunContext;
  timing?: TrainingTiming;
  playback?: RunPlayback;
}
export interface RunPlayback {
  speed: number;
  ticksPerGeneration: number;
  generationSeconds?: number;
  manual?: { kind: "steps" | "seconds" | "generation"; remaining: number };
}
export type PlaybackCommand =
  | { action: "speed"; speed: number }
  | { action: "length"; unit: "steps" | "seconds"; value: number }
  | { action: "extend"; seconds: number }
  | {
      action: "advance";
      unit: "steps" | "seconds" | "generation";
      value: number;
    }
  | { action: "end-generation" };
export function effectiveStepMs(
  spec: Pick<RunSpec, "mode" | "tickMs">,
  speed = 1,
) {
  return Math.max(spec.mode === "minecraft" ? 50 : 1, spec.tickMs / speed);
}
export interface TrainingTiming {
  sampledAt: number;
  totalElapsedMs: number;
  generationElapsedMs: number;
  lastGenerationMs?: number;
  tick: number;
  ticks: number;
  phase: "preparing" | "training" | "between" | "finishing";
  advancing: boolean;
  trainingElapsedMs?: number;
}
export interface WorldSettings {
  type: "survival" | "flat" | "large_biomes" | "amplified";
  seed: string;
  difficulty: "peaceful" | "easy" | "normal" | "hard";
  gamemode: "survival" | "creative" | "adventure";
  structures: boolean;
  flat: { biome: string; layers: { block: string; height: number }[] };
}
export interface WorldGeneration {
  id: string;
  levelName: string;
  createdAt: string;
  settings: WorldSettings;
  /** Original settings for an adopted world, preserved when returning to it. */
  properties?: Record<string, string>;
}
export interface WorldProfile {
  id: string;
  name: string;
  generations: WorldGeneration[];
}
export interface WorldRunContext {
  profileId: string;
  generationId: string;
  levelName: string;
  settings: WorldSettings;
}
export interface WorldCatalog {
  profiles: WorldProfile[];
  active?: { profileId: string; generationId: string; levelName: string };
  busy: boolean;
  canChange: boolean;
  reason?: string;
}
export interface AgentState {
  id: string;
  runId: string;
  username: string;
  status:
    | "connecting"
    | "resetting"
    | "active"
    | "paused"
    | "dead"
    | "stopped"
    | "failed";
  ticks: number;
  reward: number;
  health: number;
  food?: number;
  inventory?: Record<string, number>;
  position?: ArenaPoint;
  targetReached?: boolean;
  targetSteps?: number;
  error?: string;
}
export interface Metric {
  kind?: "evolution" | "motor-trial";
  at: number;
  runId: string;
  episode: number;
  reward: number;
  stepsPerSecond: number;
  tickMs: number;
  workerMemoryMb: number;
  neat?: {
    generation: number;
    species: number;
    bestFitness: number;
    generationBestFitness: number;
    population: number;
    speciesDetails?: {
      id: number;
      size: number;
      bestFitness: number;
      offspring: number;
      stagnant: boolean;
    }[];
  };
  motor?: {
    trials: number;
    successes: number;
    successRate: number;
    meanSuccessSteps: number | null;
  };
}
export interface LogEntry {
  id?: number;
  at: number;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  runId?: string;
}
export interface HostMetric {
  at: number;
  cpuPercent: number;
  memoryMb: number;
  eventLoopMs: number;
}
export interface ServerState {
  progressReady?: boolean;
  status: "stopped" | "starting" | "running" | "stopping" | "failed";
  pid?: number;
  startedAt?: string;
  error?: string;
  tps?: number;
  setupReady?: boolean;
  arenaReady?: boolean;
  hudReady?: boolean;
  rulesReady?: boolean;
}
export interface Snapshot {
  archive?: ArchiveState;
  runs: Run[];
  agents: AgentState[];
  metrics: Metric[];
  hostMetrics: HostMetric[];
  logs: LogEntry[];
  server: ServerState;
  preparation?: PreparationState;
  stages: StageDefinition[];
  capacity: {
    activeRuns: number;
    maxRuns: number;
    activeAgents: number;
    maxAgents: number;
  };
}
export interface ArchiveState {
  provider: "local" | "firebase";
  mode: "local" | "archive";
  runtimeId: string;
  pending: number;
  syncing: boolean;
  lastSyncedAt?: string;
  nextRetryAt?: string;
  error?: string;
}
export interface StageDefinition {
  id: StageId;
  name: string;
  description: string;
  policy: "placeholder" | "neat-rl";
  readiness: string;
}
export const stages: StageDefinition[] = [
  {
    id: "movement",
    name: "Movement",
    description: "Position observations and displacement rewards.",
    policy: "placeholder",
    readiness: "Observation + reward adapter",
  },
  {
    id: "motor",
    name: "Primitive motor skills",
    description:
      "Target reaching across M0–M8 arena curricula using evolved control graphs.",
    policy: "neat-rl",
    readiness:
      "NEAT evolutionary reinforcement learning in isolated Minecraft arenas",
  },
  {
    id: "wood_collection",
    name: "Wood collection",
    description: "Inventory observations and log collection rewards.",
    policy: "placeholder",
    readiness: "Observation + reward adapter",
  },
  {
    id: "block_collection",
    name: "Block collection",
    description: "Inventory observations and block collection rewards.",
    policy: "placeholder",
    readiness: "Observation + reward adapter",
  },
  {
    id: "survival",
    name: "Survival",
    description: "Health and food observations; add progression milestones.",
    policy: "placeholder",
    readiness: "Environment scaffold",
  },
  {
    id: "pvp",
    name: "Combat",
    description:
      "Health observations; add arenas, opponents and combat rewards.",
    policy: "placeholder",
    readiness: "Environment scaffold",
  },
];
export interface Observation {
  inputs?: import("./inputs.js").AgentInputFrame;
  position: { x: number; y: number; z: number };
  health: number;
  food: number;
  inventory: Record<string, number>;
  tick: number;
}
export interface Action {
  controls?: Partial<
    Record<
      "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak",
      boolean
    >
  >;
  look?: { yaw: number; pitch: number };
  dig?: boolean;
}
export interface Transition {
  observation: import("./inputs.js").PolicyObservation;
  action: Action;
  reward: number;
  nextObservation: import("./inputs.js").PolicyObservation;
  done: boolean;
}
export interface Policy {
  inspectModel?(): ModelInspection | Promise<ModelInspection>;
  reset(seed: number): Promise<void>;
  act(observation: import("./inputs.js").PolicyObservation): Promise<Action>;
  close(): Promise<void>;
}
export interface Trainer {
  inspectModel?(): ModelInspection | Promise<ModelInspection>;
  observe(agentId: string, transition: Transition): Promise<void>;
  endEpisode(episode: number): Promise<Record<string, number>>;
  checkpoint(): Promise<Record<string, unknown>>;
}
export interface Environment {
  /** Administrative live camera, independent of policy channel selection. */
  feed?(): Promise<import("./inputs.js").CaptureFrame | undefined>;
  /** Local client audio output control, independent of policy inputs. */
  sound?(muted?: boolean): Promise<{ muted: boolean }>;
  /** Administrative milestone evidence; never an additional policy observation. */
  watchProgress?(
    listener: (evidence: import("./progression.js").ProgressEvidence) => void,
  ): () => void;
  capture?(frame: import("./inputs.js").CaptureFrame): void | Promise<void>;
  connect(): Promise<void>;
  observe(tick: number): Observation | Promise<Observation>;
  apply(action: Action): Promise<void>;
  close(): Promise<void>;
  reset?(setup: AgentSetup): Promise<void>;
  teleport?(position: ArenaPoint): Promise<void>;
  respawn?(): Promise<void>;
}
export type WorkerMessage =
  | {
      type: "feed";
      requestId: string;
      frame?: import("./inputs.js").CaptureFrame;
      error?: string;
    }
  | { type: "sound"; requestId: string; muted?: boolean; error?: string }
  | { type: "game-progress"; record: import("./progression.js").ProgressRecord }
  | {
      type: "progress-tracker";
      agent: import("./progression.js").ProgressAgent;
    }
  | {
      type: "observation";
      requestId: string;
      frame?: import("./inputs.js").AgentInputFrame;
      error?: string;
    }
  | { type: "models"; snapshot: ModelSnapshot }
  | {
      type: "playback";
      requestId: string;
      playback: RunPlayback;
      error?: string;
    }
  | { type: "timing"; episode: number; timing: TrainingTiming }
  | { type: "arena-build"; requestId: string }
  | { type: "arena-spawn"; requestId: string; username: string }
  | { type: "agent-setup"; requestId: string; username: string }
  | { type: "rules-apply"; requestId: string }
  | { type: "agents"; agents: AgentState[] }
  | { type: "metric"; metric: Metric; agents: AgentState[] }
  | { type: "progress"; episode: number; progress: number }
  | { type: "log"; level: LogEntry["level"]; message: string }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "done"; checkpoint: Record<string, unknown> }
  | { type: "failed"; error: string };

export type ModelValue =
  | null
  | boolean
  | number
  | string
  | ModelValue[]
  | { [key: string]: ModelValue };
export interface ModelNode {
  id: string;
  label: string;
  kind: string;
  parameters?: number;
  trainableParameters?: number;
  inputShape?: ModelValue;
  outputShape?: ModelValue;
  config?: Record<string, ModelValue>;
}
export interface ModelInspection {
  implementation: string;
  framework: string;
  status: "ready" | "placeholder" | "unavailable";
  reason?: string;
  nodes: ModelNode[];
  edges: { from: string; to: string; label?: string }[];
  hyperparameters: Record<string, ModelValue>;
  parameters?: number;
  trainableParameters?: number;
}
export interface ModelVariant {
  role: "policy" | "trainer";
  agents: string[];
  fingerprint: string;
  inspection: ModelInspection;
}
export interface ModelSnapshot {
  codeVersion?: string;
  source: "configured" | "runtime";
  stage: StageId;
  runId?: string;
  episode: number;
  tick: number;
  sampledAt: number;
  variants: ModelVariant[];
}
export type {
  DatasetParameter,
  DatasetSplit,
  InventoryStack,
  GoalSelectionExample,
  DatasetExamples,
  DatasetCoverage,
  DatasetGenerator,
  DatasetJob,
  DatasetSnapshot,
} from "./datasets.js";
export type {
  GoalTrainingParameters,
  GoalEpochMetric,
  GoalSplitEvaluation,
  GoalEvaluation,
  GoalModelJob,
  GoalModelSnapshot,
  GoalPrediction,
} from "./goal-models.js";
