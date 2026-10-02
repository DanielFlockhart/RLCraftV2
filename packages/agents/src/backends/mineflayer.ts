import mineflayer, { type Bot } from "mineflayer";
import type {
  Action,
  Environment,
  Observation,
  AgentSetup,
  ArenaPoint,
  AgentInputConfig,
  CaptureFrame,
} from "@mlcraft/core";
import { defaultInputs, inputCatalog } from "@mlcraft/core";
import { combatMobTypes } from "../../../core/src/combat.js";
import { chooseMiningTool, skillAffordance } from "../../../core/src/interaction.js";
import type { SkillRequest, SkillResult } from "../../../core/src/interaction.js";
import { Vec3 } from "vec3";
import { MinecraftInputs } from "../inputs/minecraft.js";
import { MinecraftProgress } from "../progression.js";
import type { ProgressEvidence } from "@mlcraft/core";
export class MinecraftEnvironment implements Environment {
  private blocking = false;
  private lastAttackAt = 0;
  private lastAttackTarget?: number;
  private lastRangedAttackAt = 0;
  private lastRangedAttackTarget?: number;
  private confirmedHits = 0;
  private recentHurt = new Map<number, number>();
  private usingItemSince = 0;
  private static readonly combatMobs = new Set<string>(combatMobTypes);
  private static readonly projectiles = new Set([
    "arrow",
    "spectral_arrow",
    "small_fireball",
    "fireball",
    "potion",
    "trident",
    "llama_spit",
  ]);
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
    private combatBounds?: {
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    },
  ) {}
  async connect() {
    const bot = mineflayer.createBot({
      ...this.config,
      username: this.username,
      respawn: false,
    });
    this.bot = bot;
    bot.on("entityHurt", (entity) => {
      if (entity?.id !== undefined) this.recentHurt.set(entity.id, Date.now());
      if (
        (entity?.id === this.lastAttackTarget &&
          Date.now() - this.lastAttackAt < 1200) ||
        (entity?.id === this.lastRangedAttackTarget &&
          Date.now() - this.lastRangedAttackAt < 3000)
      )
        this.confirmedHits++;
    });
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
    const targets = Object.values(b.entities)
      .filter(
        (entity) =>
          MinecraftEnvironment.combatMobs.has(entity.name ?? "") &&
          entity.position.distanceTo(p) < 32 &&
          (!this.combatBounds ||
            (entity.position.x >= this.combatBounds.minX &&
              entity.position.x <= this.combatBounds.maxX &&
              entity.position.z >= this.combatBounds.minZ &&
              entity.position.z <= this.combatBounds.maxZ)),
      )
      .sort((a, c) => a.position.distanceTo(p) - c.position.distanceTo(p))
      .map((entity) => ({
        id: entity.id,
        type: entity.name!,
        position: {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z,
        },
        velocity: {
          x: entity.velocity.x,
          y: entity.velocity.y,
          z: entity.velocity.z,
        },
        onFire: (Number(entity.metadata?.[0] ?? 0) & 1) !== 0,
        recentlyHurt: Date.now() - (this.recentHurt.get(entity.id) ?? 0) < 700,
        ...(entity.name === "creeper"
          ? {
              creeperFuse: Number(entity.metadata?.[16] ?? 0),
              creeperCharged: Boolean(entity.metadata?.[17]),
              creeperIgnited: Boolean(entity.metadata?.[18]),
            }
          : {}),
        ...(typeof (entity as unknown as { health?: number }).health ===
        "number"
          ? { health: (entity as unknown as { health: number }).health }
          : {}),
      }));
    const projectiles = Object.values(b.entities)
      .filter(
        (entity) =>
          MinecraftEnvironment.projectiles.has(entity.name ?? "") &&
          entity.position.distanceTo(p) < 24 &&
          (!this.combatBounds ||
            (entity.position.x >= this.combatBounds.minX &&
              entity.position.x <= this.combatBounds.maxX &&
              entity.position.z >= this.combatBounds.minZ &&
              entity.position.z <= this.combatBounds.maxZ)),
      )
      .sort((a, c) => a.position.distanceTo(p) - c.position.distanceTo(p))
      .slice(0, 4)
      .map((entity) => ({
        position: {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z,
        },
        velocity: {
          x: entity.velocity.x,
          y: entity.velocity.y,
          z: entity.velocity.z,
        },
      }));
    const effects = Object.values(b.entity.effects ?? {}) as Array<{
      id?: number;
    }>;
    const crossbowNbt = b.heldItem?.nbt as
      { value?: { Charged?: { value?: number | boolean } } } | undefined;
    return {
      position: { x: p.x, y: p.y, z: p.z },
      health: b.health,
      food: b.food,
      inventory,
      tick,
      combat: {
        targets,
        projectiles,
        confirmedHits: this.confirmedHits,
        shieldRaised: this.blocking,
        selfOnFire: (Number(b.entity.metadata?.[0] ?? 0) & 1) !== 0,
        poisoned: effects.some((effect) => effect.id === 19),
        slowed: effects.some((effect) => effect.id === 2),
        withered: effects.some((effect) => effect.id === 20),
        itemUseTicks: this.usingItemSince
          ? (Date.now() - this.usingItemSince) / 50
          : 0,
        weaponLoaded:
          crossbowNbt?.value?.Charged?.value === 1 ||
          crossbowNbt?.value?.Charged?.value === true,
        attackReady: Math.min(
          1,
          (Date.now() - this.lastAttackAt) /
            (b.heldItem?.name.endsWith("_axe") ? 1100 : 650),
        ),
      },
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
    const trackRangedShot = () => {
      const aimed = b.entityAtCursor(32);
      if (
        aimed &&
        MinecraftEnvironment.combatMobs.has(aimed.name ?? "") &&
        (!this.combatBounds ||
          (aimed.position.x >= this.combatBounds.minX &&
            aimed.position.x <= this.combatBounds.maxX &&
            aimed.position.z >= this.combatBounds.minZ &&
            aimed.position.z <= this.combatBounds.maxZ))
      ) {
        this.lastRangedAttackTarget = aimed.id;
        this.lastRangedAttackAt = Date.now();
      }
    };
    if (
      action.block &&
      !this.blocking &&
      b.inventory.slots[45]?.name === "shield"
    ) {
      b.activateItem(true);
      this.blocking = true;
    } else if (
      (!action.block || b.inventory.slots[45]?.name !== "shield") &&
      this.blocking
    ) {
      b.deactivateItem();
      this.blocking = false;
    }
    if (
      action.use &&
      !this.usingItemSince &&
      ["bow", "crossbow", "trident"].includes(b.heldItem?.name ?? "")
    ) {
      if (b.heldItem?.name === "crossbow") trackRangedShot();
      b.activateItem();
      this.usingItemSince = Date.now();
    } else if (
      (!action.use ||
        !["bow", "crossbow", "trident"].includes(b.heldItem?.name ?? "")) &&
      this.usingItemSince
    ) {
      trackRangedShot();
      b.deactivateItem();
      this.usingItemSince = 0;
    }
    if (action.attack) {
      const entity = b.entityAtCursor(3.2);
      if (
        entity &&
        Date.now() - this.lastAttackAt >=
          (b.heldItem?.name.endsWith("_axe") ? 1100 : 650) &&
        MinecraftEnvironment.combatMobs.has(entity.name ?? "") &&
        (!this.combatBounds ||
          (entity.position.x >= this.combatBounds.minX &&
            entity.position.x <= this.combatBounds.maxX &&
            entity.position.z >= this.combatBounds.minZ &&
            entity.position.z <= this.combatBounds.maxZ))
      ) {
        b.attack(entity);
        this.lastAttackAt = Date.now();
        this.lastAttackTarget = entity.id;
      }
    }
    if (action.dig) {
      const block = b.blockAtCursor(4);
      if (block && b.canDigBlock(block)) await b.dig(block);
    }
  }
  async executeSkill(request: SkillRequest): Promise<SkillResult> {
    if (this.failure) throw this.failure;
    const started = Date.now();
    const bot = this.bot!;
    let actions = 0;
    let toolCorrect: boolean | undefined;
    const inventory = () => Object.fromEntries(
      bot.inventory.items().map((item) => [
        item.name,
        bot.inventory.items().filter((entry) => entry.name === item.name)
          .reduce((count, entry) => count + entry.count, 0),
      ]),
    );
    const before = inventory();
    const result = (
      status: SkillResult["status"],
      reason?: SkillResult["reason"],
      targetRemoved?: boolean,
      missing?: SkillResult["missing"],
    ): SkillResult => {
      const after = inventory();
      const delta = Object.fromEntries(
        [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .map((item) => [item, (after[item] ?? 0) - (before[item] ?? 0)])
          .filter(([, count]) => count !== 0),
      ) as Record<string, number>;
      return {
        status,
        ...(reason ? { reason } : {}),
        state_delta: { inventory: delta, ...(targetRemoved !== undefined ? { targetRemoved } : {}) },
        duration_ms: Date.now() - started,
        metrics: { actions, ...(toolCorrect !== undefined ? { toolCorrect } : {}) },
        ...(missing ? { missing } : {}),
      };
    };
    const target = request.target.position;
    if (!target || !request.target.block || !["AIM", "MINE"].includes(request.skill))
      return result("FAILURE", "INTERACTION_FAILED");
    const position = new Vec3(target.x, target.y, target.z);
    const expected = request.target.block.replace(/^minecraft:/, "");
    const readyDeadline = Date.now() + 5000;
    let block = bot.blockAt(position);
    while (block?.name !== expected && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      block = bot.blockAt(position);
    }
    const distance = bot.entity.position.offset(0, 1.62, 0)
      .distanceTo(position.offset(0.5, 0.5, 0.5));
    const affordance = skillAffordance(request, {
      inventory: before,
      distance,
      targetExists: block?.name === expected,
    });
    if (!affordance.executable)
      return result("FAILURE", affordance.reason, undefined, affordance.missing);
    try {
      if (request.parameters?.startYaw !== undefined) {
        await bot.look(request.parameters.startYaw, request.parameters.startPitch ?? 0, true);
        actions++;
      }
      await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
      actions++;
      if (!bot.blockAtCursor(4.5)?.position.equals(position))
        return result("FAILURE", "TARGET_UNREACHABLE");
      if (request.skill === "AIM") return result("SUCCESS");
      const tool = chooseMiningTool(expected, before);
      if (tool) {
        const item = bot.inventory.items().find((entry) => entry.name === tool);
        if (!item) return result("FAILURE", "MISSING_TOOL");
        await bot.equip(item, "hand");
        actions++;
        toolCorrect = true;
      }
      if (!bot.canDigBlock(block!)) return result("FAILURE", "TARGET_UNREACHABLE");
      await bot.dig(block!, true);
      actions++;
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && bot.blockAt(position)?.name === expected)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const removed = bot.blockAt(position)?.name !== expected;
      return removed ? result("SUCCESS", undefined, true) : result("FAILURE", "INTERACTION_FAILED", false);
    } catch (error) {
      const message = String((error as Error).message);
      return result("FAILURE", /far|reach|view/i.test(message) ? "TARGET_UNREACHABLE" : "INTERACTION_FAILED");
    }
  }
  async close() {
    this.blocking = false;
    if (this.usingItemSince) this.bot?.deactivateItem();
    this.usingItemSince = 0;
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
    if (this.blocking) {
      this.bot!.deactivateItem();
      this.blocking = false;
    }
    if (this.usingItemSince) {
      this.bot!.deactivateItem();
      this.usingItemSince = 0;
    }
    this.lastAttackAt = 0;
    this.lastAttackTarget = undefined;
    this.lastRangedAttackAt = 0;
    this.lastRangedAttackTarget = undefined;
    this.confirmedHits = 0;
    this.recentHurt.clear();
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
