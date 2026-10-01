import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ServerState,
  AgentSetup,
  ArenaSpec,
  TrainingRules,
} from "@mlcraft/core";
import { config } from "./config.js";
import { Store } from "./store.js";
import { receiveServerProgress } from "./progress.js";
import { ensurePlayerCapacity } from "./server-properties.js";
import { viewerHudRuns } from "./viewer-hud.js";
export class MinecraftServer {
  state: ServerState = { status: "stopped" };
  private child?: ChildProcess;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private setupRequests = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  get hasProcess() {
    return !!this.child;
  }
  constructor(
    private store: Store,
    private publish: () => void,
    private launch: (
      command: string,
      args: string[],
      options: SpawnOptions,
    ) => ChildProcess = spawn,
  ) {}
  private log(message: string, level: "info" | "warn" | "error" = "info") {
    this.store.log({ at: Date.now(), source: "minecraft", level, message });
    this.publish();
  }
  start() {
    if (this.child) throw new Error("Managed server already exists");
    const jar = resolve(config.serverDir, "server.jar");
    if (!existsSync(jar))
      throw new Error("Server jar missing. Run npm run server:prepare first.");
    const eula = resolve(config.serverDir, "eula.txt");
    if (
      !existsSync(eula) ||
      !/^eula=true\s*$/m.test(readFileSync(eula, "utf8"))
    )
      throw new Error(
        "Accept the Minecraft EULA in runtime/server/eula.txt before starting.",
      );
    ensurePlayerCapacity(
      resolve(config.serverDir, "server.properties"),
      Math.max(config.MC_MAX_PLAYERS, config.MAX_AGENTS + 4),
    );
    this.state = { status: "starting", startedAt: new Date().toISOString() };
    const child = this.launch(
      config.JAVA_PATH,
      [
        `-Xms${config.MC_MIN_MEMORY}`,
        `-Xmx${config.MC_MAX_MEMORY}`,
        "-jar",
        jar,
        "nogui",
      ],
      {
        cwd: config.serverDir,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    this.state.pid = child.pid;
    this.startupTimer = setTimeout(() => {
      this.state = {
        ...this.state,
        status: "failed",
        error: "Server startup exceeded 180 seconds",
      };
      this.log(this.state.error!, "error");
      child.kill("SIGKILL");
    }, 180000);
    const consume = (
      stream: NodeJS.ReadableStream | undefined,
      level: "info" | "warn",
    ) => {
      let pending = "";
      stream?.on("data", (data: Buffer) => {
        pending += data.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop()!.slice(-8192);
        for (const line of lines) {
          if (line.includes("Training progress protocol 1 ready"))
            this.state.progressReady = true;
          if (config.MC_VERSION === "1.18.1" && this.state.progressReady)
            receiveServerProgress(this.store, line);
          if (line.includes("Training setup protocol 2 ready"))
            this.state.setupReady = true;
          if (line.includes("Training arena protocol 1 ready"))
            this.state.arenaReady = true;
          if (line.includes("Viewer HUD protocol 1 ready"))
            this.state.hudReady = true;
          if (line.includes("Training rules protocol 1 ready"))
            this.state.rulesReady = true;
          const setupResult = line.match(
            /RLCRAFT_(?:SETUP|ARENA|RULES)_(OK|ERROR) ([a-f0-9-]{36})(?: (.*))?$/,
          );
          if (setupResult) {
            const request = this.setupRequests.get(setupResult[2]);
            if (request) {
              clearTimeout(request.timer);
              this.setupRequests.delete(setupResult[2]);
              setupResult[1] === "OK"
                ? request.resolve()
                : request.reject(
                    new Error(setupResult[3] || "Agent setup rejected"),
                  );
            }
          }
          if (line.includes("Unsupported Java detected")) {
            this.state = {
              ...this.state,
              status: "failed",
              error:
                "Paper 1.18.1 requires Java 17. Set JAVA_PATH in .env to a Java 17 executable, then restart the control service.",
            };
            clearTimeout(this.startupTimer);
          }
          if (line.includes("Done (") && this.state.status === "starting") {
            clearTimeout(this.startupTimer);
            this.state = { ...this.state, status: "running" };
          }
          const tps = line.match(/TPS from last.*?:\s*\*?([\d.]+)/);
          if (tps) this.state.tps = Number(tps[1]);
          this.log(line.slice(0, 8192), level);
        }
      });
    };
    consume(child.stdout ?? undefined, "info");
    consume(child.stderr ?? undefined, "warn");
    child.stdin?.on("error", (error) => {
      for (const request of this.setupRequests.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.setupRequests.clear();
      this.log(`Minecraft console input failed: ${error.message}`, "warn");
    });
    child.on("error", (err) => {
      this.state = { status: "failed", error: err.message };
      this.log(err.message, "error");
    });
    child.on("close", (code) => {
      for (const request of this.setupRequests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Minecraft exited during agent setup"));
      }
      this.setupRequests.clear();
      clearTimeout(this.startupTimer);
      const intentional = this.state.status === "stopping";
      const error = this.state.error;
      this.state = intentional
        ? { status: "stopped" }
        : { status: "failed", error: error ?? `Server exited (code ${code})` };
      this.child = undefined;
      this.log(
        intentional ? "Server stopped" : this.state.error!,
        intentional ? "info" : "error",
      );
    });
    this.publish();
    return this.state;
  }
  command(command: string) {
    if (this.state.status !== "running" || !this.child?.stdin?.writable)
      throw new Error("Managed server is not ready");
    if (/[\r\n\0]/.test(command) || command.length > 1000)
      throw new Error("Invalid console command");
    if (/^(stop|restart)\b/i.test(command.trim()))
      throw new Error("Use server lifecycle controls for stop/restart");
    this.child.stdin.write(command.trim() + "\n");
    this.log(`> ${command}`);
    return { accepted: true };
  }
  setupAgent(requestId: string, username: string, setup: AgentSetup) {
    if (
      this.state.status !== "running" ||
      !this.state.setupReady ||
      !this.child?.stdin?.writable
    )
      throw new Error(
        "Starting inventories require the managed server's training setup plugin. Prepare/update the server and restart Minecraft.",
      );
    if (
      !/^[a-f0-9-]{36}$/.test(requestId) ||
      !/^rl_[a-f0-9]{6}_\d+$/.test(username)
    )
      throw new Error("Invalid training agent setup request");
    if (this.setupRequests.has(requestId))
      throw new Error("Duplicate agent setup request");
    const payload = Buffer.from(JSON.stringify(setup)).toString("base64url");
    if (payload.length > 16384)
      throw new Error("Agent setup payload too large");
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.setupRequests.delete(requestId);
        reject(
          new Error(
            "Training setup acknowledgement timed out; check the server plugin console",
          ),
        );
      }, 10000);
      this.setupRequests.set(requestId, {
        resolve: () => {
          this.log(
            `Starting setup applied to ${username} (${setup.items.length} configured slots)`,
          );
          resolve();
        },
        reject,
        timer,
      });
      this.child!.stdin!.write(
        `rlcraftsetup ${requestId} ${username} ${payload}\n`,
      );
    });
  }
  private arenaRequest(
    requestId: string,
    runId: string,
    command: string,
    timeout = 15000,
    rules = false,
  ) {
    if (
      this.state.status !== "running" ||
      !(rules ? this.state.rulesReady : this.state.arenaReady) ||
      !this.child?.stdin?.writable
    )
      throw new Error(
        "Training arenas require the updated managed server plugin. Prepare/update and restart Minecraft.",
      );
    if (
      !/^[a-f0-9-]{36}$/.test(requestId) ||
      !/^[a-f0-9-]{36}$/.test(runId) ||
      this.setupRequests.has(requestId)
    )
      throw new Error("Invalid/duplicate arena request");
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.setupRequests.delete(requestId);
        this.cancelArena(runId);
        reject(new Error("Arena acknowledgement timed out; check server logs"));
      }, timeout);
      this.setupRequests.set(requestId, { timer, resolve, reject });
      this.child!.stdin!.write(command + "\n");
    });
  }
  async prepareArena(
    requestId: string,
    runId: string,
    arena: ArenaSpec,
    agents: number,
  ) {
    const payload = Buffer.from(JSON.stringify({ arena, agents })).toString(
      "base64url",
    );
    if (payload.length > 49152)
      throw new Error("Arena payload exceeds console limit");
    await this.arenaRequest(
      requestId,
      runId,
      `rlcraftarena ${requestId} ${runId} ${payload}`,
      310000,
    );
    this.log(
      `Training arena prepared for run ${runId} (${arena.layout}, ${agents} agents)`,
    );
  }
  async spawnArenaAgent(
    requestId: string,
    runId: string,
    username: string,
    index: number,
  ) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 128 ||
      username !== `rl_${runId.slice(0, 6)}_${index}`
    )
      throw new Error("Unowned arena agent");
    await this.arenaRequest(
      requestId,
      runId,
      `rlcraftarenaspawn ${requestId} ${runId} ${username} ${index}`,
    );
  }
  cancelArena(runId: string) {
    if (
      /^[a-f0-9-]{36}$/.test(runId) &&
      this.state.arenaReady &&
      this.child?.stdin?.writable
    )
      this.child.stdin.write(`rlcraftarena cancel ${runId}\n`);
  }
  async applyTrainingRules(
    requestId: string,
    runId: string,
    rules: TrainingRules,
    agents: number,
  ) {
    const payload = Buffer.from(JSON.stringify({ rules, agents })).toString(
      "base64url",
    );
    await this.arenaRequest(
      requestId,
      runId,
      `rlcraftrules ${requestId} ${runId} ${payload}`,
      15000,
      true,
    );
    this.log(`Training rules applied for run ${runId}`);
  }
  releaseTrainingRules(runId: string) {
    if (
      /^[a-f0-9-]{36}$/.test(runId) &&
      this.state.rulesReady &&
      this.child?.stdin?.writable
    )
      this.child.stdin.write(`rlcraftrules release ${runId}\n`);
  }
  syncViewerHud() {
    if (
      this.state.status !== "running" ||
      !this.state.hudReady ||
      !this.child?.stdin?.writable
    )
      return;
    // A private console protocol, deliberately absent from public command logging.
    // Backpressure drops a frame; the next one replaces it entirely.
    if (this.child.stdin.writableLength > 65536) return;
    const payload = Buffer.from(
      JSON.stringify({ runs: viewerHudRuns(this.store.runs(128)) }),
    ).toString("base64url");
    if (payload.length <= 32768)
      this.child.stdin.write(`rlcrafthudsync ${payload}\n`);
  }
  async stop() {
    const child = this.child;
    if (!child) return this.state;
    this.state = { ...this.state, status: "stopping" };
    clearTimeout(this.startupTimer);
    this.publish();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log(
          "Server did not finish saving within 60 seconds; forcing termination.",
          "warn",
        );
        child.kill("SIGKILL");
      }, 60000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.stdin?.writable) child.stdin.write("stop\n");
      else child.kill();
    });
    return this.state;
  }
}
