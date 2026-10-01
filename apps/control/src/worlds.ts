import { readFile, writeFile, rename, access } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import nbt from "prismarine-nbt";
import minecraftData from "minecraft-data";
import { z } from "zod";
import type {
  WorldCatalog,
  WorldGeneration,
  WorldProfile,
  WorldRunContext,
  WorldSettings,
} from "@mlcraft/core";

const data = minecraftData("1.18.1");
const resource = z.string().regex(/^minecraft:[a-z0-9_]+$/);
const block = resource.refine(
  (value) => !!data.blocksByName[value.slice(10)],
  "Unknown Minecraft 1.18.1 block",
);
const biome = resource.refine(
  (value) => !!data.biomesByName[value.slice(10)],
  "Unknown Minecraft 1.18.1 biome",
);
const seed = z
  .string()
  .max(64)
  .refine((value) => !/[\r\n\0\\]/.test(value), "Invalid seed")
  .transform((value) => value.trim());
export const worldSettingsSchema = z
  .object({
    type: z.enum(["survival", "flat", "large_biomes", "amplified"]),
    seed,
    difficulty: z.enum(["peaceful", "easy", "normal", "hard"]),
    gamemode: z.enum(["survival", "creative", "adventure"]),
    structures: z.boolean(),
    flat: z
      .object({
        biome,
        layers: z
          .array(
            z
              .object({ block, height: z.number().int().min(1).max(384) })
              .strict(),
          )
          .min(1)
          .max(32),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.flat.layers.reduce((n, layer) => n + layer.height, 0) <= 384,
    "Flat layers must total at most 384 blocks",
  );
export const worldCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    settings: worldSettingsSchema,
  })
  .strict();
const levelNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const generationSchema = z.object({
  id: z.uuid(),
  levelName: levelNameSchema,
  createdAt: z.string(),
  settings: worldSettingsSchema,
  properties: z.record(z.string(), z.string()).optional(),
});
const manifestSchema = z.object({
  version: z.literal(1),
  profiles: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        generations: z.array(generationSchema).min(1).max(500),
      }),
    )
    .min(1)
    .max(50),
});
const keys = [
  "level-name",
  "level-type",
  "level-seed",
  "generator-settings",
  "generate-structures",
  "difficulty",
  "gamemode",
];
const flatDefault = {
  biome: "minecraft:plains",
  layers: [
    { block: "minecraft:bedrock", height: 1 },
    { block: "minecraft:dirt", height: 2 },
    { block: "minecraft:grass_block", height: 1 },
  ],
};

