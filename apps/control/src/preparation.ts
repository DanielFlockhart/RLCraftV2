import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { PreparationState } from "@mlcraft/core";
import { config, root } from "./config.js";
import { Store } from "./store.js";
export class ServerPreparation {
  state: PreparationState = { status: "idle" };
  private child?: ChildProcess;
  get running() {
    return !!this.child;
  }
  constructor(
    private store: Store,
    private blocked: () => string | undefined,
    private script = "prepare-server.ts",
    private timeoutMs = 180000,
  ) {}
  start(sourceJar?: string) {
    if (this.child) throw new Error("Server preparation already running");
    const reason = this.blocked();
    if (reason) throw new Error(reason);
    this.state = { status: "running" };
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve(root, "scripts", this.script),
        ...(sourceJar ? [sourceJar] : []),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DATA_DIR: config.dataDir,
          SERVER_DIR: config.serverDir,
          ARTIFACT_DIR: config.artifactDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    const timer = setTimeout(() => {
      this.state = {
        status: "failed",
        error: `Preparation exceeded ${this.timeoutMs / 1000} seconds`,
      };
      child.kill("SIGKILL");
    }, this.timeoutMs);
    const log = (message: string, level: "info" | "error" = "info") =>
      this.store.log({
        at: Date.now(),
        source: "preparation",
        level,
        message: message.slice(0, 4000),
      });
    child.stdout?.on("data", (data) => log(String(data)));
    child.stderr?.on("data", (data) => log(String(data), "error"));
    child.on("error", (error) => {
      this.state = { status: "failed", error: error.message };
      log(error.message, "error");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      this.child = undefined;
      if (this.state.status === "running")
        this.state =
          code === 0
            ? { status: "completed" }
            : {
                status: "failed",
                error: `Server preparation exited ${code}. See preparation logs.`,
              };
      log(
        this.state.status === "completed"
          ? this.script === "prepare-fabric-client.ts"
            ? "Fabric game clients prepared. Select the Fabric backend in a new training run."
            : this.script === "prepare-input-assets.ts"
              ? "Input audio assets prepared. New agent connections can use server-sound PCM."
              : "Server and training plugin prepared. Start Minecraft to load updates."
          : (this.state.error ?? "Preparation stopped"),
      );
    });
    return this.state;
  }
  async close() {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
