import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { format, resolveConfig } from "prettier";
import type { protocolCatalog } from "../packages/agents/src/inputs/catalog.js";

type Catalog = ReturnType<typeof protocolCatalog>;
const explanations: Record<string, string> = {
  "self.identity":
    "The agent's username, player UUID, connection-local entity ID, Minecraft version and protocol version. Entity IDs can change across sessions; they are not stable player identities.",
  "self.pose":
    "Client-held position and velocity vectors, camera/body/head angles, collision dimensions, eye height and ground/validity flags. These are the agent's local state, including received corrections and local physics estimates; they are not privileged reads of server position internals.",
  "self.vitals":
    "Health, hunger/food level, client-held saturation, air/oxygen and whether health is positive. There is no exact server exhaustion or hidden damage-state query.",
  "self.experience":
    "The current experience level, points and progress toward the next level, as exposed by the client adapter.",
  "self.effects":
    "Client-known active status effects and the agent entity's received metadata. Effect identifiers/duration/amplifier and metadata layout depend on the version and adapter.",
  "self.attributes":
    "Attribute entries sent for this agent entity, including whatever bases/modifiers are actually in those entries. The channel is unavailable before a self-attribute packet arrives; it does not invent unsent attributes.",
  "self.physics":
    "Local estimates of water/lava/web contact, horizontal/vertical collision, jump timers/queued jump, elytra state and firework boost duration, plus whether local physics is enabled. These are simulation bookkeeping rather than authoritative hidden server flags.",
  "self.controls":
    "The locally held forward/back/left/right/jump/sprint/sneak buttons. A held request does not prove the server allowed the resulting movement.",
  "self.inventory":
    "Every known player-inventory slot, the held stack, selected hotbar slot, equipment and item-use state. Item objects preserve available client-received item IDs, names/counts, NBT, durability and enchantments. Empty slots are represented explicitly; hidden inventories are not queried.",
  "self.digging":
    "The current local digging target, whether the adapter considers it diggable and estimated completion time in milliseconds. No target gives null feasibility/time; this is not a guaranteed server completion time.",
  "self.abilities":
    "The last received player-abilities flags and movement speed values. Flags describe server-granted abilities; receiving them does not grant the policy permission to change game mode.",
  "self.cooldowns":
    "Active item cooldown entries with item ID and ticks remaining, tracked from received durations against local client ticks. This is not a server-only melee attack-cooldown measurement.",
  "world.game":
    "Received dimension, game mode, difficulty, hardcore flag, world level type, maximum-player metadata and server brand. These are advertised connection/world facts, not unrestricted game-rule access.",
  "world.time":
    "Client world age/time, day/time-of-day, daylight-cycle indication and derived daylight/moon phase. Large counter representations are retained. These are Minecraft ticks, not training generation elapsed seconds.",
  "world.weather":
    "Client-known raining flag and rain/thunder intensity/state. This is the weather state delivered to this connection.",
  "world.spawn":
    "The received world spawn/compass target position. It is not a global list of beds or an unrestricted query of all players' respawn points.",
  "world.border":
    "The received initial border configuration plus latest center, size, interpolation and warning-distance/time updates. Updates remain packet-shaped; do not assume this is a freshly interpolated border model at each sample.",
  "world.blocks":
    "A configurable cube of client-cached blocks around the agent: positions, loaded flags, state/type/name/properties, block/sky light, biome, collision shapes, transparency, hardness, material, diggability and waterlogging. Occluded but received terrain is included; unloaded cells remain unknown rather than being treated as air.",
  "world.chunks":
    "Coordinates of chunk columns observed loading/unloading on this connection. This is coverage metadata, not an unrestricted full-world map. The raw chunk/light payloads are in the protocol channel.",
  "world.blockEntities":
    "Received block-entity updates/NBT, including chunk-associated entries. Only transmitted data is retained; chest contents are not learned by querying an unopened chest.",
  "world.maps":
    "Received map IDs and rolling patches, including their coordinates, colors/icons and sequence/context where sent. This does not silently reconstruct or substitute a complete map.",
  "entities.visible":
    "Nearby client-known entities that pass the adapter's approximate forward-facing center-point sight ray check, nearest-first and bounded by the entity limit. It is not a pixel segmentation result or exact camera-frustum/model-visibility test. Protected viewer entities are excluded.",
  "players.tab":
    "Player-list entries received by this connection: UUID/name, game mode, latency, display name and skin data where available, plus header/footer. Tab entries may include distant players; this is not their live position. Protected viewers are excluded.",
  "ui.window":
    "The actually open container/trading/workstation window: identifier/type/title, visible slots, player-inventory range, received numeric properties and latest trade packet. No open window produces null. Trade data is a cached received update, not an independent hidden-villager query.",
  "ui.scoreboards":
    "Received scoreboard objectives/items, display positions and teams. These are client-known UI structures, not access to every server scoreboard.",
  "ui.bossBars":
    "The currently retained boss-bar objects from create/update/delete events, including whatever title/progress/color/style/flags the adapter receives.",
  "ui.titles":
    "Latest received title, subtitle, timing and action-bar packets. This is message state, not rendered HUD pixels; rendering expiry and clear behavior require the protocol events or a real captured client.",
  "ui.combat":
    "Latest combat-enter, combat-end and death-notification packets. Notifications do not reveal hidden enemy intentions or the server's complete combat state.",
  "knowledge.recipes":
    "Actual server recipe declarations and latest recipe-book/unlock data. This is distinct from every theoretical recipe in the installed local registry.",
  "knowledge.advancements":
    "Accumulated received advancement definitions/progress and the selected tab update. Reset/removal updates are applied. Nothing asks the server for privileged advancement data.",
  "knowledge.statistics":
    "Accumulated statistic entries actually received, keyed by category/statistic in the collector. Usually requires a statistics request/UI interaction; unavailable before the server sends them.",
  "knowledge.commands":
    "The command tree accessible to this connection and latest completion response. Receiving a command suggestion is not proof the command may be executed in every context.",
  "knowledge.tags":
    "Server-sent registry tags, such as item/block group membership. Definitions depend on the version, server and datapacks.",
  "knowledge.resourcePack":
    "The server's received resource-pack offer, including transmitted URL/hash/prompt/requirement metadata. Offers are recorded; the collector does not automatically fetch offered URLs.",
  "events.sounds":
    "Rolling sound-event history: named/numeric/entity-attached sounds, stop commands and note/block/world events. Raw packet events preserve the transmitted fields; note and high-level events can overlap with packet events.",
  "events.particles":
    "Rolling received high-level particle events and their parameters. A particle event is not a vanilla-rendered particle image; raw protocol retains exact packet fields.",
  "events.entities":
    "Rolling spawn/removal/update, motion-adjacent, equipment/effect, hurt/death/animation, taming and item-collection events emitted by the adapter. High-frequency entityMoved fan-out is intentionally skipped; raw movement packets remain available separately.",
  "events.blocks":
    "Rolling block changes/block-entity updates, piston/chest animations, observed breaking and local digging completion/abort events. Block-targeted events describe only received/local client knowledge.",
  "events.messages":
    "Rolling messages delivered to this connection: chat, whispers, rich message objects, titles and action bars. It does not access private messages delivered only to other connections.",
  "events.inventory":
    "Rolling window-open/close/held-item events plus received set-slot, window-items, window-properties, trade and related inventory packets. Captures updates as well as sampled inventory state.",
  "events.lifecycle":
    "Rolling connection/login/spawn/respawn/death, health/air, sleep/wake, mount/dismount and other routed adapter events. Frequently emitted move/time/physics events are omitted from this history; state channels still expose current values.",
  "vision.geometry":
    "Native first-person ray projection: depth, block-state semantic IDs, entity IDs, valid mask and legend, with camera origin/angles, resolution, field of view and range. It uses received collision shapes and approximate entity bounds, not vanilla models/textures/lighting/particles/HUD rendering.",
  "vision.rgb":
    "Actual RGB bytes from the managed Fabric client's own first-person framebuffer, or an external rendered-client/camera producer. Fabric launch and capture are implemented; prepare clients and select the Fabric backend. Mineflayer does not launch a renderer and requires an external producer. Missing/stale frames remain unavailable.",
  "audio.pcm":
    "Real official vanilla Ogg samples decoded and mixed from received server-sound events. Stereo/distance/pitch mixing is approximate and sample choice is local. Pending/missing/late counters and active voice count expose playback limitations. Asset preparation is required.",
  "audio.capture":
    "Actual PCM audio supplied by an external running client's capture producer. This is the route for full client-generated music/ambience/footsteps and resource-pack audio. It is unavailable without a fresh producer; no microphone is read.",
  "protocol.packets":
    "Opt-in catch-all of every decoded incoming PLAY packet, with rolling events, counts per packet name and Minecraft definitions version. It includes packet fields without a structured adapter, but is bounded and excludes authentication/login-state exchanges.",
};

