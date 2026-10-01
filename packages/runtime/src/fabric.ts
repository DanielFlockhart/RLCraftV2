import { resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_RENDER_SETTINGS } from "@mlcraft/core";

export const fabricVersion = "1.18.1";
export const fabricLoader = "0.16.14";
export const renderSchema = z
  .object({
    width: z.number().int().min(64).max(512),
    height: z.number().int().min(64).max(512),
    fps: z.number().int().min(1).max(30),
    viewDistance: z.number().int().min(2).max(16),
    showHud: z.boolean(),
    visibleWindow: z.boolean(),
  })
  .strict()
  .default(DEFAULT_RENDER_SETTINGS);
export const fabricRoot = (dataDirectory: string) =>
  resolve(process.env.FABRIC_DIR ?? resolve(dataDirectory, "fabric"));
export const fabricManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    minecraftVersion: z.literal("1.18.1"),
    loader: z.literal("0.16.14"),
    platform: z.string(),
    arch: z.string(),
    java: z.string(),
    mainClass: z.literal("net.fabricmc.loader.impl.launch.knot.KnotClient"),
    classpath: z.array(z.string()).min(2),
    natives: z.string(),
    assets: z.string(),
    assetIndex: z.string(),
    mod: z.string(),
    modSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export async function fabricSourceHash() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const hash = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".gradle", "build"].includes(entry.name)) continue;
      const file = resolve(directory, entry.name);
      hash.update(entry.name);
      if (entry.isDirectory()) await walk(file);
      else hash.update(await readFile(file));
    }
  };
  await walk(resolve(root, "clients/fabric-agent"));
  hash.update(
    await readFile(resolve(root, "packages/core/src/progression-catalog.json")),
  );
  return hash.digest("hex");
}
export async function readFabricManifest(directory: string) {
  const manifest = fabricManifestSchema.parse(
    JSON.parse(await readFile(resolve(directory, "runtime.json"), "utf8")),
  );
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error(
      "Fabric runtime was prepared on another host architecture; prepare it on this host",
    );
  if (manifest.sourceHash !== (await fabricSourceHash()))
    throw new Error(
      "Fabric client sources changed; prepare the rendering client again",
    );
  if (
    createHash("sha256")
      .update(await readFile(resolve(directory, manifest.mod)))
      .digest("hex") !== manifest.modSha256
  )
    throw new Error("Fabric client artifact checksum mismatch; prepare again");
  return manifest;
}
