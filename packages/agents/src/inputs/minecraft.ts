import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { performance } from "node:perf_hooks";
import {
  defaultInputs,
  inputCatalog,
  isViewerUsername,
  type AgentInputConfig,
  type AgentInputFrame,
  type InputSample,
  type CaptureFrame,
  type InputValue,
} from "@rlcraft/core";
import botEvents from "../../../core/src/bot-events.json" with { type: "json" };
import { InputEvents } from "./events.js";
import { inputJson, projectFields } from "./serialize.js";
import { geometryVision, visibleEntities } from "./vision.js";
import { SoundPlayback } from "./sound.js";

export class MinecraftInputs {
  private events: InputEvents;
  private cache = new Map<string, InputSample>();
  private packets = new Map<string, InputValue>();
  private counts: Record<string, number> = {};
  private sequence = 0;
  private columns = new Map<string, { x: number; z: number }>();
  private bossBars = new Map<string, unknown>();
  private blockEntities = new Map<string, unknown>();
  private attributes = new Map<number, unknown>();
  private cooldowns = new Map<number, { ticks: number; until: number }>();
  private clientTick = 0;
  private captures = new Map<string, CaptureFrame>();
  private listeners: {
    target: NodeJS.EventEmitter;
    name: string;
    listener: (...args: any[]) => void;
  }[] = [];
  private advancementDefinitions = new Map<string, unknown>();
  private advancementProgress = new Map<string, unknown>();
  private statistics = new Map<string, unknown>();
  private maps = new Map<number, unknown[]>();
  private windowProperties = new Map<number, Map<number, number>>();
  private sound?: SoundPlayback;
  constructor(
    private bot: Bot,
    private config: AgentInputConfig = structuredClone(defaultInputs),
    private assetDirectory?: string,
  ) {
    const l = config.limits;
    this.events = new InputEvents(
      l.eventCount,
      l.eventBytes,
      l.packetBytes,
      l.eventWindowMs,
    );
    if (config.channels["audio.pcm"]?.enabled && assetDirectory)
      this.sound = new SoundPlayback(
        bot.version,
        assetDirectory,
        l.audioSampleRate,
        l.audioWindowMs,
      );
    this.listen(bot._client, "packet", (data, meta) => {
      if (meta.state !== "play") return;
      this.packet(String(meta.name), data);
    });
    this.listen(bot, "chunkColumnLoad", (point: Vec3) =>
      this.columns.set(`${point.x},${point.z}`, { x: point.x, z: point.z }),
    );
    this.listen(bot, "chunkColumnUnload", (point: Vec3) =>
      this.columns.delete(`${point.x},${point.z}`),
    );
    this.listen(bot, "physicsTick", () => {
      this.clientTick++;
    });
    this.listen(
      bot,
      "noteHeard",
      (block: any, instrument: any, pitch: number) => {
        const names: Record<string, string> = {
          doubleBass: "bass",
          bassDrum: "basedrum",
          snareDrum: "snare",
          sticks: "hat",
        };
        this.sound?.receive(
          "named_sound_effect",
          {
            soundName: `block.note_block.${names[instrument.name] ?? instrument.name}`,
            x: block.position.x * 8,
            y: block.position.y * 8,
            z: block.position.z * 8,
            volume: 3,
            pitch: 2 ** ((pitch - 12) / 12),
          },
          bot,
        );
      },
    );
    this.listen(bot, "bossBarCreated", (bar: any) =>
      this.bossBars.set(String(bar.entityUUID ?? bar.uuid), inputJson(bar)),
    );
    this.listen(bot, "bossBarUpdated", (bar: any) =>
      this.bossBars.set(String(bar.entityUUID ?? bar.uuid), inputJson(bar)),
    );
    this.listen(bot, "bossBarDeleted", (bar: any) =>
      this.bossBars.delete(String(bar.entityUUID ?? bar.uuid)),
    );
    this.listen(bot, "respawn", () => {
      this.columns.clear();
      this.blockEntities.clear();
      this.attributes.clear();
      this.cooldowns.clear();
      this.cache.clear();
    });
    for (const name of botEvents) {
      if (
        ["physicsTick", "physicTick", "move", "time", "entityMoved"].includes(
          name,
        )
      )
        continue;
      this.listen(bot, name, (...args) => {
        if (
          args.some(
            (arg) =>
              arg && typeof arg === "object" && isViewerUsername(arg.username),
          )
        )
          return;
        const channel = /sound|noteHeard/i.test(name)
          ? "events.sounds"
          : /particle/i.test(name)
            ? "events.particles"
            : /^(entity|playerCollect|itemDrop)/.test(name)
              ? "events.entities"
              : /block|piston|chestLid|digging/i.test(name)
                ? "events.blocks"
                : /chat|whisper|message|actionBar|title/i.test(name)
                  ? "events.messages"
                  : /window|heldItem/i.test(name)
                    ? "events.inventory"
                    : "events.lifecycle";
        if (config.channels[channel]?.enabled)
          this.events.push(channel, name, inputJson(args));
      });
    }
  }
  private listen(
    target: NodeJS.EventEmitter,
    name: string,
    listener: (...args: any[]) => void,
  ) {
    target.on(name, listener);
    this.listeners.push({ target, name, listener });
  }
  private packet(name: string, data: any) {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    if (
      this.config.channels["events.inventory"]?.enabled &&
      [
        "set_slot",
        "window_items",
        "open_window",
        "close_window",
        "craft_progress_bar",
        "trade_list",
        "held_item_slot",
      ].includes(name)
    )
      this.events.push("events.inventory", `packet:${name}`, inputJson(data));
    const stateNames = [
      "abilities",
      "initialize_world_border",
      "world_border_center",
      "world_border_size",
      "world_border_lerp_size",
      "world_border_warning_delay",
      "world_border_warning_reach",
      "set_title_text",
      "set_title_subtitle",
      "set_title_time",
      "action_bar",
      "clear_titles",
      "enter_combat_event",
      "end_combat_event",
      "death_combat_event",
      "declare_recipes",
      "unlock_recipes",
      "advancements",
      "select_advancement_tab",
      "statistics",
      "declare_commands",
      "tab_complete",
      "tags",
      "resource_pack_send",
      "trade_list",
      "craft_progress_bar",
      "map",
    ];
    if (stateNames.includes(name)) this.packets.set(name, inputJson(data));
    if (name === "map_chunk")
      for (const entity of data.blockEntities ?? [])
        this.blockEntities.set(
          `${data.x},${data.z},${entity.xz},${entity.y}`,
          inputJson({ chunkX: data.x, chunkZ: data.z, ...entity }),
        );
    if (name === "unload_chunk") {
      const prefix = `${data.chunkX},${data.chunkZ},`;
      for (const key of this.blockEntities.keys())
        if (key.startsWith(prefix)) this.blockEntities.delete(key);
    }
    if (name === "advancements") {
      if (data.reset) {
        this.advancementDefinitions.clear();
        this.advancementProgress.clear();
      }
      for (const id of data.identifiers ?? []) {
        this.advancementDefinitions.delete(id);
        this.advancementProgress.delete(id);
      }
      for (const item of data.advancementMapping ?? [])
        this.advancementDefinitions.set(item.key, inputJson(item.value));
      for (const item of data.progressMapping ?? [])
        this.advancementProgress.set(item.key, inputJson(item.value));
    }
    if (name === "statistics")
      for (const entry of data.entries ?? [])
        this.statistics.set(
          `${entry.categoryId}:${entry.statisticId}`,
          inputJson(entry),
        );
    if (name === "map") {
      const patches = this.maps.get(data.itemDamage) ?? [];
      patches.push(inputJson(data));
      if (patches.length > 128) patches.shift();
      this.maps.set(data.itemDamage, patches);
      if (this.maps.size > 64) this.maps.delete(this.maps.keys().next().value!);
    }
    if (name === "craft_progress_bar") {
      const properties =
        this.windowProperties.get(data.windowId) ?? new Map<number, number>();
      properties.set(data.property, data.value);
      this.windowProperties.set(data.windowId, properties);
    }
    if (name === "close_window") this.windowProperties.delete(data.windowId);
    if (name === "tile_entity_data") {
      const key = JSON.stringify(data.location);
      if (this.blockEntities.size > 1024)
        this.blockEntities.delete(this.blockEntities.keys().next().value!);
      this.blockEntities.set(key, inputJson(data));
    }
    if (name === "entity_update_attributes") {
      this.attributes.set(data.entityId, inputJson(data.properties));
      if (this.attributes.size > 1024)
        this.attributes.delete(this.attributes.keys().next().value!);
    }
    if (name === "set_cooldown")
      this.cooldowns.set(data.itemID ?? data.itemId, {
        ticks: data.cooldownTicks,
        until: this.clientTick + data.cooldownTicks,
      });
    if (
      [
        "sound_effect",
        "named_sound_effect",
        "entity_sound_effect",
        "stop_sound",
        "world_event",
        "block_action",
      ].includes(name)
    ) {
      if (this.config.channels["events.sounds"]?.enabled)
        this.events.push("events.sounds", `packet:${name}`, inputJson(data));
      this.sound?.receive(name, data, this.bot);
    }
    if (this.config.channels["protocol.packets"]?.enabled)
      this.events.push("protocol.packets", name, inputJson(data));
  }
  capture(frame: CaptureFrame) {
    const key = frame.kind === "rgb" ? "vision.rgb" : "audio.capture";
    if (!this.config.channels[key]?.enabled)
      throw new Error("This capture channel is disabled for the run");
    const previous = this.captures.get(key);
    if (previous && frame.sequence <= previous.sequence)
      throw new Error("Capture sequence must increase");
    this.captures.set(key, frame);
    this.cache.delete(key);
  }
  observe(tick: number): AgentInputFrame {
    const at = Date.now(),
      channels: Record<string, InputSample> = {};
    for (const descriptor of inputCatalog.channels) {
      const setting = this.config.channels[descriptor.id];
      if (!setting?.enabled) continue;
      let sample = this.cache.get(descriptor.id);
      if (!sample || at - sample.sampledAt >= setting.intervalMs) {
        const began = performance.now();
        try {
          const value = this.read(descriptor.id);
          sample = {
            status: "ready",
            sampledAt: at,
            source: descriptor.source,
            data: projectFields(inputJson(value), setting.fields),
            durationMs: performance.now() - began,
          };
        } catch (error) {
          sample = {
            status: "unavailable",
            sampledAt: at,
            source: descriptor.source,
            reason: error instanceof Error ? error.message : String(error),
            durationMs: performance.now() - began,
          };
        }
        this.cache.set(descriptor.id, sample);
      }
      channels[descriptor.id] = sample;
    }
    return {
      schemaVersion: 1,
      at,
      tick,
      sequence: ++this.sequence,
      channels,
      diagnostics: this.events.diagnostics,
    };
  }
  private received(name: string) {
    const value = this.packets.get(name);
    if (value === undefined) throw new Error(`No ${name} packet received yet`);
    return value;
  }
  private read(id: string): unknown {
    const b = this.bot,
      e = b.entity as unknown as Record<string, unknown>;
    const select = (source: any, fields: string[]) =>
      Object.fromEntries(
        fields
          .filter((key) => source?.[key] !== undefined)
          .map((key) => [key, source[key]]),
      );
    switch (id) {
      case "self.identity":
        return {
          username: b.username,
          uuid: b.entity.uuid ?? b.player?.uuid,
          id: b.entity.id,
          version: b.version,
          protocolVersion: b.protocolVersion,
        };
      case "self.pose":
        return select(
          e,
          inputCatalog.channels.find((c) => c.id === id)!.fields,
        );
      case "self.vitals":
        return {
          health: b.health,
          food: b.food,
          saturation: b.foodSaturation,
          oxygen: b.oxygenLevel,
          alive: b.health > 0,
        };
      case "self.experience":
        return b.experience;
      case "self.effects":
        return { effects: b.entity.effects, metadata: b.entity.metadata };
      case "self.attributes":
        return { attributes: this.receivedAttributes() };
      case "self.physics":
        return {
          ...select(e, inputCatalog.channels.find((c) => c.id === id)!.fields),
          fireworkRocketDuration: b.fireworkRocketDuration,
          physicsEnabled: b.physicsEnabled,
        };
      case "self.controls":
        return b.controlState;
      case "self.inventory":
        return {
          slots: b.inventory.slots.map((item, index) => ({
            slot: index,
            item: inputJson(item),
          })),
          heldItem: inputJson(b.heldItem),
          quickBarSlot: b.quickBarSlot,
          equipment: inputJson(b.entity.equipment),
          usingHeldItem: b.usingHeldItem,
        };
      case "self.digging":
        return {
          target: inputJson(b.targetDigBlock ?? null),
          canDig: b.targetDigBlock ? b.canDigBlock(b.targetDigBlock) : null,
          estimatedMs: b.targetDigBlock ? b.digTime(b.targetDigBlock) : null,
        };
      case "self.abilities":
        return this.received("abilities");
      case "self.cooldowns":
        return {
          items: [...this.cooldowns]
            .filter(([, c]) => c.until > this.clientTick)
            .map(([item, c]) => ({
              item,
              ticksRemaining: c.until - this.clientTick,
            })),
        };
      case "world.game":
        return b.game;
      case "world.time":
        return b.time;
      case "world.weather":
        return {
          raining: b.isRaining,
          rainState: (b as any).rainState,
          thunderState: b.thunderState,
        };
      case "world.spawn":
        return { position: b.spawnPoint };
      case "world.border":
        return {
          initialize: this.received("initialize_world_border"),
          center: this.packets.get("world_border_center"),
          size: this.packets.get("world_border_size"),
          lerp: this.packets.get("world_border_lerp_size"),
          warningDistance: this.packets.get("world_border_warning_reach"),
          warningTime: this.packets.get("world_border_warning_delay"),
        };
      case "world.blocks": {
        const blocks = [],
          p = b.entity.position.floored(),
          r = this.config.limits.blockRadius;
        let unknownCount = 0;
        for (let y = -r; y <= r; y++)
          for (let z = -r; z <= r; z++)
            for (let x = -r; x <= r; x++) {
              const pos = p.offset(x, y, z),
                block = b.blockAt(pos);
              if (!block) {
                unknownCount++;
                blocks.push({ position: pos, loaded: false });
              } else
                blocks.push({
                  position: pos,
                  loaded: true,
                  stateId: block.stateId,
                  type: block.type,
                  name: block.name,
                  properties: block.getProperties(),
                  light: block.light,
                  skyLight: block.skyLight,
                  biome: inputJson(block.biome),
                  shapes: block.shapes,
                  transparent: block.transparent,
                  hardness: block.hardness,
                  material: block.material,
                  diggable: block.diggable,
                  waterlogged: block.isWaterlogged,
                });
            }
        return { radius: r, blocks, unknownCount };
      }
      case "world.chunks":
        return { columns: [...this.columns.values()] };
      case "world.blockEntities":
        return { entries: [...this.blockEntities.values()] };
      case "world.maps":
        return {
          maps: [...this.maps].map(([id, patches]) => ({
            id,
            patches,
            coverage:
              "received rolling patches; not a complete reconstructed map",
          })),
        };
      case "entities.visible":
        return { entities: visibleEntities(b, this.config.limits.entities) };
      case "players.tab":
        return {
          players: Object.values(b.players)
            .filter((player) => !isViewerUsername(player.username))
            .map((p) =>
              select(p, [
                "uuid",
                "username",
                "gamemode",
                "ping",
                "displayName",
                "skinData",
              ]),
            ),
          header: b.tablist?.header,
          footer: b.tablist?.footer,
        };
      case "ui.window":
        return b.currentWindow
          ? {
              ...select(b.currentWindow, [
                "id",
                "type",
                "title",
                "inventoryStart",
                "inventoryEnd",
              ]),
              slots: b.currentWindow.slots,
              properties: Object.fromEntries(
                this.windowProperties.get(b.currentWindow.id) ?? [],
              ),
              trades: this.packets.get("trade_list"),
            }
          : null;
      case "ui.scoreboards":
        return {
          objectives: b.scoreboards,
          positions: b.scoreboard,
          teams: b.teams,
        };
      case "ui.bossBars":
        return { bars: [...this.bossBars.values()] };
      case "ui.titles":
        return {
          title: this.packets.get("set_title_text"),
          subtitle: this.packets.get("set_title_subtitle"),
          timing: this.packets.get("set_title_time"),
          actionBar: this.packets.get("action_bar"),
        };
      case "ui.combat":
        return {
          enter: this.packets.get("enter_combat_event"),
          end: this.packets.get("end_combat_event"),
          death: this.packets.get("death_combat_event"),
        };
      case "knowledge.recipes":
        return {
          declarations: this.received("declare_recipes"),
          book: this.packets.get("unlock_recipes"),
        };
      case "knowledge.advancements":
        this.received("advancements");
        return {
          updates: {
            definitions: Object.fromEntries(this.advancementDefinitions),
            progress: Object.fromEntries(this.advancementProgress),
          },
          selectedTab: this.packets.get("select_advancement_tab"),
        };
      case "knowledge.statistics":
        this.received("statistics");
        return { values: [...this.statistics.values()] };
      case "knowledge.commands":
        return {
          tree: this.received("declare_commands"),
          suggestions: this.packets.get("tab_complete"),
        };
      case "knowledge.tags":
        return { tags: this.received("tags") };
      case "knowledge.resourcePack":
        return { offer: this.received("resource_pack_send") };
      case "vision.geometry":
        return geometryVision(b, this.config.limits);
      case "vision.rgb":
      case "audio.capture": {
        const frame = this.captures.get(id);
        if (!frame)
          throw new Error("No rendered client capture producer is attached");
        if (Date.now() - frame.capturedAt > 2000)
          throw new Error("Captured media frame is stale");
        return { frame };
      }
      case "audio.pcm":
        if (!this.sound) throw new Error("Audio asset storage not configured");
        return this.sound.observe(b);
      case "protocol.packets":
        return {
          events: this.events.read(id),
          counts: { ...this.counts },
          definitionsVersion: b.version,
        };
      default:
        if (id.startsWith("events.")) return { events: this.events.read(id) };
        throw new Error("No provider registered");
    }
  }
  private receivedAttributes() {
    const value = this.attributes.get(this.bot.entity.id);
    if (value === undefined)
      throw new Error("No self attribute packet received yet");
    return value;
  }
  close() {
    for (const { target, name, listener } of this.listeners)
      target.removeListener(name, listener);
    this.listeners = [];
    this.sound?.close();
  }
}
