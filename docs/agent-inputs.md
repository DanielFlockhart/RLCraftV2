# Agent inputs

For the complete human-readable list of every channel/field, event and incoming
packet, see the [input reference README](agent-inputs/README.md). This guide covers
configuration, collection and operation.

Agent observations are a configurable set of named channels. Inputs come from
the agent's own Minecraft connection, local client state and received world cache.
There is no server-only sensor RPC, world-file reader, unopened-container query,
privileged exhaustion/attack-cooldown query or global entity scanner.

## Catalog and profiles

The comprehensive versioned catalog is [agent-inputs.catalog.json](agent-inputs.catalog.json).
It lists 46 channels, their field selectors and sources, all public Mineflayer event
names, all 104 Minecraft 1.18.1 incoming PLAY packet types and their full protocol
schemas/common types. It also describes media formats and coverage limits.
Regenerate it after upgrading the protocol/adapter with `npm run inputs:catalog`.
The authenticated dashboard download generates it from the installed protocol data.

The authoritative channel definitions live in
`packages/core/src/input-catalog.json`; defaults are editable in
`packages/core/src/input-defaults.json`. Restart control after editing defaults.
New run setup lets you choose Balanced, Minimal or All native + protocol, switch
individual channels, select fields, set sampling intervals and edit/export JSON.
Unselected channels and fields are absent from policy/trainer observations.
Run profiles are copied into immutable `config.json` artifacts and reused on rerun.
The current UI edits new-run profiles, not already instantiated agent configurations.

Balanced enables structured client state, events and small geometry frames.
The high-volume protocol channel, decoded PCM and external captures are opt-in.
All native + protocol enables server-sound PCM and complete decoded PLAY capture;
external captures remain separately switchable because they require a producer.

Client-received information is broader than pixels currently on screen: the normal
client knows nearby terrain, inventory NBT, received entity metadata and tab-list
entries. The catalog identifies this distinction. `entities.visible` additionally
filters entities by approximate sight geometry and excludes protected viewers.
`world.blocks` deliberately exposes the ordinary received terrain cache, including
occluded terrain. Disable cache/protocol channels for a pixels-only experiment.

## Policy contract

`Policy.act()` and `Transition.observation/nextObservation` receive
`PolicyObservation`, not the runner's internal position/health/reward bookkeeping:

```ts
{
  tick: 12,
  inputs: {
    schemaVersion: 1,
    at: 1790000000000,
    tick: 12,
    sequence: 31,
    channels: {
      "self.vitals": {
        status: "ready",
        sampledAt: 1790000000000,
        source: "client-received",
        data: { health: 20 },
        durationMs: 0.1
      }
    },
    diagnostics: { droppedEvents: 0, droppedBytes: 0, eventBytes: 1200 }
  }
}
```

Access only enabled channels and check `status` before using `data`. Missing data
is explicitly unavailable, not zero-filled. Field masks apply before forwarding
to the policy and trainer. The reward function still reads internal environment
bookkeeping, and the resulting reward is passed to the trainer as before.

Snapshots contain timestamps and independent sequence numbers. Intervals throttle
channel sampling; they do not make Minecraft run faster. Cached channel timestamps
remain unchanged until a new sample. Events are non-consuming rolling histories,
so dashboard inspection does not steal an event from the policy. Event sequence
numbers support deduplication. Integers wider than JavaScript's safe integer range
are tagged decimal strings when received as bigint; binary data is base64. Protocol
schemas explain other 64-bit encodings. NaN/infinities are tagged, not replaced by 0.

## Vision and audio coverage

**Native vision:** first-person depth, block-state semantic IDs, entity IDs,
validity masks, camera pose and a legend. CPU rays use actual received block
collision shapes and entity bounding boxes. Unknown terrain stays invalid/null;
normal air and unloaded cells are distinguished. This is a geometry sensor, not
vanilla rendering: entity models, non-collision decorations, transparent materials,
lighting, textures, particles and HUD pixels are not reproduced. The dashboard
depth preview is clearly labelled.

**Sound events:** exact received named/numeric/entity-attached sound packets,
stop-sound commands, note/block/world sound events. No operating-system microphone
is read. Sound-event metadata is immediately available without asset preparation.

**Server-sound PCM:** decodes actual official vanilla Ogg samples with a WASM Vorbis
decoder, applies event pitch and approximate distance/stereo mixing, and returns
interleaved float32 PCM. Sample choices are deterministic local choices; the server
does not tell a normal client which randomly selected audio variation to use.
The output is a rolling time window, so reads do not drain it. Pending asset loads,
missing/unhandled events and late clips are reported. Music, ambient sounds, local
footstep playback, all client-generated effects, exact vanilla mixing and resource
pack audio overrides require actual client audio capture. World events without a
playback mapping count as missing; their original event data remains available.

