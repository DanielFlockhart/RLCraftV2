import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  Action,
  AgentSetup,
  ArenaPoint,
  CaptureFrame,
  Environment,
  Observation,
} from "@rlcraft/core";
import type { BackendContext, StdioBackendConfig } from "./contract.js";
import { parseBackendObservation } from "./observation.js";

/** Versioned JSON-lines RPC. This is transport, not an implementation of any game client. */
export class StdioEnvironment implements Environment {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private failed?: Error;
  private closing = false;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private context: BackendContext,
    private config: StdioBackendConfig,
  ) {}
  private fail(error: Error) {
    this.failed ??= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.failed);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.child?.kill();
  }
  async connect() {
    if (this.child || this.closing)
      throw new Error("Backend session cannot be connected twice");
    // Do not pass the control token, Firebase credentials, RUN_PAYLOAD or arbitrary parent env.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR)$/i.test(
          name,
        ),
      ),
    );
    const child = (this.child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...inherited, ...this.config.env },
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }));
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      if (!this.closing)
        this.fail(new Error(`Backend process exited (${code ?? signal})`));
    });
    // Drain stderr without exposing transport credentials in control logs.
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.failed) return;
      const max = this.config.maxMessageBytes ?? 4194304;
      try {
        // Each input chunk is bounded by the pipe; parse complete lines before checking remainder.
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let newline: number;
        while ((newline = this.buffer.indexOf(10)) !== -1) {
          if (newline > max)
            throw new Error("Backend response exceeds message byte limit");
          const line = this.buffer.subarray(0, newline).toString("utf8");
          this.buffer = this.buffer.subarray(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.protocol !== 1 || !Number.isSafeInteger(message.id))
            throw new Error(
              "Invalid backend RPC envelope; stdout must contain protocol 1 JSON lines only",
            );
          if (message.error !== undefined && typeof message.error !== "string")
            throw new Error("Backend error must be a string");
          const request = this.pending.get(message.id);
          if (!request) throw new Error("Unexpected backend response ID");
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error !== undefined) {
            request.reject(new Error(`Backend: ${message.error}`));
          } else request.resolve(message.result);
        }
        if (this.buffer.length > max)
          throw new Error("Backend response exceeds message byte limit");
      } catch (error) {
        this.fail(error as Error);
      }
    });
    await this.rpc("connect", {
      mode: this.context.mode,
      runId: this.context.runId,
      username: this.context.username,
      connection: this.context.connection,
      inputs: this.context.inputs,
    });
  }
  private rpc(method: string, params: unknown): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    if (!this.child || this.closing)
      return Promise.reject(new Error("Backend session is not connected"));
    if (this.pending.size >= 16)
      return Promise.reject(new Error("Too many pending backend requests"));
    const id = ++this.nextId;
    const line = JSON.stringify({ protocol: 1, id, method, params }) + "\n";
    if (Buffer.byteLength(line) > (this.config.maxMessageBytes ?? 4194304))
      return Promise.reject(
        new Error("Backend request exceeds message byte limit"),
      );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`Backend ${method} request timed out`)),
        this.config.requestTimeoutMs ?? 5000,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(line, (error) => {
        if (error) this.fail(error);
      });
    });
  }
  async observe(tick: number): Promise<Observation> {
    return parseBackendObservation(await this.rpc("observe", { tick }));
  }
  async apply(action: Action) {
    await this.rpc("apply", { action });
  }
  async respawn() {
    await this.rpc("respawn", {});
  }
  async reset(setup: AgentSetup) {
    if (this.context.mode === "simulator") {
      await this.rpc("reset", { phase: "simulator", setup });
      return;
    }
    await this.rpc("reset", { phase: "before", setup });
    await this.context.managed.applySetup(setup);
    await this.rpc("reset", { phase: "after", setup });
  }
  async teleport(position: ArenaPoint) {
    await this.apply({});
    await this.context.managed.moveToArena();
    await this.rpc("teleport", { position });
  }
  async capture(frame: CaptureFrame) {
    await this.rpc("capture", { frame });
  }
  async close() {
    if (this.closing) return;
    const child = this.child;
    if (!child) {
      this.closing = true;
      return;
    }
    try {
      if (!this.failed && child.exitCode === null) {
        // Bound graceful shutdown independently of the regular adapter timeout.
        await Promise.race([
          this.rpc("close", {}).catch(() => {}),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 500);
            timer.unref();
          }),
        ]);
      }
    } finally {
      this.closing = true;
      this.fail(new Error("Backend session closed"));
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 750);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }
}
