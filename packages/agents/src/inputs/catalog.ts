import minecraftData from "minecraft-data";
import { inputCatalog } from "@rlcraft/core";
import botEvents from "../../../core/src/bot-events.json" with { type: "json" };
export function protocolCatalog(version: string) {
  const data = minecraftData(version);
  if (!data) throw new Error("Unsupported Minecraft data version");
  const types = (data.protocol as any).play.toClient.types;
  const packet = types.packet,
    names = packet[1].find((entry: any) => entry.name === "name").type[1]
      .mappings;
  return {
    ...inputCatalog,
    minecraftVersion: version,
    mineflayerEvents: botEvents,
    clientboundPlayPackets: Object.entries(names).map(([id, name]) => ({
      id,
      name,
      schema: types[`packet_${name}`],
    })),
    protocolTypes: types,
    commonProtocolTypes: (data.protocol as any).types,
    mediaFormats: {
      rgb: {
        encoding: "rgb8",
        layout: "row-major RGB",
        maxWidth: 512,
        maxHeight: 512,
      },
      pcm: {
        encoding: "f32le",
        layout: "interleaved float32 little endian",
        sampleRates: [8000, 48000],
        channels: [1, 2],
      },
    },
    limitations: [
      "No server-only data or world-file access",
      "Protocol capture is opt-in and bounded; losses are reported",
      "Depth and semantic geometry are native; exact RGB requires a rendered client producer",
      "Server-sound PCM omits client-generated ambience and resource-pack overrides; exact audio requires a client capture producer",
      "Events are retained in a finite rolling window and carry sequence numbers",
      "Unsent statistics, unopened container inventory and unloaded terrain are unavailable",
    ],
  };
}
