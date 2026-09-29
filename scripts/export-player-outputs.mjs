import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? "1.18.1";
const output = resolve(root, process.argv[3] ?? "docs/player-outputs");
// Never rewrite the baseline README with another version's protocol table.
if (version !== "1.18.1" && output === resolve(root, "docs/player-outputs")) {
  throw new Error("Supply a separate output folder for an alternate version.");
}
const data = require("minecraft-data")(version);
if (!data || data.version.minecraftVersion !== version) {
  throw new Error(`Exact Minecraft data is unavailable for ${version}.`);
}
const metadata = {
  minecraftVersion: version,
  protocolVersion: data.version.version,
  dataVersion: data.version.dataVersion,
  source: "Installed minecraft-data registry (pc/Java)",
  minecraftDataPackageVersion: require("minecraft-data/package.json").version,
  effectiveDataVersion: data.version,
};
const types = data.protocol.play.toServer.types;
const mappings = types.packet[1][0].type[1].mappings;
const packets = Object.entries(mappings).map(([id, name]) => ({
  id,
  name,
  schema: types[`packet_${name}`],
}));
if (packets.some((packet) => !packet.schema)) {
  throw new Error("Missing serverbound packet schema.");
}
const baselinePurposes = [
  "Maintenance: acknowledge server teleport; not a teleport ability.",
  "Restricted: debug block-NBT query.",
  "Restricted: request difficulty change where permitted.",
  "Submit chat or slash command; command permissions apply.",
  "Request respawn or updated statistics.",
  "Send client preferences, not world rules.",
  "Request text/command completions.",
  "Select current menu button; also used outside enchanting.",
  "Inventory/menu click, revision and predicted changes.",
  "Close current inventory/container menu.",
  "Client-brand/plugin/mod payload; channel-defined behavior.",
  "Edit book; optional title signs it. Legacy hand field means inventory slot in this version.",
  "Restricted: debug entity-NBT query.",
  "Interact, attack, or interact at entity-local point.",
  "Restricted: request jigsaw structure generation.",
  "Maintenance: heartbeat reply.",
  "Restricted: request difficulty lock where permitted.",
  "Report control/physics-generated position; server validates.",
  "Report position and camera together; server validates.",
  "Report camera orientation in protocol degrees.",
  "Report on-ground state; packet name does not grant flight.",
  "Report controlled vehicle position/orientation.",
  "Report boat paddle input.",
  "Move existing inventory item to selected hotbar slot.",
  "Request recipe placement in current crafting menu.",
  "Toggle flying only if server has granted permission.",
  "Mine start/cancel/finish, drop stack/item, release use, swap hands.",
  "Sneak/sprint, leave bed, horse jump/inventory, elytra start.",
  "Vehicle directional input and jump/dismount flags.",
  "Maintenance: reply to server ping.",
  "Set recipe-book open/filter preferences.",
  "Acknowledge displayed recipe.",
  "Change anvil naming text.",
  "Report resource-pack acceptance/download outcome.",
  "Select advancement tab or report screen close.",
  "Select displayed trade offer.",
  "Choose beacon powers; payment/level restrictions apply.",
  "Select hotbar slot 0–8.",
  "Restricted: edit command block.",
  "Restricted: edit command-block minecart.",
  "Creative: set/delete stack or drop via special slot.",
  "Restricted: edit jigsaw configuration.",
  "Restricted: configure/save/load structure block.",
  "Submit four sign lines through valid editor context.",
  "Swing hand; damage/mining is separate.",
  "Spectator: request camera/teleport target UUID.",
  "Use item on block hit point; may place or interact.",
  "Use held item in air with selected hand.",
];
if (version === "1.18.1") {
  if (packets.length !== baselinePurposes.length) {
    throw new Error("Baseline packet explanation coverage has drifted.");
  }
  for (const packet of packets) {
    packet.purpose = baselinePurposes[Number(packet.id)];
    if (!packet.purpose) throw new Error("Missing packet explanation.");
  }
}
const items = data.itemsArray
  .map((item) => ({
    identifier: `minecraft:${item.name}`,
    registryId: item.id,
    displayName: item.displayName,
    stackSize: item.stackSize,
    ...(item.maxDurability === undefined
      ? {}
      : { maxDurability: item.maxDurability }),
  }))
  .sort((a, b) => a.identifier.localeCompare(b.identifier, "en"));
await mkdir(output, { recursive: true });
async function save(name, value) {
  const path = resolve(output, name);
  await writeFile(
    path,
    await format(JSON.stringify(value), {
      ...(await resolveConfig(path)),
      parser: "json",
    }),
  );
}
await save("items.json", { ...metadata, count: items.length, items });
await save("protocol.json", {
  ...metadata,
  direction: "serverbound",
  state: "play",
  count: packets.length,
  note: "Schemas are versioned wire formats, not permission grants or RLCraft action capabilities. Conditional fields retain their original switch/option definitions.",
  baselineModeReference:
    version === "1.18.1"
      ? {
          windowClick: {
            0: "pickup",
            1: "quick move",
            2: "hotbar/offhand swap",
            3: "creative clone",
            4: "throw",
            5: "quick craft drag",
            6: "pickup all",
          },
          blockDig: {
            0: "start digging",
            1: "cancel digging",
            2: "finish digging",
            3: "drop held stack",
            4: "drop one held item",
            5: "release item use",
            6: "swap hands",
          },
          entityAction: {
            0: "start sneaking",
            1: "stop sneaking",
            2: "leave bed",
            3: "start sprinting",
            4: "stop sprinting",
            5: "start horse jump",
            6: "stop horse jump",
            7: "open horse inventory",
            8: "start elytra flight",
          },
          useEntity: { 0: "interact", 1: "attack", 2: "interact at" },
          clientCommand: { 0: "request respawn", 1: "request statistics" },
        }
      : undefined,
  packets,
  serverboundTypes: types,
  commonTypes: data.protocol.types,
});
const readmePath = resolve(output, "README.md");
let readme;
try {
  readme = await readFile(readmePath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (readme !== undefined) {
  const start = "<!-- protocol-table:start -->";
  const end = "<!-- protocol-table:end -->";
  const startAt = readme.indexOf(start);
  const endAt = readme.indexOf(end);
  if (startAt < 0 || endAt <= startAt) {
    throw new Error("README protocol table markers are missing or invalid.");
  }
  const rows = packets.map(({ id, name, schema, purpose }) => {
    const fields =
      schema[0] === "container"
        ? schema[1].map((field) => `\`${field.name}\``).join(", ")
        : "See schema";
    return `| \`${id}\` | \`${name}\` | ${purpose ?? "See version schema."} | ${fields || "No fields"} |`;
  });
  const table = [
    "| ID | Packet | Meaning / owner | Fields (conditional fields included) |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  const updated =
    readme.slice(0, startAt + start.length) +
    `\n\n${table}\n\n` +
    readme.slice(endAt);
  await writeFile(
    readmePath,
    await format(updated, {
      ...(await resolveConfig(readmePath)),
      parser: "markdown",
    }),
  );
}
console.log(
  `Exported ${items.length} items and ${packets.length} outgoing PLAY packets for Java ${version} to ${output}.`,
);
