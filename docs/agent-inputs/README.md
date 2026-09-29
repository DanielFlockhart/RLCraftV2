# Minecraft agent inputs: complete human-readable reference

This is the readable companion to [the full input JSON catalog](../agent-inputs.catalog.json), covering **46 channels, 153 top-level field selectors, 94 adapter event names, and all 104 incoming PLAY packet types for Minecraft Java 1.18.1**. It lists what each input means, where it comes from, and its limitations. See the matching [player output reference](../player-outputs/README.md) for actions.

**Scope: player connection and client state only.** No server-only sensor, world-file access, hidden inventory lookup, exact server exhaustion query, or privileged attack-cooldown query. Client-known data includes received terrain/entity metadata and tab-list entries, which is broader than the pixels on the player's screen. Disable cache/protocol channels if an experiment should use only rendered perception.

The lists below are generated from the same catalog/defaults as the implementation. Names and listed selectors are exact configuration keys. A listed field is not guaranteed to exist in every sample: it can be unsent, version-dependent or unavailable. Nested packet/NBT/item structures are variable; their full definitions remain in the JSON catalog.

## Contents

- [Availability and choosing inputs](#availability-and-choosing-inputs)
- [Observation format and units](#observation-format-and-units)
- [Every input channel and field](#every-input-channel-and-field)
- [Nested data and media formats](#nested-data-and-media-formats)
- [Sampling, limits and recording](#sampling-limits-and-recording)
- [Complete adapter-event list](#complete-adapter-event-list)
- [Complete incoming-packet list](#complete-incoming-packet-list)
- [Coverage boundaries](#coverage-boundaries)
- [Source files and regeneration](#source-files-and-regeneration)

## Availability and choosing inputs

| Input family                         | Availability by backend                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Structured player/world/UI state     | Implemented; requires applicable data to have arrived on this connection.              |
| Received events and raw PLAY packets | Implemented; enabled channels retain bounded rolling histories.                        |
| Geometry depth/semantic vision       | Implemented CPU ray projection, with documented approximation.                         |
| Decoded server-sound PCM             | Implemented; opt-in and needs prepared official audio assets.                          |
| Exact rendered RGB                   | Managed Fabric framebuffer capture implemented; Mineflayer needs an external producer. |
| Exact full client audio              | Capture ingestion implemented; needs an external real client audio producer.           |
| Simulator                            | Small simulated state only; Minecraft/media channels unavailable.                      |
| Alternative backend                  | Only the actual registered adapter's declared/implemented coverage applies.            |

Choose **New training run → Agent inputs** in the dashboard. Balanced, Minimal and All native + protocol are presets; individual channel toggles, field selection, intervals, limits and profile JSON remain editable. Select and prepare the **Fabric RGB** backend for automatic real game capture and a dashboard live camera; Mineflayer RGB and exact client audio need an external producer. Unselected channels/fields are absent from policy/trainer observations. New-run profiles are copied into immutable run configuration; editing defaults does not reconfigure an already instantiated agent.

For fields, omission of `fields` means retain the provider's available data; `fields: []` retains no top-level fields. A selection such as `fields: ["health", "food"]` masks the top level. It does not select arbitrary nested paths or add a hidden query.

```json
{ "enabled": true, "intervalMs": 100, "fields": ["health", "food"] }
```

That is an entry for `channels["self.vitals"]`, not a complete profile. Full profiles also include `limits` and `record`; import/export the complete profile in the dashboard or edit [input-defaults.json](../../packages/core/src/input-defaults.json), then restart control to load changed defaults.

## Observation format and units

The policy and trainer receive `{ tick, inputs }`, where `inputs` has `schemaVersion`, epoch-millisecond `at`, training `tick`, monotonically increasing frame `sequence`, selected `channels`, and `diagnostics`. The runner's internal position/health/reward bookkeeping is not a second unmasked policy sensor.

| Per-channel envelope field | Meaning                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `status`                   | `ready`, `unavailable` or `error`; check before reading data. Current native collector reports collection failures as unavailable. |
| `sampledAt`                | Epoch milliseconds of collection; cached samples retain their earlier timestamp.                                                   |
| `source`                   | Origin of the data: client-received, local state/simulation, geometry or external capture.                                         |
| `data`                     | Only selected provider fields; absent for unavailable data. Ready null can mean no open window/target.                             |
| `reason`                   | Why data is unavailable/failed, when supplied.                                                                                     |
| `durationMs`               | Collection time in milliseconds, when supplied.                                                                                    |

Positions/distances are Minecraft block coordinates; vector components are `x/y/z`. Native pose/camera angles follow Mineflayer radians, while raw protocol fields keep their original degree/packed-angle conventions. Native physics velocity is normally displacement per simulation tick. World ages, effect/cooldown durations and some UI timings use Minecraft ticks; `intervalMs`, frame/event timestamps and training durations use their explicitly named units. A training tick is not necessarily a Minecraft world tick.

Large integers received as bigint become `{ type: "bigint", value: "decimal digits" }`; other protocol 64-bit encodings retain their decoded schema shape. Bytes/typed arrays use base64 wrappers; non-finite numbers are tagged rather than replaced by zero. Cycles/nesting limits are explicitly marked by serialization. Null/absence must not be treated as a known zero, empty hidden inventory or air block.

## Every input channel and field

Default switches/intervals below come from the editable default profile, not a promise about a particular existing run. `0 ms` means no interval throttling when sampled; histories remain bounded, and policies are still called on training steps.

### 1. Identity — `self.identity`

The agent's username, player UUID, connection-local entity ID, Minecraft version and protocol version. Entity IDs can change across sessions; they are not stable player identities.

**Source:** client state. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `username`, `uuid`, `id`, `version`, `protocolVersion`.

### 2. Position and orientation — `self.pose`

Client-held position and velocity vectors, camera/body/head angles, collision dimensions, eye height and ground/validity flags. These are the agent's local state, including received corrections and local physics estimates; they are not privileged reads of server position internals.

**Source:** client state. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `position`, `velocity`, `yaw`, `pitch`, `headYaw`, `height`, `width`, `eyeHeight`, `onGround`, `isValid`.

### 3. Health and hunger — `self.vitals`

Health, hunger/food level, client-held saturation, air/oxygen and whether health is positive. There is no exact server exhaustion or hidden damage-state query.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `health`, `food`, `saturation`, `oxygen`, `alive`.

**Catalog coverage note:** Saturation and oxygen are client-held values; no server exhaustion or hidden damage state.

### 4. Experience — `self.experience`

The current experience level, points and progress toward the next level, as exposed by the client adapter.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `level`, `points`, `progress`.

### 5. Active effects — `self.effects`

Client-known active status effects and the agent entity's received metadata. Effect identifiers/duration/amplifier and metadata layout depend on the version and adapter.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `effects`, `metadata`.

### 6. Attributes — `self.attributes`

Attribute entries sent for this agent entity, including whatever bases/modifiers are actually in those entries. The channel is unavailable before a self-attribute packet arrives; it does not invent unsent attributes.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `attributes`.

**Catalog coverage note:** Only attributes received by this connection; unknown values are not inferred.

### 7. Locally simulated movement — `self.physics`

Local estimates of water/lava/web contact, horizontal/vertical collision, jump timers/queued jump, elytra state and firework boost duration, plus whether local physics is enabled. These are simulation bookkeeping rather than authoritative hidden server flags.

**Source:** local simulation. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `isInWater`, `isInLava`, `isInWeb`, `isCollidedHorizontally`, `isCollidedVertically`, `jumpTicks`, `jumpQueued`, `elytraFlying`, `fireworkRocketDuration`, `physicsEnabled`.

**Catalog coverage note:** Client physics estimates, not authoritative server internals.

### 8. Current controls — `self.controls`

The locally held forward/back/left/right/jump/sprint/sneak buttons. A held request does not prove the server allowed the resulting movement.

**Source:** local state. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `forward`, `back`, `left`, `right`, `jump`, `sprint`, `sneak`.

### 9. Inventory and equipment — `self.inventory`

Every known player-inventory slot, the held stack, selected hotbar slot, equipment and item-use state. Item objects preserve available client-received item IDs, names/counts, NBT, durability and enchantments. Empty slots are represented explicitly; hidden inventories are not queried.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `slots`, `heldItem`, `quickBarSlot`, `equipment`, `usingHeldItem`.

**Catalog coverage note:** Slot indices use Minecraft window coordinates; item details include client-received NBT, durability and enchantments.

### 10. Digging state and target — `self.digging`

The current local digging target, whether the adapter considers it diggable and estimated completion time in milliseconds. No target gives null feasibility/time; this is not a guaranteed server completion time.

**Source:** local state. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `target`, `canDig`, `estimatedMs`.

### 11. Player abilities — `self.abilities`

The last received player-abilities flags and movement speed values. Flags describe server-granted abilities; receiving them does not grant the policy permission to change game mode.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `flags`, `flyingSpeed`, `walkingSpeed`.

### 12. Item cooldowns — `self.cooldowns`

Active item cooldown entries with item ID and ticks remaining, tracked from received durations against local client ticks. This is not a server-only melee attack-cooldown measurement.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `items`.

**Catalog coverage note:** Packet durations tracked against actual client world ticks; never server-only attack cooldown.

### 13. World and connection — `world.game`

Received dimension, game mode, difficulty, hardcore flag, world level type, maximum-player metadata and server brand. These are advertised connection/world facts, not unrestricted game-rule access.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `dimension`, `gameMode`, `difficulty`, `hardcore`, `levelType`, `maxPlayers`, `serverBrand`.

### 14. World time — `world.time`

Client world age/time, day/time-of-day, daylight-cycle indication and derived daylight/moon phase. Large counter representations are retained. These are Minecraft ticks, not training generation elapsed seconds.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `age`, `time`, `timeOfDay`, `day`, `isDay`, `moonPhase`, `doDaylightCycle`, `bigAge`, `bigTime`.

### 15. Weather — `world.weather`

Client-known raining flag and rain/thunder intensity/state. This is the weather state delivered to this connection.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `raining`, `rainState`, `thunderState`.

### 16. Spawn and compass target — `world.spawn`

The received world spawn/compass target position. It is not a global list of beds or an unrestricted query of all players' respawn points.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `position`.

### 17. World border — `world.border`

The received initial border configuration plus latest center, size, interpolation and warning-distance/time updates. Updates remain packet-shaped; do not assume this is a freshly interpolated border model at each sample.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `initialize`, `center`, `size`, `lerp`, `warningDistance`, `warningTime`.

### 18. Nearby client-known blocks — `world.blocks`

A configurable cube of client-cached blocks around the agent: positions, loaded flags, state/type/name/properties, block/sky light, biome, collision shapes, transparency, hardness, material, diggability and waterlogging. Occluded but received terrain is included; unloaded cells remain unknown rather than being treated as air.

**Source:** client world cache. **Default:** enabled; 500 ms sample interval.

**Every selectable top-level field:** `blocks`, `unknownCount`, `radius`.

**Catalog coverage note:** Includes occluded but client-received terrain, as a normal client cache does. Unloaded cells are unknown. No world files are read.

### 19. Loaded chunk coverage — `world.chunks`

Coordinates of chunk columns observed loading/unloading on this connection. This is coverage metadata, not an unrestricted full-world map. The raw chunk/light payloads are in the protocol channel.

**Source:** client world cache. **Default:** enabled; 1000 ms sample interval.

**Every selectable top-level field:** `columns`.

**Catalog coverage note:** Coverage metadata only. Full incoming chunk payloads are available through protocol.packets.

### 20. Client-known block entity updates — `world.blockEntities`

Received block-entity updates/NBT, including chunk-associated entries. Only transmitted data is retained; chest contents are not learned by querying an unopened chest.

**Source:** client-received. **Default:** enabled; 500 ms sample interval.

**Every selectable top-level field:** `entries`.

**Catalog coverage note:** Only server-sent NBT; unopened container inventories are not queried.

### 21. Received map pixels and icons — `world.maps`

Received map IDs and rolling patches, including their coordinates, colors/icons and sequence/context where sent. This does not silently reconstruct or substitute a complete map.

**Source:** client-received. **Default:** enabled; 500 ms sample interval.

**Every selectable top-level field:** `maps`.

**Catalog coverage note:** Map patches retain their x/y offsets and sequence; never silently substitute a complete map.

### 22. Line-of-sight entities — `entities.visible`

Nearby client-known entities that pass the adapter's approximate forward-facing center-point sight ray check, nearest-first and bounded by the entity limit. It is not a pixel segmentation result or exact camera-frustum/model-visibility test. Protected viewer entities are excluded.

**Source:** visible geometry. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `entities`.

**Catalog coverage note:** Only client-received entities with unobstructed sampled sight rays; entity geometry is approximate and marked.

### 23. Player list — `players.tab`

Player-list entries received by this connection: UUID/name, game mode, latency, display name and skin data where available, plus header/footer. Tab entries may include distant players; this is not their live position. Protected viewers are excluded.

**Source:** client-received. **Default:** enabled; 500 ms sample interval.

**Every selectable top-level field:** `players`, `header`, `footer`.

**Catalog coverage note:** Tab-list data delivered by the server. Protected viewer players are excluded.

### 24. Open container or trading window — `ui.window`

The actually open container/trading/workstation window: identifier/type/title, visible slots, player-inventory range, received numeric properties and latest trade packet. No open window produces null. Trade data is a cached received update, not an independent hidden-villager query.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `id`, `type`, `title`, `slots`, `inventoryStart`, `inventoryEnd`, `properties`, `trades`.

**Catalog coverage note:** Only windows actually opened by this agent.

### 25. Scoreboards — `ui.scoreboards`

Received scoreboard objectives/items, display positions and teams. These are client-known UI structures, not access to every server scoreboard.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `objectives`, `positions`, `teams`.

### 26. Boss bars — `ui.bossBars`

The currently retained boss-bar objects from create/update/delete events, including whatever title/progress/color/style/flags the adapter receives.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `bars`.

### 27. Titles and action bars — `ui.titles`

Latest received title, subtitle, timing and action-bar packets. This is message state, not rendered HUD pixels; rendering expiry and clear behavior require the protocol events or a real captured client.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `title`, `subtitle`, `timing`, `actionBar`.

### 28. Combat and death notifications — `ui.combat`

Latest combat-enter, combat-end and death-notification packets. Notifications do not reveal hidden enemy intentions or the server's complete combat state.

**Source:** client-received. **Default:** enabled; 100 ms sample interval.

**Every selectable top-level field:** `enter`, `end`, `death`.

### 29. Recipes and recipe book — `knowledge.recipes`

Actual server recipe declarations and latest recipe-book/unlock data. This is distinct from every theoretical recipe in the installed local registry.

**Source:** client-received. **Default:** enabled; 1000 ms sample interval.

**Every selectable top-level field:** `declarations`, `book`.

**Catalog coverage note:** Use actual server declarations and unlocks, not all theoretical crafting recipes.

### 30. Advancement definitions and progress — `knowledge.advancements`

Accumulated received advancement definitions/progress and the selected tab update. Reset/removal updates are applied. Nothing asks the server for privileged advancement data.

**Source:** client-received. **Default:** enabled; 1000 ms sample interval.

**Every selectable top-level field:** `updates`, `selectedTab`.

**Catalog coverage note:** Only data sent to the client; this does not request privileged advancement state.

### 31. Statistics — `knowledge.statistics`

Accumulated statistic entries actually received, keyed by category/statistic in the collector. Usually requires a statistics request/UI interaction; unavailable before the server sends them.

**Source:** client-received. **Default:** enabled; 1000 ms sample interval.

**Every selectable top-level field:** `values`.

**Catalog coverage note:** Available when the server sends statistics, normally on opening that UI. No privileged queries.

### 32. Command suggestions — `knowledge.commands`

The command tree accessible to this connection and latest completion response. Receiving a command suggestion is not proof the command may be executed in every context.

**Source:** client-received. **Default:** enabled; 1000 ms sample interval.

**Every selectable top-level field:** `tree`, `suggestions`.

**Catalog coverage note:** Server-provided accessible command tree and tab-completion responses only.

### 33. Registry tags — `knowledge.tags`

Server-sent registry tags, such as item/block group membership. Definitions depend on the version, server and datapacks.

**Source:** client-received. **Default:** enabled; 1000 ms sample interval.

**Every selectable top-level field:** `tags`.

### 34. Resource pack offer — `knowledge.resourcePack`

The server's received resource-pack offer, including transmitted URL/hash/prompt/requirement metadata. Offers are recorded; the collector does not automatically fetch offered URLs.

**Source:** client-received. **Default:** enabled; 1000 ms sample interval.

**Every selectable top-level field:** `offer`.

**Catalog coverage note:** Offers are recorded; untrusted URLs are never fetched automatically.

### 35. Heard sound events — `events.sounds`

Rolling sound-event history: named/numeric/entity-attached sounds, stop commands and note/block/world events. Raw packet events preserve the transmitted fields; note and high-level events can overlap with packet events.

**Source:** client-received events. **Default:** enabled; 0 ms sample interval.

**Every selectable top-level field:** `events`.

**Catalog coverage note:** Includes named, numeric, entity-attached, note/block/world sounds and stop commands. Raw protocol preserves exact fields.

### 36. Visible particle events — `events.particles`

Rolling received high-level particle events and their parameters. A particle event is not a vanilla-rendered particle image; raw protocol retains exact packet fields.

**Source:** client-received events. **Default:** enabled; 0 ms sample interval.

**Every selectable top-level field:** `events`.

### 37. Entity and combat events — `events.entities`

Rolling spawn/removal/update, motion-adjacent, equipment/effect, hurt/death/animation, taming and item-collection events emitted by the adapter. High-frequency entityMoved fan-out is intentionally skipped; raw movement packets remain available separately.

**Source:** client-received events. **Default:** enabled; 0 ms sample interval.

**Every selectable top-level field:** `events`.

### 38. Block changes and animations — `events.blocks`

Rolling block changes/block-entity updates, piston/chest animations, observed breaking and local digging completion/abort events. Block-targeted events describe only received/local client knowledge.

**Source:** client-received events. **Default:** enabled; 0 ms sample interval.

**Every selectable top-level field:** `events`.

### 39. Chat and UI messages — `events.messages`

Rolling messages delivered to this connection: chat, whispers, rich message objects, titles and action bars. It does not access private messages delivered only to other connections.

**Source:** client-received events. **Default:** enabled; 0 ms sample interval.

**Every selectable top-level field:** `events`.

**Catalog coverage note:** Includes messages addressed to this connection and action bars.

### 40. Inventory and window events — `events.inventory`

Rolling window-open/close/held-item events plus received set-slot, window-items, window-properties, trade and related inventory packets. Captures updates as well as sampled inventory state.

**Source:** client-received events. **Default:** enabled; 0 ms sample interval.

**Every selectable top-level field:** `events`.

### 41. Connection, movement and lifecycle — `events.lifecycle`

Rolling connection/login/spawn/respawn/death, health/air, sleep/wake, mount/dismount and other routed adapter events. Frequently emitted move/time/physics events are omitted from this history; state channels still expose current values.

**Source:** client/local events. **Default:** enabled; 0 ms sample interval.

**Every selectable top-level field:** `events`.

### 42. First-person depth and semantic image — `vision.geometry`

Native first-person ray projection: depth, block-state semantic IDs, entity IDs, valid mask and legend, with camera origin/angles, resolution, field of view and range. It uses received collision shapes and approximate entity bounds, not vanilla models/textures/lighting/particles/HUD rendering.

**Source:** geometry projection. **Default:** enabled; 500 ms sample interval.

**Every selectable top-level field:** `width`, `height`, `fov`, `distance`, `origin`, `yaw`, `pitch`, `depth`, `stateIds`, `entityIds`, `valid`, `legend`.

**Catalog coverage note:** CPU projection from received collision shapes and entity bounds. Not a vanilla RGB screenshot; transparent surfaces and non-collision decorations are approximate.

### 43. Rendered RGB capture — `vision.rgb`

Actual RGB bytes from the managed Fabric client's own first-person framebuffer, or an external rendered-client/camera producer. Fabric launch and capture are implemented; prepare clients and select the Fabric backend. Mineflayer does not launch a renderer and requires an external producer. Missing/stale frames remain unavailable.

**Source:** rendered client capture. **Default:** disabled; 100 ms sample interval.

**Every selectable top-level field:** `frame`.

**Catalog coverage note:** Actual first-person pixels from the managed Fabric client framebuffer, or an authenticated external producer for other backends. Mineflayer does not launch a renderer itself.

### 44. Decoded server-sound PCM — `audio.pcm`

Real official vanilla Ogg samples decoded and mixed from received server-sound events. Stereo/distance/pitch mixing is approximate and sample choice is local. Pending/missing/late counters and active voice count expose playback limitations. Asset preparation is required.

**Source:** server-sound playback. **Default:** disabled; 100 ms sample interval.

**Every selectable top-level field:** `sampleRate`, `channels`, `encoding`, `data`, `from`, `to`, `pending`, `missing`, `late`, `voices`.

**Catalog coverage note:** Actual vanilla Ogg samples mixed from received sound events. Omits client-only ambience/music/footsteps generated locally and resource-pack overrides; use audio.capture for exact client output.

### 45. Actual rendered client audio — `audio.capture`

Actual PCM audio supplied by an external running client's capture producer. This is the route for full client-generated music/ambience/footsteps and resource-pack audio. It is unavailable without a fresh producer; no microphone is read.

**Source:** external client capture. **Default:** disabled; 100 ms sample interval.

**Every selectable top-level field:** `frame`.

**Catalog coverage note:** PCM from a real client audio producer; unavailable until fresh frames are supplied.

### 46. Every incoming PLAY packet — `protocol.packets`

Opt-in catch-all of every decoded incoming PLAY packet, with rolling events, counts per packet name and Minecraft definitions version. It includes packet fields without a structured adapter, but is bounded and excludes authentication/login-state exchanges.

**Source:** client protocol. **Default:** disabled; 0 ms sample interval.

**Every selectable top-level field:** `events`, `counts`, `definitionsVersion`.

**Catalog coverage note:** Opt-in high-volume catch-all. Preserves all decoded PLAY fields, byte arrays as base64, 64-bit values as tagged integers. Excludes login/auth traffic; bounded loss is explicitly reported.

## Nested data and media formats

| Structure             | Fields and interpretation                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory slot        | Player slots are `{ slot, item }`; items preserve available adapter properties and received NBT. Container slots use that window's layout. A numeric item ID is version-specific.                                                                                                                                                                                                                                                  |
| Known block           | `position`, `loaded`, `stateId`, `type`, `name`, `properties`, `light`, `skyLight`, `biome`, `shapes`, `transparent`, `hardness`, `material`, `diggable`, `waterlogged`; unknown cell has position and `loaded: false`.                                                                                                                                                                                                            |
| Visible entity        | Available `id`, `uuid`, `username`, `name`, `type`, `kind`, `entityType`, `displayName`, `position`, `velocity`, `yaw`, `pitch`, `headYaw`, `height`, `width`, `onGround`, `metadata`, `equipment`, `effects`, `attributes`, `health`, `isValid`. Unsent fields are omitted; ordinary players' exact health is not guaranteed.                                                                                                     |
| Tab player            | Available `uuid`, `username`, `gamemode`, `ping`, `displayName`, `skinData`. Does not include an arbitrary distant-player position.                                                                                                                                                                                                                                                                                                |
| Item cooldown         | `item` and `ticksRemaining`; derived from received item cooldown and local client ticks.                                                                                                                                                                                                                                                                                                                                           |
| Map                   | `id`, rolling `patches`, and `coverage` explanation. Patch offsets matter; missing map regions are not filled with invented pixels.                                                                                                                                                                                                                                                                                                |
| Event                 | `sequence`, epoch-ms `at`, `channel`, `name`, `data`. Sequence supports deduplicating overlapping non-consuming history reads.                                                                                                                                                                                                                                                                                                     |
| Geometry image        | Row-major per-pixel `depth`, `stateIds`, `entityIds`, `valid`, plus `legend`, `origin`, `yaw`, `pitch`, `fov`, `distance`, `width`, `height`. Depth is ray distance in blocks, null for unknown terrain without a nearer entity; clear no-hit ray returns configured range. Block state ID -1 means no block hit (including entity hits); entity ID 0 means no entity hit. Validity distinguishes known rays from unknown terrain. |
| RGB capture `frame`   | `kind: "rgb"`, `encoding: "rgb8"`, increasing `sequence`, epoch-ms `capturedAt`, `width`, `height`, base64 `data`; exactly width × height × 3 row-major RGB bytes, up to 512×512 under current validation.                                                                                                                                                                                                                         |
| Audio capture `frame` | `kind: "pcm"`, `encoding: "f32le"`, increasing `sequence`, epoch-ms `capturedAt`, `sampleRate`, `channels`, base64 `data`; finite interleaved float32 little-endian samples, 8,000–48,000 Hz, one or two channels, maximum one-second frame.                                                                                                                                                                                       |
| Native server PCM     | `sampleRate`, stereo `channels: 2`, `encoding: "f32le"`, base64 interleaved `data`, epoch-ms rolling-window `from`/`to`, `pending` loads, cumulative `missing`/`late` counters, current `voices`.                                                                                                                                                                                                                                  |

Captured frames become unavailable when older than two seconds. The receiver validates format/ownership/freshness, not whether the producer really filmed the correct camera: attach the producer to the same agent/session. External media ingestion is described, with endpoint/authentication/examples, in [the operational input guide](../agent-inputs.md#vision-and-audio-coverage).

Native geometry does not reproduce entity models, textures, lighting, HUD, particles, non-collision decorations or all transparent surfaces. Native PCM uses actual vanilla samples, but does not reproduce full client music/ambience/locally generated footsteps, exact vanilla mixing or resource-pack overrides. Received sound events remain available even when a playback mapping/sample is missing. Prepare assets with `npm run inputs:prepare` or the dashboard asset button; this does not start a training server or modify worlds.

## Sampling, limits and recording

Channels are sampled on observation reads subject to their interval. Events retain finite histories; dashboard inspection does not consume policy events. `intervalMs` changes observation sampling, not Minecraft physics speed. A pause in training leaves the game server running.

| Default limit     | Value   | Meaning                                                   |
| ----------------- | ------- | --------------------------------------------------------- |
| `eventCount`      | 512     | Maximum retained event entries, shared across histories.  |
| `eventBytes`      | 2097152 | Total retained event payload byte budget.                 |
| `packetBytes`     | 1048576 | Maximum individual serialized event/packet payload bytes. |
| `eventWindowMs`   | 5000    | Rolling history retention in milliseconds.                |
| `blockRadius`     | 2       | Radius of sampled block cube; (2r + 1)^3 cells.           |
| `entities`        | 64      | Maximum visible entity entries.                           |
| `visionWidth`     | 32      | Geometry image width in pixels.                           |
| `visionHeight`    | 24      | Geometry image height in pixels.                          |
| `visionDistance`  | 32      | Geometry ray distance in blocks.                          |
| `visionFov`       | 90      | Geometry horizontal field of view in degrees.             |
| `audioSampleRate` | 16000   | Native server-sound PCM samples per second.               |
| `audioWindowMs`   | 250     | Native audio rolling window in milliseconds.              |

Default `record` is **false**. Enable it to save selected before/after policy observations per agent step to downloadable `inputs.jsonl`; the optional Firebase archive includes the artifact. Serialized, awaited writes apply backpressure instead of accumulating unlimited pending output.

Diagnostics report `droppedEvents`, `droppedBytes` and retained `eventBytes`; the shared envelope also allows provider-specific `unloadedBlocks`. Oversize/overflow loss is reported; ordinary window expiration is retention, not a loss counter increment. Individual state caches, map patch histories and serialization nesting have further bounds documented in the provider. This is not an unlimited lossless packet recorder.

## Complete adapter-event list

All **94** catalogued public event names are below. Routing mirrors the current native collector, including names deliberately skipped to avoid high-frequency fan-out. An event only appears if the installed adapter emits it, the routed channel is enabled and the retention budget permits it. Local error/connection events are not all server packets. Case-insensitive routing means names such as scoreboardTitleChanged route to the messages history; the table records actual routing.

| Event                        | Readable name                 | Current history route                                               |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `chat`                       | chat                          | events.messages                                                     |
| `whisper`                    | whisper                       | events.messages                                                     |
| `actionBar`                  | action Bar                    | events.messages                                                     |
| `error`                      | error                         | events.lifecycle                                                    |
| `message`                    | message                       | events.messages                                                     |
| `messagestr`                 | messagestr                    | events.messages                                                     |
| `unmatchedMessage`           | unmatched Message             | events.messages                                                     |
| `login`                      | login                         | events.lifecycle                                                    |
| `spawn`                      | spawn                         | events.lifecycle                                                    |
| `respawn`                    | respawn                       | events.lifecycle                                                    |
| `game`                       | game                          | events.lifecycle                                                    |
| `title`                      | title                         | events.messages                                                     |
| `rain`                       | rain                          | events.lifecycle                                                    |
| `time`                       | time                          | Not retained as a high-level event (state/raw packets are separate) |
| `kicked`                     | kicked                        | events.lifecycle                                                    |
| `end`                        | end                           | events.lifecycle                                                    |
| `spawnReset`                 | spawn Reset                   | events.lifecycle                                                    |
| `death`                      | death                         | events.lifecycle                                                    |
| `health`                     | health                        | events.lifecycle                                                    |
| `breath`                     | breath                        | events.lifecycle                                                    |
| `entitySwingArm`             | entity Swing Arm              | events.entities                                                     |
| `entityHurt`                 | entity Hurt                   | events.entities                                                     |
| `entityDead`                 | entity Dead                   | events.entities                                                     |
| `entityTaming`               | entity Taming                 | events.entities                                                     |
| `entityTamed`                | entity Tamed                  | events.entities                                                     |
| `entityShakingOffWater`      | entity Shaking Off Water      | events.entities                                                     |
| `entityEatingGrass`          | entity Eating Grass           | events.entities                                                     |
| `entityHandSwap`             | entity Hand Swap              | events.entities                                                     |
| `entityWake`                 | entity Wake                   | events.entities                                                     |
| `entityEat`                  | entity Eat                    | events.entities                                                     |
| `entityCriticalEffect`       | entity Critical Effect        | events.entities                                                     |
| `entityMagicCriticalEffect`  | entity Magic Critical Effect  | events.entities                                                     |
| `entityCrouch`               | entity Crouch                 | events.entities                                                     |
| `entityUncrouch`             | entity Uncrouch               | events.entities                                                     |
| `entityEquip`                | entity Equip                  | events.entities                                                     |
| `entitySleep`                | entity Sleep                  | events.entities                                                     |
| `entitySpawn`                | entity Spawn                  | events.entities                                                     |
| `entityElytraFlew`           | entity Elytra Flew            | events.entities                                                     |
| `usedFirework`               | used Firework                 | events.lifecycle                                                    |
| `itemDrop`                   | item Drop                     | events.entities                                                     |
| `playerCollect`              | player Collect                | events.entities                                                     |
| `entityAttributes`           | entity Attributes             | events.entities                                                     |
| `entityGone`                 | entity Gone                   | events.entities                                                     |
| `entityMoved`                | entity Moved                  | Not retained as a high-level event (state/raw packets are separate) |
| `entityDetach`               | entity Detach                 | events.entities                                                     |
| `entityAttach`               | entity Attach                 | events.entities                                                     |
| `entityUpdate`               | entity Update                 | events.entities                                                     |
| `entityEffect`               | entity Effect                 | events.entities                                                     |
| `entityEffectEnd`            | entity Effect End             | events.entities                                                     |
| `playerJoined`               | player Joined                 | events.lifecycle                                                    |
| `playerUpdated`              | player Updated                | events.lifecycle                                                    |
| `playerLeft`                 | player Left                   | events.lifecycle                                                    |
| `blockUpdate`                | block Update                  | events.blocks                                                       |
| `blockEntityData`            | block Entity Data             | events.blocks                                                       |
| `signOpen`                   | sign Open                     | events.lifecycle                                                    |
| `chunkColumnLoad`            | chunk Column Load             | events.lifecycle                                                    |
| `chunkColumnUnload`          | chunk Column Unload           | events.lifecycle                                                    |
| `soundEffectHeard`           | sound Effect Heard            | events.sounds                                                       |
| `hardcodedSoundEffectHeard`  | hardcoded Sound Effect Heard  | events.sounds                                                       |
| `noteHeard`                  | note Heard                    | events.sounds                                                       |
| `pistonMove`                 | piston Move                   | events.blocks                                                       |
| `chestLidMove`               | chest Lid Move                | events.blocks                                                       |
| `blockBreakProgressObserved` | block Break Progress Observed | events.blocks                                                       |
| `blockBreakProgressEnd`      | block Break Progress End      | events.blocks                                                       |
| `diggingCompleted`           | digging Completed             | events.blocks                                                       |
| `diggingAborted`             | digging Aborted               | events.blocks                                                       |
| `move`                       | move                          | Not retained as a high-level event (state/raw packets are separate) |
| `forcedMove`                 | forced Move                   | events.lifecycle                                                    |
| `mount`                      | mount                         | events.lifecycle                                                    |
| `dismount`                   | dismount                      | events.lifecycle                                                    |
| `windowOpen`                 | window Open                   | events.inventory                                                    |
| `windowClose`                | window Close                  | events.inventory                                                    |
| `sleep`                      | sleep                         | events.lifecycle                                                    |
| `wake`                       | wake                          | events.lifecycle                                                    |
| `experience`                 | experience                    | events.lifecycle                                                    |
| `physicsTick`                | physics Tick                  | Not retained as a high-level event (state/raw packets are separate) |
| `physicTick`                 | physic Tick                   | Not retained as a high-level event (state/raw packets are separate) |
| `scoreboardCreated`          | scoreboard Created            | events.lifecycle                                                    |
| `scoreboardDeleted`          | scoreboard Deleted            | events.lifecycle                                                    |
| `scoreboardTitleChanged`     | scoreboard Title Changed      | events.messages                                                     |
| `scoreUpdated`               | score Updated                 | events.lifecycle                                                    |
| `scoreRemoved`               | score Removed                 | events.lifecycle                                                    |
| `scoreboardPosition`         | scoreboard Position           | events.lifecycle                                                    |
| `teamCreated`                | team Created                  | events.lifecycle                                                    |
| `teamRemoved`                | team Removed                  | events.lifecycle                                                    |
| `teamUpdated`                | team Updated                  | events.lifecycle                                                    |
| `teamMemberAdded`            | team Member Added             | events.lifecycle                                                    |
| `teamMemberRemoved`          | team Member Removed           | events.lifecycle                                                    |
| `bossBarCreated`             | boss Bar Created              | events.lifecycle                                                    |
| `bossBarDeleted`             | boss Bar Deleted              | events.lifecycle                                                    |
| `bossBarUpdated`             | boss Bar Updated              | events.lifecycle                                                    |
| `resourcePack`               | resource Pack                 | events.lifecycle                                                    |
| `heldItemChanged`            | held Item Changed             | events.inventory                                                    |
| `particle`                   | particle                      | events.particles                                                    |

Raw inventory events are additionally added with `packet:` names for `set_slot`, `window_items`, `open_window`, `close_window`, `craft_progress_bar`, `trade_list` and `held_item_slot`. Sound packet histories additionally include `sound_effect`, `named_sound_effect`, `entity_sound_effect`, `stop_sound`, `world_event` and `block_action`. Multiple representations can describe the same server event; do not sum them as independent rewards.

## Complete incoming-packet list

All **104** clientbound PLAY packet types for **Java 1.18.1** are below. The `protocol.packets` channel captures decoded fields for every received type, including those without a higher-level channel. The JSON catalog holds every nested packet schema, common type, switch/option and array definition; this table lists exact top-level fields and a readable purpose.

Packet availability is not permission to request hidden data. In particular, `nbt_query_response` is a permission-dependent debug response, not a normal-player sensor; the collector does not issue privileged NBT requests. `login` here is a PLAY packet containing world-join information, not an authentication exchange. Binary payloads remain encoded data requiring a version/plugin-aware decoder.

| ID     | Packet                         | What it tells the client                                                      | Top-level fields (conditional fields included)                                                                                                                                                                                                       |
| ------ | ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x00` | `spawn_entity`                 | Spawn a non-living/general entity.                                            | `entityId`, `objectUUID`, `type`, `x`, `y`, `z`, `pitch`, `yaw`, `objectData`, `velocity`                                                                                                                                                            |
| `0x01` | `spawn_entity_experience_orb`  | Spawn an experience orb.                                                      | `entityId`, `x`, `y`, `z`, `count`                                                                                                                                                                                                                   |
| `0x02` | `spawn_entity_living`          | Spawn a living entity.                                                        | `entityId`, `entityUUID`, `type`, `x`, `y`, `z`, `yaw`, `pitch`, `headPitch`, `velocity`                                                                                                                                                             |
| `0x03` | `spawn_entity_painting`        | Spawn a painting and its placement metadata.                                  | `entityId`, `entityUUID`, `title`, `location`, `direction`                                                                                                                                                                                           |
| `0x04` | `named_entity_spawn`           | Spawn a player entity.                                                        | `entityId`, `playerUUID`, `x`, `y`, `z`, `yaw`, `pitch`                                                                                                                                                                                              |
| `0x05` | `sculk_vibration_signal`       | Sculk vibration path/timing.                                                  | `sourcePosition`, `destinationIdentifier`, `destination`, `arrivalTicks`                                                                                                                                                                             |
| `0x06` | `animation`                    | Entity animation such as arm swing.                                           | `entityId`, `animation`                                                                                                                                                                                                                              |
| `0x07` | `statistics`                   | Statistic entries delivered to this player.                                   | `entries`                                                                                                                                                                                                                                            |
| `0x08` | `acknowledge_player_digging`   | Server acknowledgment of digging/block action.                                | `location`, `block`, `status`, `successful`                                                                                                                                                                                                          |
| `0x09` | `block_break_animation`        | Block-breaking progress animation.                                            | `entityId`, `location`, `destroyStage`                                                                                                                                                                                                               |
| `0x0a` | `tile_entity_data`             | Block-entity update/NBT.                                                      | `location`, `action`, `nbtData`                                                                                                                                                                                                                      |
| `0x0b` | `block_action`                 | Block-specific animation/action parameters.                                   | `location`, `byte1`, `byte2`, `blockId`                                                                                                                                                                                                              |
| `0x0c` | `block_change`                 | Single block state change.                                                    | `location`, `type`                                                                                                                                                                                                                                   |
| `0x0d` | `boss_bar`                     | Boss-bar creation/update/removal.                                             | `entityUUID`, `action`, `title`, `health`, `color`, `dividers`, `flags`                                                                                                                                                                              |
| `0x0e` | `difficulty`                   | Advertised difficulty and lock state.                                         | `difficulty`, `difficultyLocked`                                                                                                                                                                                                                     |
| `0x0f` | `chat`                         | Chat/system/action message components.                                        | `message`, `position`, `sender`                                                                                                                                                                                                                      |
| `0x10` | `clear_titles`                 | Clear/reset title presentation.                                               | `reset`                                                                                                                                                                                                                                              |
| `0x11` | `tab_complete`                 | Completion response for requested text.                                       | `transactionId`, `start`, `length`, `matches`                                                                                                                                                                                                        |
| `0x12` | `declare_commands`             | Accessible command tree.                                                      | `nodes`, `rootIndex`                                                                                                                                                                                                                                 |
| `0x13` | `close_window`                 | Server closes a menu.                                                         | `windowId`                                                                                                                                                                                                                                           |
| `0x14` | `window_items`                 | Window contents and cursor/revision data.                                     | `windowId`, `stateId`, `items`, `carriedItem`                                                                                                                                                                                                        |
| `0x15` | `craft_progress_bar`           | Numeric menu property (smelting, brewing, enchanting, etc.).                  | `windowId`, `property`, `value`                                                                                                                                                                                                                      |
| `0x16` | `set_slot`                     | One inventory slot/cursor update.                                             | `windowId`, `stateId`, `slot`, `item`                                                                                                                                                                                                                |
| `0x17` | `set_cooldown`                 | Item cooldown duration.                                                       | `itemID`, `cooldownTicks`                                                                                                                                                                                                                            |
| `0x18` | `custom_payload`               | Server/plugin/mod channel payload.                                            | `channel`, `data`                                                                                                                                                                                                                                    |
| `0x19` | `named_sound_effect`           | Sound event identified by name.                                               | `soundName`, `soundCategory`, `x`, `y`, `z`, `volume`, `pitch`                                                                                                                                                                                       |
| `0x1a` | `kick_disconnect`              | Disconnect reason.                                                            | `reason`                                                                                                                                                                                                                                             |
| `0x1b` | `entity_status`                | Entity status/behavior animation code.                                        | `entityId`, `entityStatus`                                                                                                                                                                                                                           |
| `0x1c` | `explosion`                    | Explosion location, affected blocks and impulse data.                         | `x`, `y`, `z`, `radius`, `affectedBlockOffsets`, `playerMotionX`, `playerMotionY`, `playerMotionZ`                                                                                                                                                   |
| `0x1d` | `unload_chunk`                 | Client should forget a chunk.                                                 | `chunkX`, `chunkZ`                                                                                                                                                                                                                                   |
| `0x1e` | `game_state_change`            | Game event/state change such as weather or game mode.                         | `reason`, `gameMode`                                                                                                                                                                                                                                 |
| `0x1f` | `open_horse_window`            | Open mount equipment/storage menu.                                            | `windowId`, `nbSlots`, `entityId`                                                                                                                                                                                                                    |
| `0x20` | `initialize_world_border`      | Initial border dimensions/interpolation/warnings.                             | `x`, `z`, `oldDiameter`, `newDiameter`, `speed`, `portalTeleportBoundary`, `warningBlocks`, `warningTime`                                                                                                                                            |
| `0x21` | `keep_alive`                   | Transport heartbeat request; adapter replies.                                 | `keepAliveId`                                                                                                                                                                                                                                        |
| `0x22` | `map_chunk`                    | Chunk sections, terrain and included block entities.                          | `x`, `z`, `heightmaps`, `chunkData`, `blockEntities`, `trustEdges`, `skyLightMask`, `blockLightMask`, `emptySkyLightMask`, `emptyBlockLightMask`, `skyLight`, `blockLight`                                                                           |
| `0x23` | `world_event`                  | World sound/visual event code and target.                                     | `effectId`, `location`, `data`, `global`                                                                                                                                                                                                             |
| `0x24` | `world_particles`              | Particle type, origin/spread and parameters.                                  | `particleId`, `longDistance`, `x`, `y`, `z`, `offsetX`, `offsetY`, `offsetZ`, `particleData`, `particles`, `data`                                                                                                                                    |
| `0x25` | `update_light`                 | Chunk sky/block-light updates.                                                | `chunkX`, `chunkZ`, `trustEdges`, `skyLightMask`, `blockLightMask`, `emptySkyLightMask`, `emptyBlockLightMask`, `skyLight`, `blockLight`                                                                                                             |
| `0x26` | `login`                        | PLAY join-world metadata; not authentication traffic.                         | `entityId`, `isHardcore`, `gameMode`, `previousGameMode`, `worldNames`, `dimensionCodec`, `dimension`, `worldName`, `hashedSeed`, `maxPlayers`, `viewDistance`, `simulationDistance`, `reducedDebugInfo`, `enableRespawnScreen`, `isDebug`, `isFlat` |
| `0x27` | `map`                          | Map color patch/icon update.                                                  | `itemDamage`, `scale`, `locked`, `icons`, `columns`, `rows`, `x`, `y`, `data`                                                                                                                                                                        |
| `0x28` | `trade_list`                   | Merchant offers and trading metadata.                                         | `windowId`, `trades`, `villagerLevel`, `experience`, `isRegularVillager`, `canRestock`                                                                                                                                                               |
| `0x29` | `rel_entity_move`              | Relative entity displacement.                                                 | `entityId`, `dX`, `dY`, `dZ`, `onGround`                                                                                                                                                                                                             |
| `0x2a` | `entity_move_look`             | Relative entity displacement plus rotation.                                   | `entityId`, `dX`, `dY`, `dZ`, `yaw`, `pitch`, `onGround`                                                                                                                                                                                             |
| `0x2b` | `entity_look`                  | Entity rotation update.                                                       | `entityId`, `yaw`, `pitch`, `onGround`                                                                                                                                                                                                               |
| `0x2c` | `vehicle_move`                 | Server correction/update for controlled vehicle.                              | `x`, `y`, `z`, `yaw`, `pitch`                                                                                                                                                                                                                        |
| `0x2d` | `open_book`                    | Open held book UI.                                                            | `hand`                                                                                                                                                                                                                                               |
| `0x2e` | `open_window`                  | Open named/type-specific menu.                                                | `windowId`, `inventoryType`, `windowTitle`                                                                                                                                                                                                           |
| `0x2f` | `open_sign_entity`             | Open sign text editor.                                                        | `location`                                                                                                                                                                                                                                           |
| `0x30` | `ping`                         | Transport ping; adapter returns pong.                                         | `id`                                                                                                                                                                                                                                                 |
| `0x31` | `craft_recipe_response`        | Recipe-placement/ghost-recipe response.                                       | `windowId`, `recipe`                                                                                                                                                                                                                                 |
| `0x32` | `abilities`                    | Granted player abilities and movement speeds.                                 | `flags`, `flyingSpeed`, `walkingSpeed`                                                                                                                                                                                                               |
| `0x33` | `end_combat_event`             | Combat-end notification.                                                      | `duration`, `entityId`                                                                                                                                                                                                                               |
| `0x34` | `enter_combat_event`           | Combat-start notification.                                                    | No fields                                                                                                                                                                                                                                            |
| `0x35` | `death_combat_event`           | Death/combat message.                                                         | `playerId`, `entityId`, `message`                                                                                                                                                                                                                    |
| `0x36` | `player_info`                  | Tab-list player entries/changes.                                              | `action`, `data`                                                                                                                                                                                                                                     |
| `0x37` | `face_player`                  | Server asks player camera to face a target.                                   | `feet_eyes`, `x`, `y`, `z`, `isEntity`, `entityId`, `entity_feet_eyes`                                                                                                                                                                               |
| `0x38` | `position`                     | Player position/orientation correction or teleport.                           | `x`, `y`, `z`, `yaw`, `pitch`, `flags`, `teleportId`, `dismountVehicle`                                                                                                                                                                              |
| `0x39` | `unlock_recipes`               | Recipe-book state and recipe unlocks.                                         | `action`, `craftingBookOpen`, `filteringCraftable`, `smeltingBookOpen`, `filteringSmeltable`, `blastFurnaceOpen`, `filteringBlastFurnace`, `smokerBookOpen`, `filteringSmoker`, `recipes1`, `recipes2`                                               |
| `0x3a` | `entity_destroy`               | Remove entities from this client's world.                                     | `entityIds`                                                                                                                                                                                                                                          |
| `0x3b` | `remove_entity_effect`         | Remove an entity status effect.                                               | `entityId`, `effectId`                                                                                                                                                                                                                               |
| `0x3c` | `resource_pack_send`           | Resource-pack offer URL/hash/requirement/prompt.                              | `url`, `hash`, `forced`, `promptMessage`                                                                                                                                                                                                             |
| `0x3d` | `respawn`                      | World/dimension/game-mode transition metadata.                                | `dimension`, `worldName`, `hashedSeed`, `gamemode`, `previousGamemode`, `isDebug`, `isFlat`, `copyMetadata`                                                                                                                                          |
| `0x3e` | `entity_head_rotation`         | Entity head yaw.                                                              | `entityId`, `headYaw`                                                                                                                                                                                                                                |
| `0x3f` | `multi_block_change`           | Batch block-state changes.                                                    | `chunkCoordinates`, `notTrustEdges`, `records`                                                                                                                                                                                                       |
| `0x40` | `select_advancement_tab`       | Selected advancement tab.                                                     | `id`                                                                                                                                                                                                                                                 |
| `0x41` | `action_bar`                   | Action-bar message.                                                           | `text`                                                                                                                                                                                                                                               |
| `0x42` | `world_border_center`          | Border center update.                                                         | `x`, `z`                                                                                                                                                                                                                                             |
| `0x43` | `world_border_lerp_size`       | Border size transition.                                                       | `oldDiameter`, `newDiameter`, `speed`                                                                                                                                                                                                                |
| `0x44` | `world_border_size`            | Border size update.                                                           | `diameter`                                                                                                                                                                                                                                           |
| `0x45` | `world_border_warning_delay`   | Border warning time.                                                          | `warningTime`                                                                                                                                                                                                                                        |
| `0x46` | `world_border_warning_reach`   | Border warning distance.                                                      | `warningBlocks`                                                                                                                                                                                                                                      |
| `0x47` | `camera`                       | Camera entity target (e.g. spectator).                                        | `cameraId`                                                                                                                                                                                                                                           |
| `0x48` | `held_item_slot`               | Selected hotbar slot update.                                                  | `slot`                                                                                                                                                                                                                                               |
| `0x49` | `update_view_position`         | Chunk-view center.                                                            | `chunkX`, `chunkZ`                                                                                                                                                                                                                                   |
| `0x4a` | `update_view_distance`         | Server view distance.                                                         | `viewDistance`                                                                                                                                                                                                                                       |
| `0x4b` | `spawn_position`               | World spawn/compass target.                                                   | `location`, `angle`                                                                                                                                                                                                                                  |
| `0x4c` | `scoreboard_display_objective` | Displayed scoreboard objective/position.                                      | `position`, `name`                                                                                                                                                                                                                                   |
| `0x4d` | `entity_metadata`              | Versioned entity metadata fields.                                             | `entityId`, `metadata`                                                                                                                                                                                                                               |
| `0x4e` | `attach_entity`                | Entity attachment/leash relation.                                             | `entityId`, `vehicleId`                                                                                                                                                                                                                              |
| `0x4f` | `entity_velocity`              | Entity velocity update.                                                       | `entityId`, `velocity`                                                                                                                                                                                                                               |
| `0x50` | `entity_equipment`             | Visible entity equipment updates.                                             | `entityId`, `equipments`                                                                                                                                                                                                                             |
| `0x51` | `experience`                   | Player experience bar/level/total update.                                     | `experienceBar`, `level`, `totalExperience`                                                                                                                                                                                                          |
| `0x52` | `update_health`                | Player health, hunger and saturation.                                         | `health`, `food`, `foodSaturation`                                                                                                                                                                                                                   |
| `0x53` | `scoreboard_objective`         | Scoreboard objective create/update/delete.                                    | `name`, `action`, `displayText`, `type`                                                                                                                                                                                                              |
| `0x54` | `set_passengers`               | Entity vehicle/passenger relationships.                                       | `entityId`, `passengers`                                                                                                                                                                                                                             |
| `0x55` | `teams`                        | Team membership/presentation/rules delivered to client.                       | `team`, `mode`, `name`, `friendlyFire`, `nameTagVisibility`, `collisionRule`, `formatting`, `prefix`, `suffix`, `players`                                                                                                                            |
| `0x56` | `scoreboard_score`             | Score entry update/removal.                                                   | `itemName`, `action`, `scoreName`, `value`                                                                                                                                                                                                           |
| `0x57` | `simulation_distance`          | Server simulation-distance advertisement.                                     | `distance`                                                                                                                                                                                                                                           |
| `0x58` | `set_title_subtitle`           | Subtitle text.                                                                | `text`                                                                                                                                                                                                                                               |
| `0x59` | `update_time`                  | World age/time/daylight progression data.                                     | `age`, `time`                                                                                                                                                                                                                                        |
| `0x5a` | `set_title_text`               | Title text.                                                                   | `text`                                                                                                                                                                                                                                               |
| `0x5b` | `set_title_time`               | Title fade/stay timing.                                                       | `fadeIn`, `stay`, `fadeOut`                                                                                                                                                                                                                          |
| `0x5c` | `entity_sound_effect`          | Sound attached to an entity.                                                  | `soundId`, `soundCategory`, `entityId`, `volume`, `pitch`                                                                                                                                                                                            |
| `0x5d` | `sound_effect`                 | Sound event identified by numeric registry ID.                                | `soundId`, `soundCategory`, `x`, `y`, `z`, `volume`, `pitch`                                                                                                                                                                                         |
| `0x5e` | `stop_sound`                   | Stop specified sound/category playback.                                       | `flags`, `source`, `sound`                                                                                                                                                                                                                           |
| `0x5f` | `playerlist_header`            | Tab-list header/footer text.                                                  | `header`, `footer`                                                                                                                                                                                                                                   |
| `0x60` | `nbt_query_response`           | Response to an NBT debug query; permission-dependent, not an ordinary sensor. | `transactionId`, `nbt`                                                                                                                                                                                                                               |
| `0x61` | `collect`                      | Item/experience pickup animation/relationship.                                | `collectedEntityId`, `collectorEntityId`, `pickupItemCount`                                                                                                                                                                                          |
| `0x62` | `entity_teleport`              | Absolute entity position/rotation update.                                     | `entityId`, `x`, `y`, `z`, `yaw`, `pitch`, `onGround`                                                                                                                                                                                                |
| `0x63` | `advancements`                 | Advancement definitions, removals and progress.                               | `reset`, `advancementMapping`, `identifiers`, `progressMapping`                                                                                                                                                                                      |
| `0x64` | `entity_update_attributes`     | Received entity attribute bases/modifiers.                                    | `entityId`, `properties`                                                                                                                                                                                                                             |
| `0x65` | `entity_effect`                | Entity status effect/amplifier/duration/flags.                                | `entityId`, `effectId`, `amplifier`, `duration`, `hideParticles`                                                                                                                                                                                     |
| `0x66` | `declare_recipes`              | Server recipe definitions.                                                    | `recipes`                                                                                                                                                                                                                                            |
| `0x67` | `tags`                         | Registry tag definitions.                                                     | `tags`                                                                                                                                                                                                                                               |

## Coverage boundaries

- Only information sent to this player's client, client-visible local state or declared local approximations is available. No exhaustive server world/entity knowledge exists here.
- Terrain outside received chunks is unknown; occluded received terrain is known to a normal client cache. Geometry sight rays are approximate and do not impose a universal pixel-only restriction on other channels.
- Unopened container contents, unsent statistics/attributes/recipes and other players' hidden inventories/health are not invented. Knowledge updates can arrive later than the corresponding action.
- Raw protocol can include server-supplied plugin/custom/UI data not yet understood by structured channels. This does not imply the policy should be permitted to execute arbitrary plugin commands.
- Vanilla has no built-in microphone/voice-chat input. Mods adding voice chat need an explicit supported capture/channel extension; no microphone recording occurs in the current system.
- Exact full renderer/audio output needs a real matching client. Capture endpoints alone do not supply pixels or full audio.
- Channel defaults and field masks are configurable. Metadata limitations, finite history, encoding, freshness and version constraints remain part of the input definition.
- Protected viewers are filtered from high-level entity/player paths where implemented. Raw packet capture is still what the server sends; rely on server-side viewer hiding rather than assuming the catch-all applies a universal semantic redaction.
- Other Minecraft versions, datapacks, plugins and mods can introduce new packet formats/content. Update the registry/decoder and review the adapter; a baseline list is not a universal cross-version guarantee.

## Source files and regeneration

| Source                                                             | Purpose                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [input-catalog.json](../../packages/core/src/input-catalog.json)   | Authoritative channel identifiers, labels, selectors and coverage notes. |
| [input-defaults.json](../../packages/core/src/input-defaults.json) | Editable default switches, intervals, limits and recording.              |
| [shared input types](../../packages/core/src/inputs.ts)            | Observation/channel/capture envelopes.                                   |
| [native collector](../../packages/agents/src/inputs/minecraft.ts)  | Actual state reads, event routing, filtering and cache behavior.         |
| [vision provider](../../packages/agents/src/inputs/vision.ts)      | Geometry and visible-entity approximations.                              |
| [sound provider](../../packages/agents/src/inputs/sound.ts)        | Native decoded sound playback and missing/pending handling.              |
| [full JSON catalog](../agent-inputs.catalog.json)                  | All channels, events, packet schemas and shared protocol types.          |
| [operational guide](../agent-inputs.md)                            | Dashboard controls, capture API, assets, recording and verification.     |
| [backend guide](../agent-backends.md)                              | Swapping adapters without changing policy input envelopes.               |

Run `npm run inputs:catalog` from the project root to regenerate **both** the full JSON catalog and this README using the configured Minecraft version and current channel/default data. This README is generated; change catalog/defaults or explanatory text in [export-input-readme.ts](../../scripts/export-input-readme.ts), then regenerate. New channel IDs fail generation until a readable explanation is supplied. Version changes still require reviewing mechanics, producer compatibility and coverage; regeneration does not implement new sensors.