const packetMeanings: Record<string, string> = {
  spawn_entity: "Spawn a non-living/general entity.",
  spawn_entity_experience_orb: "Spawn an experience orb.",
  spawn_entity_living: "Spawn a living entity.",
  spawn_entity_painting: "Spawn a painting and its placement metadata.",
  named_entity_spawn: "Spawn a player entity.",
  sculk_vibration_signal: "Sculk vibration path/timing.",
  animation: "Entity animation such as arm swing.",
  statistics: "Statistic entries delivered to this player.",
  acknowledge_player_digging: "Server acknowledgment of digging/block action.",
  block_break_animation: "Block-breaking progress animation.",
  tile_entity_data: "Block-entity update/NBT.",
  block_action: "Block-specific animation/action parameters.",
  block_change: "Single block state change.",
  boss_bar: "Boss-bar creation/update/removal.",
  difficulty: "Advertised difficulty and lock state.",
  chat: "Chat/system/action message components.",
  clear_titles: "Clear/reset title presentation.",
  tab_complete: "Completion response for requested text.",
  declare_commands: "Accessible command tree.",
  close_window: "Server closes a menu.",
  window_items: "Window contents and cursor/revision data.",
  craft_progress_bar:
    "Numeric menu property (smelting, brewing, enchanting, etc.).",
  set_slot: "One inventory slot/cursor update.",
  set_cooldown: "Item cooldown duration.",
  custom_payload: "Server/plugin/mod channel payload.",
  named_sound_effect: "Sound event identified by name.",
  kick_disconnect: "Disconnect reason.",
  entity_status: "Entity status/behavior animation code.",
  explosion: "Explosion location, affected blocks and impulse data.",
  unload_chunk: "Client should forget a chunk.",
  game_state_change: "Game event/state change such as weather or game mode.",
  open_horse_window: "Open mount equipment/storage menu.",
  initialize_world_border: "Initial border dimensions/interpolation/warnings.",
  keep_alive: "Transport heartbeat request; adapter replies.",
  map_chunk: "Chunk sections, terrain and included block entities.",
  world_event: "World sound/visual event code and target.",
  world_particles: "Particle type, origin/spread and parameters.",
  update_light: "Chunk sky/block-light updates.",
  login: "PLAY join-world metadata; not authentication traffic.",
  map: "Map color patch/icon update.",
  trade_list: "Merchant offers and trading metadata.",
  rel_entity_move: "Relative entity displacement.",
  entity_move_look: "Relative entity displacement plus rotation.",
  entity_look: "Entity rotation update.",
  vehicle_move: "Server correction/update for controlled vehicle.",
  open_book: "Open held book UI.",
  open_window: "Open named/type-specific menu.",
  open_sign_entity: "Open sign text editor.",
  ping: "Transport ping; adapter returns pong.",
  craft_recipe_response: "Recipe-placement/ghost-recipe response.",
  abilities: "Granted player abilities and movement speeds.",
  end_combat_event: "Combat-end notification.",
  enter_combat_event: "Combat-start notification.",
  death_combat_event: "Death/combat message.",
  player_info: "Tab-list player entries/changes.",
  face_player: "Server asks player camera to face a target.",
  position: "Player position/orientation correction or teleport.",
  unlock_recipes: "Recipe-book state and recipe unlocks.",
  entity_destroy: "Remove entities from this client's world.",
  remove_entity_effect: "Remove an entity status effect.",
  resource_pack_send: "Resource-pack offer URL/hash/requirement/prompt.",
  respawn: "World/dimension/game-mode transition metadata.",
  entity_head_rotation: "Entity head yaw.",
  multi_block_change: "Batch block-state changes.",
  select_advancement_tab: "Selected advancement tab.",
  action_bar: "Action-bar message.",
  world_border_center: "Border center update.",
  world_border_lerp_size: "Border size transition.",
  world_border_size: "Border size update.",
  world_border_warning_delay: "Border warning time.",
  world_border_warning_reach: "Border warning distance.",
  camera: "Camera entity target (e.g. spectator).",
  held_item_slot: "Selected hotbar slot update.",
  update_view_position: "Chunk-view center.",
  update_view_distance: "Server view distance.",
  spawn_position: "World spawn/compass target.",
  scoreboard_display_objective: "Displayed scoreboard objective/position.",
  entity_metadata: "Versioned entity metadata fields.",
  attach_entity: "Entity attachment/leash relation.",
  entity_velocity: "Entity velocity update.",
  entity_equipment: "Visible entity equipment updates.",
  experience: "Player experience bar/level/total update.",
  update_health: "Player health, hunger and saturation.",
  scoreboard_objective: "Scoreboard objective create/update/delete.",
  set_passengers: "Entity vehicle/passenger relationships.",
  teams: "Team membership/presentation/rules delivered to client.",
  scoreboard_score: "Score entry update/removal.",
  simulation_distance: "Server simulation-distance advertisement.",
  set_title_subtitle: "Subtitle text.",
  update_time: "World age/time/daylight progression data.",
  set_title_text: "Title text.",
  set_title_time: "Title fade/stay timing.",
  entity_sound_effect: "Sound attached to an entity.",
  sound_effect: "Sound event identified by numeric registry ID.",
  stop_sound: "Stop specified sound/category playback.",
  playerlist_header: "Tab-list header/footer text.",
  nbt_query_response:
    "Response to an NBT debug query; permission-dependent, not an ordinary sensor.",
  collect: "Item/experience pickup animation/relationship.",
  entity_teleport: "Absolute entity position/rotation update.",
  advancements: "Advancement definitions, removals and progress.",
  entity_update_attributes: "Received entity attribute bases/modifiers.",
  entity_effect: "Entity status effect/amplifier/duration/flags.",
  declare_recipes: "Server recipe definitions.",
  tags: "Registry tag definitions.",
};

