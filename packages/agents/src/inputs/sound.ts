import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

export async function assetDownload(
  url: string,
  hash?: string,
): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok)
    throw new Error(`Minecraft asset request failed (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 16777216) throw new Error("Asset exceeds 16 MiB limit");
  if (hash && createHash("sha1").update(data).digest("hex") !== hash)
    throw new Error("Minecraft asset hash mismatch");
  return data;
}
export class SoundAssets {
  ready = false;
  error?: string;
  private index: any;
  private definitions: any;
  private ids: Record<string, string> = {};
  private cache = new Map<string, { mono: Float32Array; sampleRate: number }>();
  private pending = new Map<
    string,
    Promise<{ mono: Float32Array; sampleRate: number }>
  >();
  readonly initialization: Promise<void>;
  constructor(
    readonly version: string,
    readonly directory: string,
  ) {
    this.initialization = this.initialize().catch((error) => {
      this.error = String(error.message ?? error);
    });
  }
  private async cached(name: string, loader: () => Promise<Buffer>) {
    const path = resolve(this.directory, name);
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const buffer = await loader();
    await mkdir(this.directory, { recursive: true });
    await writeFile(path, buffer);
    return buffer;
  }
  private async initialize() {
    const metadata = JSON.parse(
      (
        await this.cached(`version-${this.version}.json`, async () => {
          const manifest = JSON.parse(
            (
              await assetDownload(
                "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
              )
            ).toString(),
          );
          const entry = manifest.versions.find(
            (item: any) => item.id === this.version,
          );
          if (!entry)
            throw new Error("No official assets for this Minecraft version");
          return assetDownload(entry.url, entry.sha1);
        })
      ).toString(),
    );
    this.index = JSON.parse(
      (
        await this.cached(`index-${this.version}.json`, () =>
          assetDownload(metadata.assetIndex.url, metadata.assetIndex.sha1),
        )
      ).toString(),
    );
    this.definitions = JSON.parse(
      (await this.object("minecraft/sounds.json")).toString(),
    );
    try {
      this.ids = JSON.parse(
        await readFile(
          resolve(this.directory, `sound-ids-${this.version}.json`),
          "utf8",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.ready = true;
  }
  async object(name: string) {
    const entry = this.index?.objects?.[name];
    if (!entry || !/^[a-f0-9]{40}$/.test(entry.hash))
      throw new Error(`Vanilla audio asset is unavailable: ${name}`);
    return this.cached(entry.hash, () =>
      assetDownload(
        `https://resources.download.minecraft.net/${entry.hash.slice(0, 2)}/${entry.hash}`,
        entry.hash,
      ),
    );
  }
  name(id: number) {
    return this.ids[String(id)];
  }
  resolveEvent(
    name: string,
    choice: number,
    seen = new Set<string>(),
  ): { path: string; volume: number; pitch: number } {
    const key = name.replace(/^minecraft:/, "");
    if (seen.has(key) || seen.size > 8) throw new Error("Cyclic sound event");
    seen.add(key);
    const definition = this.definitions[key];
    if (!definition?.sounds?.length)
      throw new Error(
        `No vanilla sample for ${name}; custom/resource-pack sounds need client capture`,
      );
    const values = definition.sounds,
      total = values.reduce(
        (sum: number, value: any) =>
          sum + (typeof value === "string" ? 1 : (value.weight ?? 1)),
        0,
      );
    let pick = ((choice % 1000000) / 1000000) * total,
      selected = values[0];
    for (const value of values) {
      pick -= typeof value === "string" ? 1 : (value.weight ?? 1);
      if (pick < 0) {
        selected = value;
        break;
      }
    }
    if (typeof selected === "string")
      return { path: `minecraft/sounds/${selected}.ogg`, volume: 1, pitch: 1 };
    if (selected.type === "event") {
      const nested = this.resolveEvent(selected.name, choice, seen);
      return {
        ...nested,
        volume: nested.volume * (selected.volume ?? 1),
        pitch: nested.pitch * (selected.pitch ?? 1),
      };
    }
    return {
      path: `minecraft/sounds/${selected.name}.ogg`,
      volume: selected.volume ?? 1,
      pitch: selected.pitch ?? 1,
    };
  }
  clip(path: string) {
    const cached = this.cache.get(path);
    if (cached) return Promise.resolve(cached);
    const pending = this.pending.get(path);
    if (pending) return pending;
    const operation = (async () => {
      const decoder = new OggVorbisDecoder();
      try {
        await decoder.ready;
        const decoded = await decoder.decodeFile(await this.object(path));
        if (decoded.errors.length) throw new Error(decoded.errors[0].message);
        if (decoded.samplesDecoded > decoded.sampleRate * 30)
          throw new Error("Sound sample exceeds 30 seconds");
        const mono = new Float32Array(decoded.samplesDecoded);
        for (const channel of decoded.channelData)
          for (let i = 0; i < mono.length; i++)
            mono[i] += channel[i] / decoded.channelData.length;
        const result = { mono, sampleRate: decoded.sampleRate };
        this.cache.set(path, result);
        while (
          [...this.cache.values()].reduce((n, v) => n + v.mono.byteLength, 0) >
          33554432
        )
          this.cache.delete(this.cache.keys().next().value!);
        return result;
      } finally {
        decoder.free();
      }
    })().finally(() => this.pending.delete(path));
    this.pending.set(path, operation);
    return operation;
  }
}
const assets = new Map<string, SoundAssets>();
export function soundAssets(version: string, directory: string) {
  const key = `${version}:${directory}`;
  let instance = assets.get(key);
  if (!instance) {
    instance = new SoundAssets(version, directory);
    assets.set(key, instance);
  }
  return instance;
}
export class SoundPlayback {
  private assets: SoundAssets;
  private voices: {
    at: number;
    position: Vec3;
    volume: number;
    pitch: number;
    name: string;
    category?: number;
    clip: { mono: Float32Array; sampleRate: number };
  }[] = [];
  private pending = 0;
  private missing = 0;
  private late = 0;
  private counter = 0;
  private closed = false;
  private last = Date.now();
  constructor(
    version: string,
    directory: string,
    private rate: number,
    private windowMs: number,
  ) {
    this.assets = soundAssets(version, directory);
  }
  receive(name: string, data: any, bot: Bot) {
    if (name === "stop_sound") {
      this.voices = this.voices.filter((voice) => {
        const matchesName = !data.sound || voice.name === data.sound;
        const matchesCategory =
          data.source === undefined || voice.category === data.source;
        return !(matchesName && matchesCategory);
      });
      return;
    }
    if (
      !["named_sound_effect", "sound_effect", "entity_sound_effect"].includes(
        name,
      )
    ) {
      if (name === "world_event") this.missing++;
      return;
    }
    const at = Date.now(),
      position =
        name === "entity_sound_effect"
          ? bot.entities[data.entityId]?.position?.clone()
          : new Vec3(data.x / 8, data.y / 8, data.z / 8);
    if (!position) {
      this.missing++;
      return;
    }
    if (this.pending >= 16) {
      this.missing++;
      return;
    }
    this.pending++;
    void (async () => {
      await this.assets.initialization;
      if (!this.assets.ready) throw new Error(this.assets.error);
      const soundName = data.soundName ?? this.assets.name(data.soundId);
      if (!soundName)
        throw new Error(
          "Numeric sound ID mapping is unavailable; prepare vanilla assets",
        );
      const sample = this.assets.resolveEvent(soundName, ++this.counter * 7919),
        clip = await this.assets.clip(sample.path),
        pitch = data.pitch * sample.pitch;
      if (this.closed) return;
      if (
        Date.now() - at >
        (clip.mono.length / clip.sampleRate / pitch) * 1000
      ) {
        this.late++;
        return;
      }
      this.voices.push({
        at,
        position,
        volume: data.volume * sample.volume,
        pitch,
        name: soundName,
        category: data.soundCategory,
        clip,
      });
      if (this.voices.length > 32) {
        this.voices.shift();
        this.missing++;
      }
    })()
      .catch(() => {
        this.missing++;
      })
      .finally(() => {
        this.pending--;
      });
  }
  observe(bot: Bot) {
    if (!this.assets.ready)
      throw new Error(this.assets.error ?? "Vanilla audio assets are loading");
    const to = Date.now(),
      from = to - this.windowMs,
      length = Math.max(1, Math.round(((to - from) * this.rate) / 1000)),
      samples = new Float32Array(length * 2),
      origin = bot.entity.position,
      yaw = bot.entity.yaw;
    for (const voice of this.voices) {
      const delta = voice.position.minus(origin),
        distance = delta.norm(),
        attenuation = Math.max(
          0,
          1 - distance / Math.max(16, voice.volume * 16),
        ),
        volume = Math.min(1, voice.volume) * attenuation,
        pan = distance
          ? Math.max(
              -1,
              Math.min(
                1,
                delta.dot(new Vec3(Math.cos(yaw), 0, -Math.sin(yaw))) /
                  distance,
              ),
            )
          : 0;
      for (let i = 0; i < length; i++) {
        const offset =
          ((from + (i / this.rate) * 1000 - voice.at) / 1000) *
          voice.clip.sampleRate *
          voice.pitch;
        if (offset < 0 || offset >= voice.clip.mono.length - 1) continue;
        const index = Math.floor(offset),
          fraction = offset - index,
          value =
            voice.clip.mono[index] * (1 - fraction) +
            voice.clip.mono[index + 1] * fraction;
        samples[i * 2] += value * volume * Math.sqrt((1 - pan) / 2);
        samples[i * 2 + 1] += value * volume * Math.sqrt((1 + pan) / 2);
      }
    }
    this.voices = this.voices.filter(
      (v) =>
        ((to - v.at) / 1000) * v.clip.sampleRate * v.pitch < v.clip.mono.length,
    );
    this.last = to;
    const buffer = Buffer.alloc(samples.length * 4);
    for (let i = 0; i < samples.length; i++)
      buffer.writeFloatLE(Math.max(-1, Math.min(1, samples[i])), i * 4);
    return {
      sampleRate: this.rate,
      channels: 2,
      encoding: "f32le",
      data: buffer.toString("base64"),
      from,
      to,
      pending: this.pending,
      missing: this.missing,
      late: this.late,
      voices: this.voices.length,
    };
  }
  close() {
    this.closed = true;
    this.voices = [];
  }
}
