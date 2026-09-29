import mineflayer, { type Bot } from "mineflayer";
import type {
  Action,
  Environment,
  Observation,
  AgentSetup,
  ArenaPoint,
  AgentInputConfig,
  CaptureFrame,
} from "@rlcraft/core";
import { defaultInputs, inputCatalog } from "@rlcraft/core";
import { MinecraftInputs } from "../inputs/minecraft.js";
import { MinecraftProgress } from "../progression.js";
import type { ProgressEvidence } from "@rlcraft/core";
export class MinecraftEnvironment implements Environment {
  private progression?: MinecraftProgress;
  private progressListener?: (evidence: ProgressEvidence) => void;
  watchProgress(listener: (evidence: ProgressEvidence) => void) {
    this.progressListener = listener;
    return () => {
      this.progressListener = undefined;
      this.progression?.close();
    };
  }
  private sensors?: MinecraftInputs;
  private bot?: Bot;
  private failure?: Error;
  private initialPosition?: ArenaPoint;
  private resetPosition?: ArenaPoint;
  constructor(
    private username: string,
    private config: {
      host: string;
      port: number;
      version: string;
      auth: "offline" | "microsoft";
    },
    private applySetup?: (setup: AgentSetup) => Promise<void>,
    private moveToArena?: () => Promise<void>,
    private inputs: AgentInputConfig = structuredClone(defaultInputs),
    private assetDirectory?: string,
  ) {}
  async connect() {
    const bot = mineflayer.createBot({
      ...this.config,
      username: this.username,
      respawn: false,
    });
    this.bot = bot;
    this.sensors = new MinecraftInputs(bot, this.inputs, this.assetDirectory);
    if (this.progressListener && this.config.version === "1.18.1")
      this.progression = new MinecraftProgress(bot, (evidence) =>
        this.progressListener?.(evidence),
      );
    bot.on("error", (err) => {
      this.failure = err;
    });
    bot.on("kicked", (reason) => {
      this.failure = new Error(
        `Kicked: ${typeof reason === "string" ? reason : JSON.stringify(reason)}`,
      );
    });
    bot.on("end", () => {
      this.failure ??= new Error("Minecraft connection ended");
    });
    await new Promise<void>((resolve, reject) => {
      let spawned = false,
        positioned = false;
      const timeout = setTimeout(
        () => finish(new Error("Minecraft spawn timed out after 30 seconds")),
        30000,
      );
      const spawn = () => {
        spawned = true;
        if (positioned) finish();
      };
      // Await Mineflayer's delayed initial position acknowledgement before teleporting.
      const position = () => {
        positioned = true;
        if (spawned) finish();
      };
      const error = (err: Error) => finish(err);
      const end = () =>
        finish(this.failure ?? new Error("Disconnected before spawn"));
      const finish = (err?: Error) => {
        clearTimeout(timeout);
        bot.removeListener("spawn", spawn);
        bot.removeListener("forcedMove", position);
        bot.removeListener("error", error);
        bot.removeListener("end", end);
        err ? reject(err) : resolve();
      };
      bot.once("spawn", spawn);
      bot.once("forcedMove", position);
      bot.once("error", error);
      bot.once("end", end);
    });
    this.initialPosition = { ...bot.entity.position };
    this.progression?.sample();
    this.progression?.setOrigin("live");
  }
  observe(tick: number): Observation {
    if (this.failure) throw this.failure;
    if (!this.bot?.entity) throw new Error("Agent is not spawned");
    const b = this.bot;
    const p = b.entity.position;
    const inventory: Record<string, number> = {};
    for (const item of b.inventory.slots
      .slice(5)
      .filter((item) => item !== null))
      inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
    return {
      position: { x: p.x, y: p.y, z: p.z },
      health: b.health,
      food: b.food,
      inventory,
      tick,
      inputs: this.sensors!.observe(tick),
    };
  }
  async apply(action: Action) {
    if (this.failure) throw this.failure;
    const b = this.bot!;
    b.clearControlStates();
    for (const [control, value] of Object.entries(action.controls ?? {}))
      b.setControlState(control as mineflayer.ControlState, Boolean(value));
    if (action.look) await b.look(action.look.yaw, action.look.pitch, true);
    if (action.dig) {
      const block = b.blockAtCursor(4);
      if (block && b.canDigBlock(block)) await b.dig(block);
    }
  }
  async close() {
    this.progression?.close();
    this.progression = undefined;
    this.sensors?.close();
    this.sensors = undefined;
    this.bot?.clearControlStates();
    this.bot?.quit();
    this.bot = undefined;
  }
  capture(frame: CaptureFrame) {
    if (!this.sensors) throw new Error("Agent is not connected");
    this.sensors.capture(frame);
  }
  async reset(setup: AgentSetup) {
    if (!this.applySetup)
      throw new Error(
        "This Minecraft connection has no managed agent setup adapter",
      );
    this.progression?.setOrigin("setup");
    this.bot!.clearControlStates();
    await this.respawn();
    const resetBot = this.bot!;
    let vitalsSynced = !setup.resetVitals;
    const healthUpdate = () => {
      if (
        Math.abs(resetBot.health - setup.health) < 0.1 &&
        resetBot.food === setup.food
      )
        vitalsSynced = true;
    };
    resetBot.on("health", healthUpdate);
    try {
      await this.applySetup(setup);
      const deadline = Date.now() + 5000;
      this.resetPosition ??= setup.spawn ?? this.initialPosition;
      const position = setup.spawn ?? this.resetPosition;
      const minecraftSlot = (slot: number) =>
        slot <= 8 ? slot + 36 : slot <= 35 ? slot : slot <= 39 ? 44 - slot : 45;
      while (Date.now() < deadline) {
        if (this.failure) throw this.failure;
        const bot = this.bot!;
        const ready =
          setup.items.every((item) => {
            const actual = bot.inventory.slots[minecraftSlot(item.slot)];
            return (
              actual?.name === item.item.replace(/^minecraft:/, "") &&
              actual.count === item.count
            );
          }) &&
          (!setup.clearInventory ||
            bot.inventory.slots
              .slice(5)
              .every(
                (item, index) =>
                  !item ||
                  setup.items.some(
                    (configured) =>
                      minecraftSlot(configured.slot) === index + 5,
                  ),
              )) &&
          (!setup.resetVitals ||
            (vitalsSynced && bot.experience.level === setup.experienceLevel)) &&
          bot.quickBarSlot === setup.heldSlot &&
          (setup.gamemode === "world" ||
            bot.game.gameMode === setup.gamemode) &&
          (!position ||
            (Math.abs(bot.entity.position.x - position.x) < 1 &&
              Math.abs(bot.entity.position.z - position.z) < 1));
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `Agent setup was applied but client inventory/vitals did not synchronise before the deadline: ${JSON.stringify({ observed: this.observe(0), expected: setup, heldSlot: this.bot!.quickBarSlot, experienceLevel: this.bot!.experience.level, gamemode: this.bot!.game.gameMode })}`,
      );
    } finally {
      resetBot.removeListener("health", healthUpdate);
      this.progression?.sample();
      this.progression?.setOrigin("live");
    }
  }
  async respawn() {
    if (this.failure) throw this.failure;
    const bot = this.bot!;
    if (bot.health > 0) return;
    await new Promise<void>((resolve, reject) => {
      let spawned = false,
        positioned = false;
      const timer = setTimeout(
        () => finish(new Error("Agent respawn timed out")),
        15000,
      );
      const spawn = () => {
        spawned = true;
        if (positioned) finish();
      };
      const position = () => {
        positioned = true;
        if (spawned) finish();
      };
      const end = () =>
        finish(this.failure ?? new Error("Disconnected during respawn"));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        bot.removeListener("spawn", spawn);
        bot.removeListener("forcedMove", position);
        bot.removeListener("end", end);
        error ? reject(error) : resolve();
      };
      bot.once("spawn", spawn);
      bot.once("forcedMove", position);
      bot.once("end", end);
      bot.respawn();
    });
  }
  async teleport(position: ArenaPoint) {
    if (!this.moveToArena)
      throw new Error("This Minecraft connection has no arena spawn adapter");
    this.bot!.clearControlStates();
    await this.moveToArena();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (this.failure) throw this.failure;
      const actual = this.bot!.entity.position;
      if (
        Math.abs(actual.x - position.x) < 0.8 &&
        Math.abs(actual.y - position.y) < 0.8 &&
        Math.abs(actual.z - position.z) < 0.8
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Arena teleport was not synchronised to the agent client");
  }
}
