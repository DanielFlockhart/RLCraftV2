import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  copyFile,
  writeFile,
  readFile,
} from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { resolve, delimiter, dirname } from "node:path";
import { z } from "zod";
import {
  DEFAULT_RENDER_SETTINGS,
  type Environment,
  type Observation,
  type Action,
  type AgentSetup,
  type ArenaPoint,
  type CaptureFrame,
  type ProgressEvidence,
} from "@mlcraft/core";
import type { BackendContext } from "./contract.js";
import { parseBackendObservation } from "./observation.js";
import {
  fabricRoot,
  readFabricManifest,
  renderSchema,
} from "../../../runtime/src/fabric.js";

const evidenceSchema = z
  .object({
    milestoneId: z.string().max(100),
    at: z.number().int().positive(),
    source: z.enum([
      "inventory",
      "advancement",
      "statistic",
      "dimension",
      "block",
      "window",
      "credits",
      "end-return",
    ]),
    detail: z.string().max(1000),
    origin: z.enum(["existing", "setup", "live"]),
    gameMode: z.enum(["survival", "adventure", "creative", "spectator"]),
  })
  .strict();
export function parseRgbFrame(value: unknown): CaptureFrame | undefined {
  if (value == null) return;
  const frame = z
    .object({
      kind: z.literal("rgb"),
      encoding: z.literal("rgb8"),
      sequence: z.number().int().nonnegative(),
      capturedAt: z.number().int().positive(),
      width: z.number().int().min(1).max(512),
      height: z.number().int().min(1).max(512),
      data: z
        .string()
        .max(1048576)
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        ),
    })
    .strict()
    .parse(value);
  if (
    Buffer.from(frame.data, "base64").length !==
    frame.width * frame.height * 3
  )
    throw new Error("Invalid framebuffer byte count");
  if (frame.capturedAt > Date.now() + 250)
    throw new Error("Future framebuffer timestamp");
  if (Date.now() - frame.capturedAt > 2000) return;
  return frame;
}
export function offlineUuid(username: string) {
  const hash = createHash("md5").update(`OfflinePlayer:${username}`).digest();
  hash[6] = (hash[6] & 15) | 48;
  hash[8] = (hash[8] & 63) | 128;
  return hash.toString("hex");
}
const delay = (ms: number) => new Promise<void>((yes) => setTimeout(yes, ms));
export class FabricEnvironment implements Environment {
  private child?: ChildProcess;
  private socket?: Socket;
  private log?: WriteStream;
  private failure?: Error;
  private closing = false;
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private token = randomBytes(32).toString("hex");
  private timer?: ReturnType<typeof setInterval>;
  private listener?: (evidence: ProgressEvidence) => void;
  private pending = new Map<
    number,
    {
      yes: (value: any) => void;
      no: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private context: BackendContext) {}
  watchProgress(listener: (evidence: ProgressEvidence) => void) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.no(this.failure);
    }
    this.pending.clear();
  }
  async connect() {
    if (this.child || this.closing)
      throw new Error("Fabric client cannot connect twice");
    if (
      this.context.connection.version !== "1.18.1" ||
      this.context.connection.auth !== "offline"
    )
      throw new Error(
        "Managed Fabric clients currently require Minecraft 1.18.1 with offline authentication on a trusted training server",
      );
    if (
      !/^[a-f0-9-]{36}$/.test(this.context.runId) ||
      !/^rl_[a-f0-9]{6}_\d{1,3}$/.test(this.context.username)
    )
      throw new Error("Invalid managed client identity");
    const directory = fabricRoot(dirname(this.context.assetDirectory));
    const manifest = await readFabricManifest(directory).catch((error) => {
      throw new Error(
        `Prepare Fabric clients from the dashboard or npm run clients:prepare. ${error.message}`,
      );
    });
    const render = renderSchema.parse(
      this.context.render ?? DEFAULT_RENDER_SETTINGS,
    );
    const sessions = resolve(directory, "sessions", this.context.runId);
    await mkdir(sessions, { recursive: true });
    const session = await mkdtemp(
      resolve(sessions, `${this.context.username}-`),
    );
    await mkdir(resolve(session, "mods"));
    await copyFile(
      resolve(directory, manifest.mod),
      resolve(session, "mods/rlcraft-fabric-agent.jar"),
    );
    await writeFile(
      resolve(session, "options.txt"),
      "version:2865\nfullscreen:false\nmaxFps:30\nenableVsync:false\npauseOnLostFocus:false\nautoJump:false\nrenderDistance:4\nmusic:0.0\n",
    );
    const ready = resolve(session, "ready.json");
    const args = [
      "-Xms256M",
      process.env.FABRIC_CLIENT_MEMORY ?? "-Xmx1G",
      `-Djava.library.path=${resolve(directory, manifest.natives)}`,
      "-Dlog4j2.formatMsgNoLookups=true",
      "-cp",
      manifest.classpath.map((p) => resolve(directory, p)).join(delimiter),
      manifest.mainClass,
      "--version",
      "1.18.1",
      "--versionType",
      "release",
      "--gameDir",
      session,
      "--assetsDir",
      resolve(directory, manifest.assets),
      "--assetIndex",
      manifest.assetIndex,
      "--username",
      this.context.username,
      "--uuid",
      offlineUuid(this.context.username),
      "--accessToken",
      "0",
      "--userType",
      "legacy",
      "--width",
      String(Math.max(320, render.width)),
      "--height",
      String(Math.max(240, render.height)),
    ];
    const argumentFile = resolve(session, "client.args");
    await writeFile(
      argumentFile,
      args
        .map((arg) => `"${arg.replaceAll("\\", "/").replaceAll('"', '\\"')}"`)
        .join("\n"),
    );
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|XAUTHORITY|LIBGL_ALWAYS_SOFTWARE)$/i.test(
          name,
        ),
      ),
    );
    const child = (this.child = spawn(
      resolve(directory, manifest.java),
      [`@${argumentFile}`],
      {
        cwd: session,
        env: {
          ...inherited,
          RLCRAFT_RPC_TOKEN: this.token,
          RLCRAFT_READY_FILE: ready,
        },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ));
    this.log = createWriteStream(resolve(session, "client.log"));
    let logged = 0;
    const log = (chunk: Buffer) => {
      if (logged < 8 * 1024 * 1024) {
        this.log?.write(chunk);
        logged += chunk.length;
      }
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code) => {
      if (!this.closing)
        this.fail(
          new Error(
            `Fabric client exited ${code}; inspect ${resolve(session, "client.log")}`,
          ),
        );
    });
    try {
      const deadline = Date.now() + 90000;
      let port: number | undefined;
      while (!port) {
        if (this.failure) throw this.failure;
        if (Date.now() > deadline)
          throw new Error(
            `Fabric startup timed out; inspect ${resolve(session, "client.log")}`,
          );
        try {
          const notice = JSON.parse(await readFile(ready, "utf8"));
          if (
            notice.protocol !== 1 ||
            !Number.isInteger(notice.port) ||
            notice.port < 1 ||
            notice.port > 65535
          )
            throw new Error("Invalid Fabric ready message");
          port = notice.port;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!port) await delay(100);
      }
      const socket = (this.socket = createConnection({
        host: "127.0.0.1",
        port,
      }));
      socket.on("error", (error) => this.fail(error));
      socket.on("close", () => {
        if (!this.closing) this.fail(new Error("Fabric RPC disconnected"));
      });
      socket.on("data", (chunk) => this.receive(chunk));
      await new Promise<void>((yes, no) => {
        socket.once("connect", yes);
        socket.once("error", no);
      });
      while (!(await this.rpc("boot", {})).ready) {
        if (Date.now() > deadline)
          throw new Error("Minecraft client resource loading timed out");
        await delay(100);
      }
      await this.rpc("connect", {
        host: this.context.connection.host,
        port: this.context.connection.port,
        inputs: this.context.inputs,
        render,
      });
      let readyPlayer = false;
      while (!readyPlayer) {
        if (Date.now() > deadline)
          throw new Error("Fabric player connection timed out");
        const status = await this.rpc("status", {});
        readyPlayer = !!status.connected;
        if (!readyPlayer) await delay(100);
      }
      await this.rpc("clear", { origin: "live" });
      let busy = false;
      this.timer = setInterval(() => {
        if (busy || this.closing || this.failure) return;
        busy = true;
        void this.observe(0)
          .catch((error) => this.fail(error))
          .finally(() => {
            busy = false;
          });
      }, 1000);
      this.timer.unref();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private receive(chunk: Buffer) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let newline: number;
      while ((newline = this.buffer.indexOf(10)) !== -1) {
        if (newline > 2 * 1024 * 1024)
          throw new Error("Fabric response exceeds 2 MiB");
        const value = JSON.parse(
          this.buffer.subarray(0, newline).toString("utf8"),
        );
        this.buffer = this.buffer.subarray(newline + 1);
        if (value.protocol !== 1 || !Number.isSafeInteger(value.id))
          throw new Error("Invalid Fabric reply");
        const request = this.pending.get(value.id);
        if (!request) throw new Error("Unexpected Fabric reply ID");
        clearTimeout(request.timer);
        this.pending.delete(value.id);
        typeof value.error === "string"
          ? request.no(new Error(value.error))
          : request.yes(value.result);
      }
      if (this.buffer.length > 2 * 1024 * 1024)
        throw new Error("Fabric response buffer exceeded");
    } catch (error) {
      this.fail(error as Error);
      this.socket?.destroy();
    }
  }
  private rpc(method: string, params: unknown): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.socket || this.socket.destroyed)
      return Promise.reject(new Error("Fabric client is not connected"));
    if (this.pending.size >= 16)
      return Promise.reject(new Error("Fabric RPC request capacity exceeded"));
    const id = ++this.nextId;
    return new Promise((yes, no) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Fabric ${method} timed out`);
        no(error);
        this.fail(error);
        this.socket?.destroy();
      }, 10000);
      this.pending.set(id, { yes, no, timer });
      this.socket!.write(
        JSON.stringify({ protocol: 1, id, token: this.token, method, params }) +
          "\n",
      );
    });
  }
  async observe(tick: number): Promise<Observation> {
    const value = await this.rpc("observe", { tick });
    if (!Array.isArray(value.progress) || value.progress.length > 512)
      throw new Error("Invalid Fabric progress buffer");
    for (const evidence of value.progress)
      this.listener?.(evidenceSchema.parse(evidence));
    const observation = parseBackendObservation(value.observation);
    const rgb = observation.inputs!.channels["vision.rgb"];
    if (rgb?.status === "ready") {
      const frame = parseRgbFrame((rgb.data as any)?.frame);
      if (!frame)
        observation.inputs!.channels["vision.rgb"] = {
          status: "unavailable",
          sampledAt: Date.now(),
          source: "vanilla-framebuffer",
          reason: "Rendered frame is stale",
        };
    }
    return observation;
  }
  async feed() {
    return parseRgbFrame(await this.rpc("feed", {}));
  }
  async sound(muted?: boolean): Promise<{ muted: boolean }> {
    return await this.rpc("sound", muted === undefined ? {} : { muted });
  }
  async apply(action: Action) {
    await this.rpc("apply", action);
  }
  async capture(_frame: CaptureFrame) {
    throw new Error(
      "Fabric owns its camera; external frames cannot replace its framebuffer",
    );
  }
  async reset(setup: AgentSetup) {
    await this.rpc("clear", { origin: "setup" });
    try {
      await this.respawn();
      await this.context.managed.applySetup(setup);
      const end = Date.now() + 15000;
      for (;;) {
        const state = await this.rpc("setup-state", {});
        const itemSlots = new Map(setup.items.map((item) => [item.slot, item]));
        const slotsMatch = state.slots.every(
          (slot: { name: string; count: number }, index: number) => {
            const expected = itemSlots.get(index);
            return expected
              ? slot.name === expected.item.replace(/^minecraft:/, "") &&
                  slot.count === expected.count
              : !setup.clearInventory ||
                  slot.name === "air" ||
                  slot.count === 0;
          },
        );
        const vitalsMatch =
          !setup.resetVitals ||
          (Math.abs(state.health - setup.health) < 0.5 &&
            state.food === setup.food &&
            state.experienceLevel === setup.experienceLevel);
        const modeMatch =
          setup.gamemode === "world" || state.gamemode === setup.gamemode;
        const positionMatch =
          !setup.spawn ||
          Math.hypot(
            state.position.x - setup.spawn.x,
            state.position.y - setup.spawn.y,
            state.position.z - setup.spawn.z,
          ) < 0.75;
        if (
          slotsMatch &&
          vitalsMatch &&
          modeMatch &&
          positionMatch &&
          state.heldSlot === setup.heldSlot
        )
          break;
        if (Date.now() > end)
          throw new Error(
            "Fabric client did not synchronize configured inventory/vitals/position within 15 seconds",
          );
        await delay(100);
      }
      await this.observe(0);
    } finally {
      await this.rpc("clear", { origin: "live" });
    }
  }
  async teleport(position: ArenaPoint) {
    await this.context.managed.moveToArena();
    const end = Date.now() + 15000;
    while (
      Math.hypot(
        ...Object.entries((await this.observe(0)).position).map(
          ([key, value]) => value - position[key as keyof ArenaPoint],
        ),
      ) > 0.75
    ) {
      if (Date.now() > end)
        throw new Error("Fabric arena teleport acknowledgement timed out");
      await delay(100);
    }
  }
  async respawn() {
    const observation = await this.observe(0);
    if (observation.health <= 0) {
      await this.rpc("respawn", {});
      const end = Date.now() + 15000;
      while ((await this.observe(0)).health <= 0) {
        if (Date.now() > end) throw new Error("Fabric respawn timed out");
        await delay(100);
      }
    }
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    if (this.socket && !this.socket.destroyed && !this.failure)
      await this.rpc("close", {}).catch(() => {});
    this.socket?.destroy();
    this.fail(new Error("Fabric session closed"));
    const child = this.child;
    if (child && child.exitCode === null)
      await new Promise<void>((yes) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 4000);
        child.once("close", () => {
          clearTimeout(timer);
          yes();
        });
        child.kill("SIGTERM");
      });
    this.log?.end();
    this.listener = undefined;
  }
}
