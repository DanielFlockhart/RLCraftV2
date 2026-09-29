import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  open,
  unlink,
} from "node:fs/promises";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../apps/control/src/config.js";
import {
  fabricRoot,
  fabricVersion,
  fabricLoader,
  fabricSourceHash,
} from "../packages/runtime/src/fabric.js";
import {
  downloadFile,
  readJson,
  extractZip,
} from "../packages/runtime/src/downloads.js";
import { buildFabricClient } from "./build-fabric-client.js";

const directory = fabricRoot(config.dataDir);
await mkdir(directory, { recursive: true });
const lock = resolve(directory, "prepare.lock");
const handle = await open(lock, "wx").catch(() => {
  throw new Error(
    "Fabric preparation already running; if a previous build crashed, remove its prepare.lock before retrying",
  );
});
try {
  const built = await buildFabricClient(directory);
  const index = await readJson(
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  );
  const version = index.versions.find((v: any) => v.id === fabricVersion);
  if (!version) throw new Error("Missing official client version");
  const metadataPath = resolve(directory, "version.json");
  await downloadFile(version.url, metadataPath, version.sha1);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const clientJar = resolve(directory, "minecraft/client-1.18.1.jar");
  await downloadFile(
    metadata.downloads.client.url,
    clientJar,
    metadata.downloads.client.sha1,
  );
  const loader = await readJson(
    `https://meta.fabricmc.net/v2/versions/loader/${fabricVersion}/${fabricLoader}/profile/json`,
  );
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "osx"
        : "linux";
  if (process.arch !== "x64")
    throw new Error(
      "The pinned Minecraft 1.18.1 native bundle currently supports x64 hosts only",
    );
  const classpath = [clientJar],
    natives = resolve(directory, "natives");
  await mkdir(natives, { recursive: true });
  for (const library of [...metadata.libraries, ...loader.libraries]) {
    let allowed = !library.rules;
    for (const rule of library.rules ?? [])
      if (
        !rule.os ||
        (rule.os.name === os && !rule.os.arch && !rule.os.version)
      )
        allowed = rule.action === "allow";
    if (!allowed) continue;
    let artifact = library.downloads?.artifact;
    if (!artifact && library.url) {
      const [group, name, version] = library.name.split(":"),
        path = `${group.replaceAll(".", "/")}/${name}/${version}/${name}-${version}.jar`,
        url = `${library.url}${path}`;
      const checksum = await fetch(url + ".sha1");
      if (!checksum.ok)
        throw new Error(`Cannot verify Fabric dependency ${name}`);
      artifact = { path, url, sha1: (await checksum.text()).trim() };
    }
    if (artifact) {
      const file = resolve(directory, "libraries", artifact.path);
      await downloadFile(artifact.url, file, artifact.sha1);
      if (!classpath.includes(file)) classpath.push(file);
    }
    const classifier = library.natives?.[os]?.replace("${arch}", "64"),
      native = classifier && library.downloads?.classifiers?.[classifier];
    if (native) {
      const file = resolve(directory, "libraries", native.path);
      await downloadFile(native.url, file, native.sha1);
      await extractZip(file, natives);
    }
  }
  const assets = resolve(directory, "assets"),
    assetIndex = metadata.assetIndex.id,
    assetFile = resolve(assets, "indexes", `${assetIndex}.json`);
  await downloadFile(
    metadata.assetIndex.url,
    assetFile,
    metadata.assetIndex.sha1,
  );
  const objects = Object.values(
    JSON.parse(await readFile(assetFile, "utf8")).objects,
  ) as { hash: string }[];
  console.log(`Preparing ${objects.length} verified Minecraft client assets…`);
  let next = 0,
    completed = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const object = objects[next++];
        if (!object) return;
        const prefix = object.hash.slice(0, 2);
        await downloadFile(
          `https://resources.download.minecraft.net/${prefix}/${object.hash}`,
          resolve(assets, "objects", prefix, object.hash),
          object.hash,
        );
        if (++completed % 500 === 0)
          console.log(`Client assets: ${completed}/${objects.length}`);
      }
    }),
  );
  const mod = resolve(directory, "mods/rlcraft-fabric-agent.jar");
  await mkdir(resolve(directory, "mods"), { recursive: true });
  await copyFile(built.jar, mod);
  const rel = (file: string) => relative(directory, file).replaceAll("\\", "/");
  await writeFile(
    resolve(directory, "runtime.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        minecraftVersion: fabricVersion,
        loader: fabricLoader,
        platform: process.platform,
        arch: process.arch,
        java: rel(built.java),
        mainClass: loader.mainClass,
        classpath: classpath.map(rel),
        natives: rel(natives),
        assets: rel(assets),
        assetIndex,
        mod: rel(mod),
        modSha256: createHash("sha256")
          .update(await readFile(mod))
          .digest("hex"),
        sourceHash: await fabricSourceHash(),
      },
      null,
      2,
    ),
  );
  console.log(
    "Fabric rendering clients are prepared. Select Fabric in New training run; each agent owns its client and live camera.",
  );
} finally {
  await handle.close();
  await unlink(lock);
}