function eventRoute(name: string) {
  if (
    ["physicsTick", "physicTick", "move", "time", "entityMoved"].includes(name)
  )
    return "Not retained as a high-level event (state/raw packets are separate)";
  if (/sound|noteHeard/i.test(name)) return "events.sounds";
  if (/particle/i.test(name)) return "events.particles";
  if (/^(entity|playerCollect|itemDrop)/.test(name)) return "events.entities";
  if (/block|piston|chestLid|digging/i.test(name)) return "events.blocks";
  if (/chat|whisper|message|actionBar|title/i.test(name))
    return "events.messages";
  if (/window|heldItem/i.test(name)) return "events.inventory";
  return "events.lifecycle";
}

export async function exportInputReadme(catalog: Catalog) {
  const defaults = JSON.parse(
    await readFile(resolve("packages/core/src/input-defaults.json"), "utf8"),
  );
  const count = catalog.channels.length;
  const fields = catalog.channels.reduce((n, c) => n + c.fields.length, 0);
  const lines = [
    "# Minecraft agent inputs: complete human-readable reference",
    "",
    `This is the readable companion to [the full input JSON catalog](../agent-inputs.catalog.json), covering **${count} channels, ${fields} top-level field selectors, ${catalog.mineflayerEvents.length} adapter event names, and all ${catalog.clientboundPlayPackets.length} incoming PLAY packet types for Minecraft Java ${catalog.minecraftVersion}**. It lists what each input means, where it comes from, and its limitations. See the matching [player output reference](../player-outputs/README.md) for actions.`,
    "",
    "**Scope: player connection and client state only.** No server-only sensor, world-file access, hidden inventory lookup, exact server exhaustion query, or privileged attack-cooldown query. Client-known data includes received terrain/entity metadata and tab-list entries, which is broader than the pixels on the player's screen. Disable cache/protocol channels if an experiment should use only rendered perception.",
    "",
    "The lists below are generated from the same catalog/defaults as the implementation. Names and listed selectors are exact configuration keys. A listed field is not guaranteed to exist in every sample: it can be unsent, version-dependent or unavailable. Nested packet/NBT/item structures are variable; their full definitions remain in the JSON catalog.",
    "",
    "## Contents",
    "",
    "- [Availability and choosing inputs](#availability-and-choosing-inputs)",
    "- [Observation format and units](#observation-format-and-units)",
    "- [Every input channel and field](#every-input-channel-and-field)",
    "- [Nested data and media formats](#nested-data-and-media-formats)",
    "- [Sampling, limits and recording](#sampling-limits-and-recording)",
    "- [Complete adapter-event list](#complete-adapter-event-list)",
    "- [Complete incoming-packet list](#complete-incoming-packet-list)",
    "- [Coverage boundaries](#coverage-boundaries)",
    "- [Source files and regeneration](#source-files-and-regeneration)",
    "",
    "## Availability and choosing inputs",
    "",
    "| Input family | Availability by backend |",
    "| --- | --- |",
    "| Structured player/world/UI state | Implemented; requires applicable data to have arrived on this connection. |",
    "| Received events and raw PLAY packets | Implemented; enabled channels retain bounded rolling histories. |",
    "| Geometry depth/semantic vision | Implemented CPU ray projection, with documented approximation. |",
    "| Decoded server-sound PCM | Implemented; opt-in and needs prepared official audio assets. |",
    "| Exact rendered RGB | Managed Fabric framebuffer capture implemented; Mineflayer needs an external producer. |",
    "| Exact full client audio | Capture ingestion implemented; needs an external real client audio producer. |",
    "| Simulator | Small simulated state only; Minecraft/media channels unavailable. |",
    "| Alternative backend | Only the actual registered adapter's declared/implemented coverage applies. |",
    "",
    "Choose **New training run → Agent inputs** in the dashboard. Balanced, Minimal and All native + protocol are presets; individual channel toggles, field selection, intervals, limits and profile JSON remain editable. Select and prepare the **Fabric RGB** backend for automatic real game capture and a dashboard live camera; Mineflayer RGB and exact client audio need an external producer. Unselected channels/fields are absent from policy/trainer observations. New-run profiles are copied into immutable run configuration; editing defaults does not reconfigure an already instantiated agent.",
    "",
    'For fields, omission of `fields` means retain the provider\'s available data; `fields: []` retains no top-level fields. A selection such as `fields: ["health", "food"]` masks the top level. It does not select arbitrary nested paths or add a hidden query.',
    "",
    "```json",
    '{ "enabled": true, "intervalMs": 100, "fields": ["health", "food"] }',
    "```",
    "",
    'That is an entry for `channels["self.vitals"]`, not a complete profile. Full profiles also include `limits` and `record`; import/export the complete profile in the dashboard or edit [input-defaults.json](../../packages/core/src/input-defaults.json), then restart control to load changed defaults.',
    "",
    "## Observation format and units",
    "",
    "The policy and trainer receive `{ tick, inputs }`, where `inputs` has `schemaVersion`, epoch-millisecond `at`, training `tick`, monotonically increasing frame `sequence`, selected `channels`, and `diagnostics`. The runner's internal position/health/reward bookkeeping is not a second unmasked policy sensor.",
    "",
    "| Per-channel envelope field | Meaning |",
    "| --- | --- |",
    "| `status` | `ready`, `unavailable` or `error`; check before reading data. Current native collector reports collection failures as unavailable. |",
    "| `sampledAt` | Epoch milliseconds of collection; cached samples retain their earlier timestamp. |",
    "| `source` | Origin of the data: client-received, local state/simulation, geometry or external capture. |",
    "| `data` | Only selected provider fields; absent for unavailable data. Ready null can mean no open window/target. |",
    "| `reason` | Why data is unavailable/failed, when supplied. |",
    "| `durationMs` | Collection time in milliseconds, when supplied. |",
    "",
    "Positions/distances are Minecraft block coordinates; vector components are `x/y/z`. Native pose/camera angles follow Mineflayer radians, while raw protocol fields keep their original degree/packed-angle conventions. Native physics velocity is normally displacement per simulation tick. World ages, effect/cooldown durations and some UI timings use Minecraft ticks; `intervalMs`, frame/event timestamps and training durations use their explicitly named units. A training tick is not necessarily a Minecraft world tick.",
    "",
    'Large integers received as bigint become `{ type: "bigint", value: "decimal digits" }`; other protocol 64-bit encodings retain their decoded schema shape. Bytes/typed arrays use base64 wrappers; non-finite numbers are tagged rather than replaced by zero. Cycles/nesting limits are explicitly marked by serialization. Null/absence must not be treated as a known zero, empty hidden inventory or air block.',
    "",
    "## Every input channel and field",
    "",
    "Default switches/intervals below come from the editable default profile, not a promise about a particular existing run. `0 ms` means no interval throttling when sampled; histories remain bounded, and policies are still called on training steps.",
    "",
  ];
  for (const [index, channel] of catalog.channels.entries()) {
    const explanation = explanations[channel.id];
    if (!explanation)
      throw new Error(`Missing readable input explanation: ${channel.id}`);
    const setting = defaults.channels[channel.id];
    if (!setting) throw new Error(`Missing input default: ${channel.id}`);
    lines.push(
      `### ${index + 1}. ${channel.label} — \`${channel.id}\``,
      "",
      explanation,
      "",
      `**Source:** ${channel.source}. **Default:** ${setting.enabled ? "enabled" : "disabled"}; ${setting.intervalMs} ms sample interval.`,
      "",
      `**Every selectable top-level field:** ${channel.fields.map((f) => `\`${f}\``).join(", ")}.`,
      "",
    );
    if (channel.description)
      lines.push(`**Catalog coverage note:** ${channel.description}`, "");
  }
  lines.push(
    "## Nested data and media formats",
    "",
    "| Structure | Fields and interpretation |",
    "| --- | --- |",
    "| Inventory slot | Player slots are `{ slot, item }`; items preserve available adapter properties and received NBT. Container slots use that window's layout. A numeric item ID is version-specific. |",
    "| Known block | `position`, `loaded`, `stateId`, `type`, `name`, `properties`, `light`, `skyLight`, `biome`, `shapes`, `transparent`, `hardness`, `material`, `diggable`, `waterlogged`; unknown cell has position and `loaded: false`. |",
    "| Visible entity | Available `id`, `uuid`, `username`, `name`, `type`, `kind`, `entityType`, `displayName`, `position`, `velocity`, `yaw`, `pitch`, `headYaw`, `height`, `width`, `onGround`, `metadata`, `equipment`, `effects`, `attributes`, `health`, `isValid`. Unsent fields are omitted; ordinary players' exact health is not guaranteed. |",
    "| Tab player | Available `uuid`, `username`, `gamemode`, `ping`, `displayName`, `skinData`. Does not include an arbitrary distant-player position. |",
    "| Item cooldown | `item` and `ticksRemaining`; derived from received item cooldown and local client ticks. |",
    "| Map | `id`, rolling `patches`, and `coverage` explanation. Patch offsets matter; missing map regions are not filled with invented pixels. |",
    "| Event | `sequence`, epoch-ms `at`, `channel`, `name`, `data`. Sequence supports deduplicating overlapping non-consuming history reads. |",
    "| Geometry image | Row-major per-pixel `depth`, `stateIds`, `entityIds`, `valid`, plus `legend`, `origin`, `yaw`, `pitch`, `fov`, `distance`, `width`, `height`. Depth is ray distance in blocks, null for unknown terrain without a nearer entity; clear no-hit ray returns configured range. Block state ID -1 means no block hit (including entity hits); entity ID 0 means no entity hit. Validity distinguishes known rays from unknown terrain. |",
    '| RGB capture `frame` | `kind: "rgb"`, `encoding: "rgb8"`, increasing `sequence`, epoch-ms `capturedAt`, `width`, `height`, base64 `data`; exactly width × height × 3 row-major RGB bytes, up to 512×512 under current validation. |',
    '| Audio capture `frame` | `kind: "pcm"`, `encoding: "f32le"`, increasing `sequence`, epoch-ms `capturedAt`, `sampleRate`, `channels`, base64 `data`; finite interleaved float32 little-endian samples, 8,000–48,000 Hz, one or two channels, maximum one-second frame. |',
    '| Native server PCM | `sampleRate`, stereo `channels: 2`, `encoding: "f32le"`, base64 interleaved `data`, epoch-ms rolling-window `from`/`to`, `pending` loads, cumulative `missing`/`late` counters, current `voices`. |',
    "",
    "Captured frames become unavailable when older than two seconds. The receiver validates format/ownership/freshness, not whether the producer really filmed the correct camera: attach the producer to the same agent/session. External media ingestion is described, with endpoint/authentication/examples, in [the operational input guide](../agent-inputs.md#vision-and-audio-coverage).",
    "",
    "Native geometry does not reproduce entity models, textures, lighting, HUD, particles, non-collision decorations or all transparent surfaces. Native PCM uses actual vanilla samples, but does not reproduce full client music/ambience/locally generated footsteps, exact vanilla mixing or resource-pack overrides. Received sound events remain available even when a playback mapping/sample is missing. Prepare assets with `npm run inputs:prepare` or the dashboard asset button; this does not start a training server or modify worlds.",
    "",
    "## Sampling, limits and recording",
    "",
    "Channels are sampled on observation reads subject to their interval. Events retain finite histories; dashboard inspection does not consume policy events. `intervalMs` changes observation sampling, not Minecraft physics speed. A pause in training leaves the game server running.",
    "",
    "| Default limit | Value | Meaning |",
    "| --- | --- | --- |",
  );
  const limitMeanings: Record<string, string> = {
    eventCount: "Maximum retained event entries, shared across histories.",
    eventBytes: "Total retained event payload byte budget.",
    packetBytes: "Maximum individual serialized event/packet payload bytes.",
    eventWindowMs: "Rolling history retention in milliseconds.",
    blockRadius: "Radius of sampled block cube; (2r + 1)^3 cells.",
    entities: "Maximum visible entity entries.",
    visionWidth: "Geometry image width in pixels.",
    visionHeight: "Geometry image height in pixels.",
    visionDistance: "Geometry ray distance in blocks.",
    visionFov: "Geometry horizontal field of view in degrees.",
    audioSampleRate: "Native server-sound PCM samples per second.",
    audioWindowMs: "Native audio rolling window in milliseconds.",
  };
  for (const [key, value] of Object.entries(defaults.limits)) {
    if (!limitMeanings[key]) throw new Error(`Undocumented input limit ${key}`);
    lines.push(`| \`${key}\` | ${value} | ${limitMeanings[key]} |`);
  }
  lines.push(
    "",
    `Default \`record\` is **${defaults.record}**. Enable it to save selected before/after policy observations per agent step to downloadable \`inputs.jsonl\`; the optional Firebase archive includes the artifact. Serialized, awaited writes apply backpressure instead of accumulating unlimited pending output.`,
    "",
    "Diagnostics report `droppedEvents`, `droppedBytes` and retained `eventBytes`; the shared envelope also allows provider-specific `unloadedBlocks`. Oversize/overflow loss is reported; ordinary window expiration is retention, not a loss counter increment. Individual state caches, map patch histories and serialization nesting have further bounds documented in the provider. This is not an unlimited lossless packet recorder.",
    "",
    "## Complete adapter-event list",
    "",
    `All **${catalog.mineflayerEvents.length}** catalogued public event names are below. Routing mirrors the current native collector, including names deliberately skipped to avoid high-frequency fan-out. An event only appears if the installed adapter emits it, the routed channel is enabled and the retention budget permits it. Local error/connection events are not all server packets. Case-insensitive routing means names such as scoreboardTitleChanged route to the messages history; the table records actual routing.`,
    "",
    "| Event | Readable name | Current history route |",
    "| --- | --- | --- |",
  );
  for (const name of catalog.mineflayerEvents)
    lines.push(
      `| \`${name}\` | ${name.replace(/([a-z])([A-Z])/g, "$1 $2")} | ${eventRoute(name)} |`,
    );
  lines.push(
    "",
    "Raw inventory events are additionally added with `packet:` names for `set_slot`, `window_items`, `open_window`, `close_window`, `craft_progress_bar`, `trade_list` and `held_item_slot`. Sound packet histories additionally include `sound_effect`, `named_sound_effect`, `entity_sound_effect`, `stop_sound`, `world_event` and `block_action`. Multiple representations can describe the same server event; do not sum them as independent rewards.",
    "",
    "## Complete incoming-packet list",
    "",
    `All **${catalog.clientboundPlayPackets.length}** clientbound PLAY packet types for **Java ${catalog.minecraftVersion}** are below. The \`protocol.packets\` channel captures decoded fields for every received type, including those without a higher-level channel. The JSON catalog holds every nested packet schema, common type, switch/option and array definition; this table lists exact top-level fields and a readable purpose.`,
    "",
    "Packet availability is not permission to request hidden data. In particular, `nbt_query_response` is a permission-dependent debug response, not a normal-player sensor; the collector does not issue privileged NBT requests. `login` here is a PLAY packet containing world-join information, not an authentication exchange. Binary payloads remain encoded data requiring a version/plugin-aware decoder.",
    "",
    "| ID | Packet | What it tells the client | Top-level fields (conditional fields included) |",
    "| --- | --- | --- | --- |",
  );
  for (const packet of catalog.clientboundPlayPackets) {
    const name = String(packet.name);
    const meaning = packetMeanings[name];
    if (!meaning && catalog.minecraftVersion === "1.18.1")
      throw new Error(`Missing readable packet explanation ${name}`);
    const schema = packet.schema as [string, { name: string }[]];
    if (!schema) throw new Error(`Missing packet schema ${name}`);
    const packetFields =
      schema[0] === "container"
        ? schema[1].map((f) => `\`${f.name}\``).join(", ") || "No fields"
        : "See JSON schema";
    lines.push(
      `| \`${packet.id}\` | \`${name}\` | ${meaning ?? name.replaceAll("_", " ")} | ${packetFields} |`,
    );
  }
  lines.push(
    "",
    "## Coverage boundaries",
    "",
    "- Only information sent to this player's client, client-visible local state or declared local approximations is available. No exhaustive server world/entity knowledge exists here.",
    "- Terrain outside received chunks is unknown; occluded received terrain is known to a normal client cache. Geometry sight rays are approximate and do not impose a universal pixel-only restriction on other channels.",
    "- Unopened container contents, unsent statistics/attributes/recipes and other players' hidden inventories/health are not invented. Knowledge updates can arrive later than the corresponding action.",
    "- Raw protocol can include server-supplied plugin/custom/UI data not yet understood by structured channels. This does not imply the policy should be permitted to execute arbitrary plugin commands.",
    "- Vanilla has no built-in microphone/voice-chat input. Mods adding voice chat need an explicit supported capture/channel extension; no microphone recording occurs in the current system.",
    "- Exact full renderer/audio output needs a real matching client. Capture endpoints alone do not supply pixels or full audio.",
    "- Channel defaults and field masks are configurable. Metadata limitations, finite history, encoding, freshness and version constraints remain part of the input definition.",
    "- Protected viewers are filtered from high-level entity/player paths where implemented. Raw packet capture is still what the server sends; rely on server-side viewer hiding rather than assuming the catch-all applies a universal semantic redaction.",
    "- Other Minecraft versions, datapacks, plugins and mods can introduce new packet formats/content. Update the registry/decoder and review the adapter; a baseline list is not a universal cross-version guarantee.",
    "",
    "## Source files and regeneration",
    "",
    "| Source | Purpose |",
    "| --- | --- |",
    "| [input-catalog.json](../../packages/core/src/input-catalog.json) | Authoritative channel identifiers, labels, selectors and coverage notes. |",
    "| [input-defaults.json](../../packages/core/src/input-defaults.json) | Editable default switches, intervals, limits and recording. |",
    "| [shared input types](../../packages/core/src/inputs.ts) | Observation/channel/capture envelopes. |",
    "| [native collector](../../packages/agents/src/inputs/minecraft.ts) | Actual state reads, event routing, filtering and cache behavior. |",
    "| [vision provider](../../packages/agents/src/inputs/vision.ts) | Geometry and visible-entity approximations. |",
    "| [sound provider](../../packages/agents/src/inputs/sound.ts) | Native decoded sound playback and missing/pending handling. |",
    "| [full JSON catalog](../agent-inputs.catalog.json) | All channels, events, packet schemas and shared protocol types. |",
    "| [operational guide](../agent-inputs.md) | Dashboard controls, capture API, assets, recording and verification. |",
    "| [backend guide](../agent-backends.md) | Swapping adapters without changing policy input envelopes. |",
    "",
    "Run `npm run inputs:catalog` from the project root to regenerate **both** the full JSON catalog and this README using the configured Minecraft version and current channel/default data. This README is generated; change catalog/defaults or explanatory text in [export-input-readme.ts](../../scripts/export-input-readme.ts), then regenerate. New channel IDs fail generation until a readable explanation is supplied. Version changes still require reviewing mechanics, producer compatibility and coverage; regeneration does not implement new sensors.",
    "",
  );
  const output = resolve("docs/agent-inputs/README.md");
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(
    output,
    await format(lines.join("\n"), {
      ...(await resolveConfig(output)),
      parser: "markdown",
    }),
  );
  console.log(`Exported ${output}`);
}