function randomSeed() {
  return randomBytes(8).readBigInt64BE().toString();
}
function adoptedId(value: string) {
  const hash = createHash("sha256")
    .update(`rlcraft-world:${value}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function readProperties(text: string) {
  const properties: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!\s:=]+)\s*[:=]\s*(.*)$/);
    if (match) properties[match[1]] = match[2].replace(/\\([:=\\])/g, "$1");
  }
  return properties;
}
function replaceProperties(text: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!keys.includes(key) || /[\r\n\0]/.test(value))
      throw new Error("Invalid world property");
    const line = `${key}=${value.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}`;
    const pattern = new RegExp(`^[ \\t]*${key}\\s*[:=][^\\r\\n]*`, "gm");
    text = pattern.test(text)
      ? text.replace(pattern, () => line)
      : `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n`;
  }
  return text;
}
function propertiesFor(generation: WorldGeneration) {
  if (generation.properties) return generation.properties;
  const settings = generation.settings;
  return {
    "level-name": generation.levelName,
    "level-type":
      settings.type === "survival"
        ? "default"
        : settings.type === "large_biomes"
          ? "largebiomes"
          : settings.type,
    "level-seed": settings.seed,
    "generator-settings":
      settings.type === "flat"
        ? JSON.stringify({
            biome: settings.flat.biome,
            layers: settings.flat.layers,
            structures: {
              structures: settings.structures
                ? {
                    "minecraft:village": {
                      spacing: 32,
                      separation: 8,
                      salt: 10387312,
                    },
                  }
                : {},
            },
          })
        : "{}",
    "generate-structures": String(settings.structures),
    difficulty: settings.difficulty,
    gamemode: settings.gamemode,
  };
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function atomicWrite(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { flag: "wx" });
  await rename(temporary, path);
}

/** Resets select a new directory; previous world/dimension/player files are never deleted. */
export class WorldManager {
  busy = false;
  private profiles?: Promise<WorldProfile[]>;
  private propertiesPath: string;
  private manifestPath: string;
  constructor(
    private serverDir: string,
    private blocked: () => string | undefined,
    private log: (message: string) => void,
  ) {
    this.propertiesPath = resolve(serverDir, "server.properties");
    this.manifestPath = resolve(serverDir, "rlcraft-worlds.json");
  }
  private async load(): Promise<WorldProfile[]> {
    const profiles = await (this.profiles ??= this.loadInitial().catch(
      (error) => {
        this.profiles = undefined;
        throw error;
      },
    ));
    if (!profiles.length && (await exists(this.propertiesPath))) {
      this.profiles = undefined;
      return this.load();
    }
    return profiles;
  }
  private async loadInitial(): Promise<WorldProfile[]> {
    if (await exists(this.manifestPath))
      return manifestSchema.parse(
        JSON.parse(await readFile(this.manifestPath, "utf8")),
      ).profiles;
    if (!(await exists(this.propertiesPath))) return [];
    const properties = readProperties(
      await readFile(this.propertiesPath, "utf8"),
    );
    const levelName = levelNameSchema.parse(
      properties["level-name"] || "world",
    );
    let actualSeed = properties["level-seed"] || "";
    const levelDat = resolve(this.serverDir, levelName, "level.dat");
    if (await exists(levelDat)) {
      const parsed = nbt.simplify(
        (await nbt.parse(await readFile(levelDat), "big")).parsed,
      );
      const value =
        parsed.Data?.WorldGenSettings?.seed ?? parsed.Data?.RandomSeed;
      if (typeof value === "bigint") actualSeed = value.toString();
      else if (Array.isArray(value) && value.length === 2)
        actualSeed = BigInt.asIntN(
          64,
          (BigInt(value[0]) << 32n) | BigInt(value[1] >>> 0),
        ).toString();
    }
    const rawType = properties["level-type"]?.replace("minecraft:", "");
    const type = rawType === "largebiomes" ? "large_biomes" : rawType;
    let flat = flatDefault;
    if (type === "flat" && properties["generator-settings"]) {
      const candidate = JSON.parse(properties["generator-settings"]);
      if (candidate.biome && candidate.layers)
        flat = { biome: candidate.biome, layers: candidate.layers };
    }
    const settings = worldSettingsSchema.parse({
      type: ["flat", "large_biomes", "amplified"].includes(type)
        ? type
        : "survival",
      seed: actualSeed,
      difficulty: properties.difficulty || "normal",
      gamemode: properties.gamemode || "survival",
      structures: properties["generate-structures"] !== "false",
      flat,
    });
    return [
      {
        id: adoptedId(`profile:${levelName}`),
        name: "Existing training world",
        generations: [
          {
            id: adoptedId(`generation:${levelName}`),
            levelName,
            createdAt: new Date().toISOString(),
            settings,
            properties: {
              "level-name": levelName,
              "level-type": properties["level-type"] || "default",
              "level-seed": properties["level-seed"] || "",
              "generator-settings": properties["generator-settings"] || "{}",
              "generate-structures": String(settings.structures),
              difficulty: settings.difficulty,
              gamemode: settings.gamemode,
            },
          },
        ],
      },
    ];
  }
  async catalog(): Promise<WorldCatalog> {
    const profiles = await this.load();
    let active: WorldCatalog["active"];
    if (await exists(this.propertiesPath)) {
      const name =
        readProperties(await readFile(this.propertiesPath, "utf8"))[
          "level-name"
        ] || "world";
      for (const profile of profiles) {
        const generation = profile.generations.find(
          (g) => g.levelName === name,
        );
        if (generation)
          active = {
            profileId: profile.id,
            generationId: generation.id,
            levelName: name,
          };
      }
    }
    const reason = this.busy
      ? "World change in progress"
      : (this.blocked() ??
        (!(await exists(this.propertiesPath))
          ? "Prepare the server first"
          : undefined));
    return { profiles, active, busy: this.busy, canChange: !reason, reason };
  }
  async context(): Promise<WorldRunContext | undefined> {
    const catalog = await this.catalog();
    const active = catalog.active;
    const generation = catalog.profiles
      .find((p) => p.id === active?.profileId)
      ?.generations.find((g) => g.id === active?.generationId);
    return active && generation
      ? { ...active, settings: generation.settings }
      : undefined;
  }
  private async change(action: (profiles: WorldProfile[]) => Promise<void>) {
    if (this.busy) throw new Error("World change already in progress");
    this.busy = true;
    try {
      const reason = this.blocked();
      if (reason) throw new Error(reason);
      if (!(await exists(this.propertiesPath)))
        throw new Error("Prepare the server first");
      const profiles = structuredClone(await this.load());
      if (this.blocked()) throw new Error(this.blocked());
      await action(profiles);
    } finally {
      this.busy = false;
    }
    return this.catalog();
  }
  private async persist(profiles: WorldProfile[]) {
    manifestSchema.parse({ version: 1, profiles });
    await atomicWrite(
      this.manifestPath,
      JSON.stringify({ version: 1, profiles }, null, 2),
    );
    this.profiles = Promise.resolve(profiles);
  }
  private async select(generation: WorldGeneration) {
    const text = await readFile(this.propertiesPath, "utf8");
    await atomicWrite(
      this.propertiesPath,
      replaceProperties(text, propertiesFor(generation)),
    );
  }
  private generation(settings: WorldSettings): WorldGeneration {
    const id = randomUUID();
    return {
      id,
      levelName: `rlcraft-${id}`,
      createdAt: new Date().toISOString(),
      settings: { ...settings, seed: settings.seed || randomSeed() },
    };
  }
  create(input: z.infer<typeof worldCreateSchema>) {
    return this.change(async (profiles) => {
      if (profiles.length >= 50)
        throw new Error("World profile limit reached (50)");
      const profile: WorldProfile = {
        id: randomUUID(),
        name: input.name,
        generations: [this.generation(input.settings)],
      };
      profiles.push(profile);
      await this.persist(profiles);
      await this.select(profile.generations[0]);
      this.log(
        `Created and selected world profile '${profile.name}' (${profile.generations[0].levelName})`,
      );
    });
  }
  activate(id: string, generationId: string) {
    return this.change(async (profiles) => {
      const profile = profiles.find((p) => p.id === id);
      const generation = profile?.generations.find(
        (g) => g.id === generationId,
      );
      if (!generation) throw new Error("World generation not found");
      await this.persist(profiles);
      await this.select(generation);
      this.log(`Selected world '${profile!.name}' generation ${generation.id}`);
    });
  }
  reset(
    id: string,
    generationId: string,
    random: boolean,
    edits?: WorldSettings,
  ) {
    return this.change(async (profiles) => {
      const profile = profiles.find((p) => p.id === id);
      const previous = profile?.generations.find((g) => g.id === generationId);
      if (!profile || !previous) throw new Error("World generation not found");
      if (profile.generations.length >= 500)
        throw new Error("World generation limit reached (500)");
      const settings = structuredClone(edits ?? previous.settings);
      if (random) settings.seed = randomSeed();
      const generation = this.generation(settings);
      profile.generations.push(generation);
      await this.persist(profiles);
      await this.select(generation);
      this.log(
        `Fresh generation selected for '${profile.name}'; previous world retained (${previous.levelName})`,
      );
    });
  }
}