Prepare assets from **Agent inputs → Prepare vanilla audio assets**, or:

```powershell
npm.cmd run inputs:prepare
```

This uses the installed Minecraft version's official metadata/index, verifies
downloaded asset SHA-1 hashes, generates the vanilla sound ID registry offline
using the cached Mojang jar and Java 17, and warms common samples. It does not start
a game server or access/change worlds. Assets live under
`DATA_DIR/observation-assets`; mount this directory with your data volume in the
cloud. Resource-pack URLs received from the server are recorded but never fetched
automatically. Decoder caches are bounded and clips are limited to 30 seconds.

**Exact RGB:**
For RGB, the built-in **Fabric** backend now launches a real rendering client and
captures its framebuffer. See [fabric-clients.md](fabric-clients.md). Mineflayer
still needs an external producer. Exact client audio remains external.
Missing or stale captures report unavailable. Synthetic geometry is never
advertised as captured RGB. A silent buffer is not used to stand in for an absent
client audio producer. The Fabric adapter currently does not capture client audio.

Enable `vision.rgb` and/or `audio.capture` in the run profile. A trusted producer
submits to the existing authenticated control service:

```text
POST /runs/<run-id>/agents/<agent-username>/capture
Authorization: Bearer <control-token>
```

```json
{
  "kind": "rgb",
  "encoding": "rgb8",
  "sequence": 1,
  "capturedAt": 1790000000000,
  "width": 1,
  "height": 1,
  "data": "AAAA"
}
```

`capturedAt` must be the current epoch timestamp. RGB is row-major RGB bytes,
exactly `width * height * 3` bytes encoded as base64. PCM uses `kind: "pcm"`,
`encoding: "f32le"`, `sampleRate`, `channels` (1 or 2), and interleaved finite
float32 little-endian samples. Maximum duration is one second. Sequences must
increase; frames older than two seconds are unavailable. Bind the producer to the
same agent camera/session; the API validates format/ownership, not visual content.
Keep the control token on the trusted producer, not a public browser client.

## Completeness, buffers and runtime access

Observations use a backend-independent schema. The dashboard's **Agent backend**
selector shows the installed implementation's coverage, and the common boundary
enforces field/channel selection across adapters. See [agent-backends.md](agent-backends.md)
for switching and [backend-research.md](backend-research.md) for the framework survey.

Protocol capture covers **all incoming PLAY packet names**, including chunks/light,
maps, tags, recipes, advancements, commands, custom payloads and data without a
higher-level adapter. LOGIN-state authentication exchanges are excluded; PLAY-state
`login` world information is retained. Every PLAY packet decoded by the installed
protocol library enters the catch-all stream, including packets without a
structured channel adapter. Unsupported wire formats require updating the protocol
library. It is data actually
sent to the player connection, not everything known by the server.

Every channel has coverage limits. The server only sends a finite view distance;
unloaded terrain is unknown. Statistics may not be sent until the relevant UI is
opened. Containers must actually be opened by the agent to receive their slots.
Map inputs retain received patches with offsets, not an invented complete map.
Advancements/statistics accumulate received updates. Disabled channels are not
supplied to learning code. Simulator runs expose only their small simulated state;
Minecraft/media channels are explicitly unavailable there.

Event histories have configurable count, byte and time bounds. Buffer overflow or
an oversized event increments `droppedEvents/droppedBytes`; finite-window expiration
is normal retention. This is not an unlimited lossless packet recorder. Large
buffers, high resolution, native event fan-out and recording cost resources per
agent. Per-channel collection duration and loss counters make those costs visible.

The **Agent inputs** dashboard tab polls only the selected agent through worker
RPC, including paused agents. Full observations are kept out of global telemetry
and SQLite run bodies. Set `record: true` to save the selected observations used at
each step into `inputs.jsonl`, with username and before/after phases. Writes are
serialized and awaited, so backpressure slows steps rather than accumulating an
unbounded pending-write queue. This artifact is downloadable and included in the
optional Firebase archive.

| Endpoint                                  | Purpose                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `GET /inputs`                             | Channel/default profile catalog and asset preparation status |
| `GET /inputs/catalog.json`                | Full current protocol/input JSON catalog download            |
| `POST /inputs/prepare`                    | Prepare official vanilla audio assets                        |
| `GET /runs/:id/agents/:username/inputs`   | Current selected input frame                                 |
| `POST /runs/:id/agents/:username/capture` | Ingest actual rendered media                                 |
| `GET /runs/:id/artifacts/inputs.jsonl`    | Download recorded policy observations                        |

`npm run inputs:verify` checks real state, geometry, packet capture and decoded
audio on a separate temporary Paper server. It leaves the existing training world
and default runtime ports alone.
