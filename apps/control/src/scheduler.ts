import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  Run,
  RunSpec,
  WorkerMessage,
  WorldRunContext,
  AgentSetup,
  ArenaSpec,
  PlaybackCommand,
  TrainingRules,
  ModelSnapshot,
  AgentInputFrame,
  CaptureFrame,
  BackendSnapshot,
} from "@rlcraft/core";
import { Store } from "./store.js";
import {
  ownsProgress,
  progressRecordSchema,
  progressAgentSchema,
} from "./progress.js";
import { config } from "./config.js";
import { LocalProcessExecutor, type RunExecutor } from "./executor.js";
import { initialPlayback, changePlayback } from "./playback.js";
import { DEFAULT_AGENT_SETUP } from "@rlcraft/core";
import { arenaSpawn } from "../../../packages/core/src/arenas.js";
export class Scheduler {
  private feedRequests = new Map<
    string,
    {
      runId: string;
      resolve: (frame: CaptureFrame | undefined) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  viewAgent(id: string, username: string): Promise<CaptureFrame | undefined> {
    if (this.feedRequests.size + this.inputRequests.size >= 64)
      throw new Error("Agent inspection request capacity exceeded");
    const child = this.workers.get(id);
    if (
      !child?.connected ||
      !this.store
        .agents(id)
        .some(
          (agent) =>
            agent.username === username &&
            ["active", "paused", "dead", "resetting"].includes(agent.status),
        )
    )
      throw new Error("No connected agent with that run and username");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.feedRequests.delete(requestId);
        reject(new Error("Agent feed request timed out"));
      }, 5000);
      this.feedRequests.set(requestId, { runId: id, resolve, reject, timer });
      child.send({ type: "feed-request", requestId, username }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.feedRequests.delete(requestId);
          reject(error);
        }
      });
    });
  }
  renderClients() {
    return [...this.workers.keys()].reduce((n, id) => {
      const run = this.store.getRun(id);
      return (
        n +
        ((run?.spec.backend ?? run?.backend?.descriptor.id) === "fabric"
          ? run!.spec.agents
          : 0)
      );
    }, 0);
  }
  hasFabricWorkers() {
    return this.renderClients() > 0;
  }
  private inputRequests = new Map<
    string,
    {
      runId: string;
      resolve: (frame: AgentInputFrame) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  observeAgent(
    id: string,
    username: string,
    capture?: CaptureFrame,
  ): Promise<AgentInputFrame> {
    if (this.inputRequests.size >= 64)
      throw new Error(
        "Too many pending agent input requests; retry after existing requests finish",
      );
    const child = this.workers.get(id),
      run = this.store.getRun(id);
    if (
      !child?.connected ||
      !run ||
      !this.store
        .agents(id)
        .some(
          (agent) =>
            agent.username === username &&
            ["active", "paused", "dead", "resetting"].includes(agent.status),
        )
    )
      throw new Error("No connected agent with that run and username");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inputRequests.delete(requestId);
        reject(new Error("Agent input request timed out"));
      }, 5000);
      this.inputRequests.set(requestId, { runId: id, resolve, reject, timer });
      child.send(
        {
          type: capture ? "capture" : "observation-request",
          requestId,
          username,
          frame: capture,
        },
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.inputRequests.delete(requestId);
            reject(error);
          }
        },
      );
    });
  }
  private models = new Map<string, ModelSnapshot>();
  modelSnapshot(id: string) {
    return this.models.get(id);
  }
  private workers = new Map<string, ChildProcess>();
  private kills = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;
  private playbackRequests = new Map<
    string,
    {
      runId: string;
      resolve: (run: Run) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private store: Store,
    private publish: () => void,
    private executor: RunExecutor = new LocalProcessExecutor(),
    private setupAgent?: (
      requestId: string,
      username: string,
      setup: AgentSetup,
    ) => Promise<void>,
    private arena?: {
      build: (
        requestId: string,
        runId: string,
        arena: ArenaSpec,
        agents: number,
      ) => Promise<void>;
      spawn: (
        requestId: string,
        runId: string,
        username: string,
        index: number,
      ) => Promise<void>;
      cancel: (runId: string) => void;
    },
    private rules?: {
      apply: (
        requestId: string,
        runId: string,
        rules: TrainingRules,
        agents: number,
      ) => Promise<void>;
      release: (runId: string) => void;
    },
  ) {}
  capacity() {
    return {
      activeRuns: this.workers.size,
      maxRuns: config.MAX_CONCURRENT_RUNS,
      activeAgents: [...this.workers.keys()].reduce(
        (n, id) => n + (this.store.getRun(id)?.spec.agents ?? 0),
        0,
      ),
      maxAgents: config.MAX_AGENTS,
    };
  }
  hasMinecraftWorkers() {
    return [...this.workers.keys()].some(
      (id) => this.store.getRun(id)?.spec.mode === "minecraft",
    );
  }
  enqueue(spec: RunSpec, world?: WorldRunContext, backend?: BackendSnapshot) {
    if (
      (backend?.descriptor.id ?? spec.backend) === "fabric" &&
      spec.agents > config.MAX_RENDER_CLIENTS
    )
      throw new Error(
        `Rendered agent count exceeds renderer capacity ${config.MAX_RENDER_CLIENTS}`,
      );
    if (spec.agents > config.MAX_AGENTS)
      throw new Error(`Agent count exceeds capacity ${config.MAX_AGENTS}`);
    if (this.store.queued().length >= 100)
      throw new Error("Queue is full (100 runs)");
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      spec,
      ...(backend ? { backend } : {}),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      episode: 0,
      progress: 0,
      playback: initialPlayback(spec),
      ...(world ? { world } : {}),
    };
    this.store.saveRun(run);
    this.log(run.id, "Run queued");
    this.pump();
    return this.store.getRun(run.id)!;
  }
  private log(
    runId: string,
    message: string,
    level: "info" | "error" = "info",
  ) {
    this.store.log({
      at: Date.now(),
      level,
      source: "scheduler",
      message,
      runId,
    });
    this.publish();
  }
  private update(id: string, patch: Partial<Run>) {
    const run = this.store.getRun(id)!;
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    this.store.saveRun(run);
    this.publish();
    return run;
  }
  pump() {
    if (this.closing) return;
    for (const run of this.store.queued()) {
      const cap = this.capacity();
      if (cap.activeRuns >= cap.maxRuns) break;
      if (cap.activeAgents + run.spec.agents > cap.maxAgents) continue;
      if (
        (run.spec.backend ?? run.backend?.descriptor.id) === "fabric" &&
        this.renderClients() + run.spec.agents > config.MAX_RENDER_CLIENTS
      )
        continue;
      this.update(run.id, { status: "running" });
      const child = this.executor.launch(run);
      this.workers.set(run.id, child);
      this.log(run.id, `Worker started (${run.spec.agents} agents)`);
      child.stdout?.on("data", (d) =>
        this.log(run.id, String(d).slice(0, 4000)),
      );
      child.stderr?.on("data", (d) =>
        this.store.log({
          at: Date.now(),
          level: "warn",
          source: "worker",
          runId: run.id,
          message: String(d).slice(0, 4000),
        }),
      );
      child.on("message", (message: WorkerMessage) => {
        const current = this.store.getRun(run.id)!;
        if (current.status === "cancelled" && message.type !== "models") return;
        switch (message.type) {
          case "feed": {
            const pending = this.feedRequests.get(message.requestId);
            if (pending?.runId === run.id) {
              clearTimeout(pending.timer);
              this.feedRequests.delete(message.requestId);
              message.error
                ? pending.reject(new Error(message.error))
                : pending.resolve(message.frame);
            }
            break;
          }
          case "observation": {
            const pending = this.inputRequests.get(message.requestId);
            if (pending?.runId === run.id) {
              clearTimeout(pending.timer);
              this.inputRequests.delete(message.requestId);
              if (message.error || !message.frame)
                pending.reject(new Error(message.error ?? "No input frame"));
              else pending.resolve(message.frame);
            }
            break;
          }
          case "models":
            this.models.set(run.id, message.snapshot);
            // Keep active workers plus a small recent cache; historical snapshots remain on disk.
            for (const id of this.models.keys()) {
              if (this.models.size <= this.workers.size + 32) break;
              if (!this.workers.has(id)) this.models.delete(id);
            }
            break;
          case "rules-apply": {
            const result = (error?: string) => {
              if (child.connected)
                child.send(
                  { type: "setup-result", requestId: message.requestId, error },
                  () => {},
                );
            };
            if (
              current.spec.mode !== "minecraft" ||
              !current.spec.rules ||
              !this.rules
            ) {
              result("Run has no managed training rules adapter");
              break;
            }
            Promise.resolve()
              .then(() =>
                this.rules!.apply(
                  message.requestId,
                  run.id,
                  current.spec.rules!,
                  current.spec.agents,
                ),
              )
              .then(
                () => result(),
                (error) => result((error as Error).message),
              );
            break;
          }
          case "playback": {
            const pending = this.playbackRequests.get(message.requestId);
            if (!message.error)
              this.update(run.id, { playback: message.playback });
            if (pending?.runId === run.id) {
              clearTimeout(pending.timer);
              this.playbackRequests.delete(message.requestId);
              if (message.error) pending.reject(new Error(message.error));
              else {
                this.log(
                  run.id,
                  `Playback updated: ${JSON.stringify(message.playback)}`,
                );
                pending.resolve(this.store.getRun(run.id)!);
              }
            }
            break;
          }
          case "timing":
            this.update(run.id, {
              episode: message.episode,
              timing: message.timing,
            });
            break;
          case "arena-build":
          case "arena-spawn": {
            const result = (error?: string) => {
              if (child.connected)
                child.send(
                  { type: "setup-result", requestId: message.requestId, error },
                  () => {},
                );
            };
            if (
              !current.spec.arena ||
              current.spec.mode !== "minecraft" ||
              !this.arena
            ) {
              result("Run has no managed training arena");
              break;
            }
            const runArena = current.spec.arena;
            Promise.resolve()
              .then(() => {
                if (message.type === "arena-build")
                  return this.arena!.build(
                    message.requestId,
                    run.id,
                    runArena,
                    current.spec.agents,
                  );
                const index = Number(
                  message.username.slice(`rl_${run.id.slice(0, 6)}_`.length),
                );
                if (
                  !Number.isInteger(index) ||
                  index < 0 ||
                  index >= current.spec.agents ||
                  message.username !== `rl_${run.id.slice(0, 6)}_${index}`
                )
                  throw new Error("Unowned arena agent");
                return this.arena!.spawn(
                  message.requestId,
                  run.id,
                  message.username,
                  index,
                );
              })
              .then(
                () => result(),
                (error) => result((error as Error).message),
              );
            break;
          }
          case "agent-setup": {
            const suffix = message.username?.slice(
              `rl_${run.id.slice(0, 6)}_`.length,
            );
            const expected =
              /^\d+$/.test(suffix ?? "") &&
              Number(suffix) < run.spec.agents &&
              message.username === `rl_${run.id.slice(0, 6)}_${Number(suffix)}`;
            const result = (error?: string) => {
              if (child.connected)
                child.send(
                  { type: "setup-result", requestId: message.requestId, error },
                  () => {},
                );
            };
            if (
              !expected ||
              run.spec.mode !== "minecraft" ||
              !this.setupAgent
            ) {
              result("Setup request is not an owned training agent");
              break;
            }
            Promise.resolve()
              .then(() =>
                this.setupAgent!(message.requestId, message.username, {
                  ...(run.spec.setup ?? DEFAULT_AGENT_SETUP),
                  ...(run.spec.arena
                    ? { spawn: arenaSpawn(run.spec.arena, Number(suffix)) }
                    : {}),
                }),
              )
              .then(
                () => result(),
                (error) => result((error as Error).message),
              );
            break;
          }
          case "game-progress": {
            const record = progressRecordSchema.safeParse(message.record);
            if (
              current.spec.mode === "minecraft" &&
              record.success &&
              ownsProgress(run.id, current.spec.agents, record.data)
            )
              this.store.saveProgress(record.data);
            break;
          }
          case "progress-tracker": {
            const agent = progressAgentSchema.safeParse(message.agent);
            if (
              current.spec.mode === "minecraft" &&
              agent.success &&
              ownsProgress(run.id, current.spec.agents, agent.data)
            )
              this.store.saveProgressAgent(agent.data);
            break;
          }
          case "agents":
            this.store.saveAgents(message.agents);
            break;
          case "metric":
            this.store.metric(message.metric);
            this.store.saveAgents(message.agents);
            break;
          case "progress":
            this.update(run.id, {
              episode: message.episode,
              progress: message.progress,
            });
            break;
          case "log":
            this.store.log({
              at: Date.now(),
              source: "worker",
              runId: run.id,
              level: message.level,
              message: message.message,
            });
            break;
          case "paused":
            this.update(run.id, { status: "paused" });
            this.store.saveAgents(
              this.store.agents(run.id).map((a) => ({
                ...a,
                status: a.status === "dead" ? "dead" : "paused",
              })),
            );
            break;
          case "resumed":
            this.update(run.id, { status: "running" });
            break;
          case "done":
            this.update(run.id, { status: "completed", progress: 1 });
            this.log(run.id, "Run completed; checkpoint saved");
            this.kills.set(
              run.id,
              setTimeout(() => child.kill("SIGKILL"), 5000),
            );
            break;
          case "failed":
            this.update(run.id, { status: "failed", error: message.error });
            this.log(run.id, message.error, "error");
            this.kills.set(
              run.id,
              setTimeout(() => child.kill("SIGKILL"), 5000),
            );
            break;
        }
        this.publish();
      });
      child.on("error", (err) => {
        this.update(run.id, { status: "failed", error: err.message });
        this.log(run.id, err.message, "error");
      });
      child.on("close", (code) => {
        for (const [id, pending] of this.feedRequests)
          if (pending.runId === run.id) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Agent worker exited"));
            this.feedRequests.delete(id);
          }
        for (const [id, pending] of this.inputRequests)
          if (pending.runId === run.id) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Agent worker exited"));
            this.inputRequests.delete(id);
          }
        for (const [id, pending] of this.playbackRequests)
          if (pending.runId === run.id) {
            clearTimeout(pending.timer);
            pending.reject(
              new Error("Worker exited before acknowledging playback"),
            );
            this.playbackRequests.delete(id);
          }
        if (run.spec.arena) this.arena?.cancel(run.id);
        if (run.spec.mode === "minecraft") this.rules?.release(run.id);
        const timer = this.kills.get(run.id);
        if (timer) clearTimeout(timer);
        this.kills.delete(run.id);
        this.workers.delete(run.id);
        const current = this.store.getRun(run.id)!;
        if (["running", "paused", "pausing"].includes(current.status))
          this.update(run.id, {
            status: "failed",
            error: `Worker exited unexpectedly (code ${code})`,
          });
        this.store.saveAgents(
          this.store.agents(run.id).map((a) => ({
            ...a,
            status:
              this.store.getRun(run.id)!.status === "failed"
                ? "failed"
                : "stopped",
          })),
        );
        this.store.archive.artifacts(run.id);
        this.publish();
        this.pump();
      });
    }
  }
  action(id: string, action: "pause" | "resume" | "cancel") {
    const run = this.store.getRun(id);
    if (!run) throw new Error("Run not found");
    const child = this.workers.get(id);
    if (action === "cancel") {
      if (!["queued", "running", "paused", "pausing"].includes(run.status))
        throw new Error("Run is already terminal");
      this.update(id, {
        status: "cancelled",
        ...(run.playback
          ? { playback: { ...run.playback, manual: undefined } }
          : {}),
      });
      if (run.spec.arena) this.arena?.cancel(id);
      if (child) {
        if (child.connected) child.send({ type: "cancel" });
        this.kills.set(
          id,
          setTimeout(() => child.kill("SIGKILL"), 5000),
        );
      }
      this.log(id, "Cancellation requested");
      this.pump();
    } else if (
      action === "pause" &&
      run.status === "running" &&
      child?.connected
    ) {
      this.update(id, { status: "pausing" });
      child.send({ type: "pause" });
    } else if (
      action === "resume" &&
      run.status === "paused" &&
      child?.connected
    ) {
      child.send({ type: "resume" });
    } else throw new Error(`Cannot ${action} a ${run.status} run`);
    return this.store.getRun(id)!;
  }
  async playback(id: string, command: PlaybackCommand) {
    const run = this.store.getRun(id);
    if (!run) throw new Error("Run not found");
    if (!["queued", "running", "paused"].includes(run.status))
      throw new Error(`Cannot change playback of a ${run.status} run`);
    if ([...this.playbackRequests.values()].some((r) => r.runId === id))
      throw new Error("A playback update is awaiting acknowledgement");
    const next = changePlayback(
      run.playback ?? initialPlayback(run.spec),
      command,
      run.spec,
      run.status === "paused",
    );
    if (
      command.action === "end-generation" &&
      (run.status === "queued" ||
        !run.episode ||
        run.timing?.phase === "finishing" ||
        run.timing?.phase === "between")
    )
      throw new Error("No current training generation to end");
    if (run.status === "queued") return this.update(id, { playback: next });
    const child = this.workers.get(id);
    if (!child?.connected) throw new Error("Training worker is unavailable");
    const requestId = randomUUID();
    return new Promise<Run>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.playbackRequests.delete(requestId);
        reject(
          new Error(
            "Playback acknowledgement timed out; inspect current run state",
          ),
        );
      }, 8000);
      this.playbackRequests.set(requestId, {
        runId: id,
        resolve,
        reject,
        timer,
      });
      child.send({ type: "playback", requestId, command }, (error) => {
        if (error && this.playbackRequests.has(requestId)) {
          clearTimeout(timer);
          this.playbackRequests.delete(requestId);
          reject(error);
        }
      });
    });
  }
  async close() {
    this.closing = true;
    const pending = [...this.workers.entries()].map(async ([id, child]) => {
      const exit = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      const state = this.store.getRun(id)!.status;
      if (["running", "paused", "pausing"].includes(state))
        this.action(id, "cancel");
      await exit;
    });
    await Promise.all(pending);
  }
}
