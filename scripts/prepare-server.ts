import { copyFile, mkdir, access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root, config } from "../apps/control/src/config.js";
import { buildViewerPlugin } from "./build-viewer-plugin.js";
import { ensurePlayerCapacity } from "../apps/control/src/server-properties.js";
const target = config.serverDir;
const source = resolve(
  process.argv[2] ?? resolve(root, "../RLCraft/server/paper-1.18.1-216.jar"),
);
await mkdir(target, { recursive: true });
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
const jar = resolve(target, "server.jar");
if (!(await exists(jar))) {
  await access(source);
  await copyFile(source, jar);
  console.log("Copied Paper jar to isolated V2 runtime.");
}
async function create(name: string, contents: string) {
  const path = resolve(target, name);
  if (!(await exists(path))) await writeFile(path, contents, { flag: "wx" });
}
await create(
  "eula.txt",
  "# Read https://aka.ms/MinecraftEULA and set true if you agree.\neula=false\n",
);
await create(
  "server.properties",
  `# Local bot training server. Offline authentication must stay on a trusted network.
server-ip=${config.MC_BIND_HOST}
server-port=${config.MC_PORT}
online-mode=false
enable-rcon=false
enable-status=true
motd=MLCraft Training
max-players=${Math.max(config.MC_MAX_PLAYERS, config.MAX_AGENTS + 4)}
view-distance=4
simulation-distance=4
sync-chunk-writes=true
max-tick-time=60000
gamemode=survival
force-gamemode=false
difficulty=normal
level-name=training-world
level-type=default
spawn-protection=0
pvp=true
allow-flight=true
network-compression-threshold=256
`,
);
ensurePlayerCapacity(
  resolve(target, "server.properties"),
  Math.max(config.MC_MAX_PLAYERS, config.MAX_AGENTS + 4),
);
await buildViewerPlugin();
console.log(
  `Prepared ${target}\nAccept the EULA in eula.txt, then start the server from the dashboard. Existing settings are preserved; the player capacity minimum is enforced.`,
);
