import { spawn } from "node:child_process";
import { access, readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../apps/control/src/config.js";
import { soundAssets } from "../packages/agents/src/inputs/sound.js";
const directory = resolve(config.dataDir, "observation-assets");
await mkdir(directory, { recursive: true });
const assets = soundAssets(config.MC_VERSION, directory);
await assets.initialization;
if (!assets.ready) throw new Error(assets.error);
const jar = resolve(
  config.serverDir,
  "cache",
  `mojang_${config.MC_VERSION}.jar`,
);
await access(jar);
// Offline vanilla data generator, isolated from all server worlds and sockets.
const workspace = await mkdtemp(resolve(directory, "registry-"));
await new Promise<void>((accept, reject) => {
  const child = spawn(
    config.JAVA_PATH,
    [
      "-DbundlerMainClass=net.minecraft.data.Main",
      "-jar",
      jar,
      "--reports",
      "--output",
      resolve(workspace, "output"),
    ],
    { cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (data) => {
    log = (log + data).slice(-4096);
  });
  child.stderr.on("data", (data) => {
    log = (log + data).slice(-4096);
  });
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("Vanilla registry generator exceeded 90 seconds"));
  }, 90000);
  const terminate = () => {
    child.kill();
    process.exitCode = 1;
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  child.on("error", reject);
  child.on("close", (code) => {
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
    clearTimeout(timer);
    code === 0
      ? accept()
      : reject(new Error(`Vanilla registry generator failed: ${log}`));
  });
});
const report = JSON.parse(
  await readFile(resolve(workspace, "output/reports/registries.json"), "utf8"),
);
const ids = Object.fromEntries(
  Object.entries(report["minecraft:sound_event"].entries).map(
    ([name, definition]) => [
      String((definition as { protocol_id: number }).protocol_id),
      name,
    ],
  ),
);
await writeFile(
  resolve(directory, `sound-ids-${config.MC_VERSION}.json`),
  JSON.stringify(ids, null, 2),
);
for (const sound of [
  "block.note_block.harp",
  "entity.player.hurt",
  "entity.player.levelup",
  "entity.generic.explode",
]) {
  const sample = assets.resolveEvent(sound, 0);
  await assets.clip(sample.path);
}
console.log(
  `Prepared official vanilla sound definitions, ${Object.keys(ids).length} numeric IDs and common PCM samples in ${directory}`,
);
