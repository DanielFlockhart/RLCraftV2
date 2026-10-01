# Agent backend research

Reviewed 28 September 2026 against this project's **Paper 1.18.1, shared multiplayer
world, Windows local development, player-visible inputs, generation resets and
future cloud scaling**. This is a broad survey of 20 projects plus their underlying
APIs, not a claim to have found every repository on the internet. Primary project
documentation and source were reviewed; alternative clients were not installed or
performance-benchmarked. Repository heads and archive status are recorded in
[backend-research.json](backend-research.json).

## Recommendation for this project

**The best long-term architecture is a real Minecraft client with a narrow,
versioned client-side observation/control bridge, alongside a lightweight protocol
backend for experiments that do not require exact media.** This is an engineering
recommendation inferred from the coverage gaps below. It is not an existing
package that already meets all the requirements.

Keep **Mineflayer as the current production default**. It already works with the
managed server, viewer protection, training rules, inventories and arenas. Replacing
it with another protocol client will not by itself produce vanilla pixels or the
complete audio mix. Its upstream API is designed around programmable multiplayer
bots, with access to the underlying client packet stream. [Mineflayer](https://github.com/PrismarineJS/mineflayer)

Choose **CraftGround as the first existing research framework to prototype** if
moving individual experiments to a newer Minecraft version and a separate research
runtime is acceptable. It provides actual client RGB, configurable observations,
depth and modern capture paths. Upstream currently documents Minecraft 1.21.0 and
26.2, not this project's 1.18.1. Its default observation schema includes information
outside your chosen player-visible profile, so an adapter must filter it.
[CraftGround](https://github.com/yhs0602/CraftGround),
[observations](https://yhs0602.github.io/CraftGround/observation_space/)

CraftGround's inspected protobuf contains **sound subtitle events, not a PCM audio
stream**. The sound listener drops sounds with no subtitle; its Python wrapper
encodes event positions into vectors. Full client audio would still require a mixer
capture extension. Its initialization schema configures local worlds; an external
shared Paper-server connection and 100 simultaneous rendered clients were not
established by the reviewed material. These are integration gates, not assumptions
that the framework cannot ever support them.
[protobuf](https://github.com/yhs0602/CraftGround/blob/main/src/proto/observation_space.proto),
[listener](https://github.com/yhs0602/CraftGround/blob/main/minecraft/mc121/src/main/java/com/kyhsgeekcode/minecraftenv/MinecraftSoundListener.kt),
[initialization](https://github.com/yhs0602/CraftGround/blob/main/src/proto/initial_environment.proto)

Choose **Botcraft as the first native protocol alternative to benchmark** for the
existing server. It supports 1.18.1 within its documented release range and provides
inventory, interaction, physics and shared world representations. Its optional
renderer draws entities as bounding boxes; it is not the vanilla client renderer.
Full mixed-audio observation was not established in its documented features. Its
published memory figures are upstream claims, not measurements of your configured
training workload. [Botcraft](https://github.com/adepierre/Botcraft)

For **exact vision, GUI, resource packs, modded content and audio on the existing
shared server**, use the matching actual game client and a small client-side mod.
Capture the framebuffer on the render thread, audio from the client mixer, state
from permitted client data, and actions through Minecraft input handlers. A
Fabric-based client bridge is a practical direction for vanilla/Paper; a modpack
requiring Forge/NeoForge needs its matching client stack. Fabric is the modding
foundation, not a finished RL observation system. A client-only bridge does not
require replacing Paper, provided its client and protocol match the server.
[Fabric development](https://fabricmc.net/develop/)

## Comparison

"Not established" means the reviewed public interfaces did not demonstrate the
capability; it does not claim that no extension could implement it. Exact pixels
mean the presented vanilla/modded framebuffer, not a reconstruction of world geometry.

| System                                                                                                    | What it contributes                                                                                      | Main limitation for MLCraft                                                                                                                                   | Decision                                                                  |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Mineflayer](https://github.com/PrismarineJS/mineflayer)                                                  | JS multiplayer bot API, state, events and actions                                                        | No vanilla framebuffer or complete client mixer; protocol caches can include occluded data                                                                      | Keep default for lightweight runs                                         |
| [Botcraft](https://github.com/adepierre/Botcraft)                                                         | C++ client, interaction, physics, optional block renderer, shared world memory                           | Entity rendering is bounding boxes; arbitrary client-required mods need custom protocol work; GPL-3.0                                                           | First native alternative to benchmark                                     |
| [Azalea](https://github.com/azalea-rs/azalea)                                                             | Rust client, ECS plugins, swarms and pathfinding                                                         | Current upstream targets 26.2, graphics are a non-goal, breaking changes are documented; version proxies do not create matching media                           | Consider after a server upgrade and profiling                             |
| [CraftGround](https://github.com/yhs0602/CraftGround)                                                     | Real Minecraft client, RGB/depth, configurable Gymnasium observations and capture optimizations          | 1.21.0/26.2; PCM and existing shared-server operation need additional work; some observations need filtering                                                    | Best existing multimodal research prototype                               |
| [MineStudio](https://github.com/CraftJarvis/MineStudio)                                                   | Simulator callbacks, datasets, policy interfaces, distributed online/offline training and crash recovery | Built on MineRL; simulator downloads its own engine rather than connecting directly to this Paper runtime; complete PCM/multiplayer integration not established | Useful training tooling, not a drop-in client replacement                 |
| [MineRL](https://github.com/minerllabs/minerl)                                                            | Real client pixel observations, Gym environments, VPT/BASALT compatibility                               | v1.0 targets 1.16.5 and Java 8; near-human action space differs from our contract; old branches differ significantly                                            | Use for matching pretrained-model experiments                             |
| [MineDojo](https://github.com/MineDojo/MineDojo)                                                          | Task suite, RGB, structured observations, customization and datasets                                     | Separate research simulator/Java 8 setup; privileged observations must be filtered; full PCM not documented                                                     | Task/data reference rather than default runtime                           |
| [Malmo / MalmoEnv](https://github.com/microsoft/malmo)                                                    | Mission XML, video and structured observations; coordinated multi-agent missions                         | Upstream repository is archived; custom older Minecraft environment rather than current Paper                                                                   | Avoid as the new foundation                                               |
| [MarLÖ](https://github.com/crowdAI/marLo)                                                                 | Multi-agent Gym wrapper around Malmo                                                                     | Inherits Malmo's runtime/version constraints; project asks for maintainers                                                                                      | Historical multi-agent reference                                          |
| [MineClient Bridge](https://github.com/Campione01/MineClient-Bridge)                                      | Actual framebuffer, client state, GUI/key/mouse control, authenticated HTTP and isolated input           | NeoForge 1.21.1/Java 21; small new project; complete audio, training resets and fleet-scale operation not established                                           | Strong reference for a real-client bridge; needs version/integration work |
| [mcinject](https://github.com/ItzAmirreza/mcinject)                                                       | Attach to an existing client, inspect packets/state and invoke client operations over HTTP/CLI/MCP       | Broad reflective interface and packet mutation exceed our policy contract; exact media and fleet lifecycle not established                                      | Debugging reference; do not expose directly to policies                   |
| [Minecraft Console Client](https://github.com/MCCTeam/Minecraft-Console-Client)                           | Lightweight C# console client and automation scripts                                                     | No normal rendered game view; chat/automation focus, not comprehensive multimodal RL                                                                            | Does not address the media gap                                            |
| [pyCraft](https://github.com/ammaraskar/pyCraft)                                                          | Python client networking, including 1.18.1                                                               | README explicitly says only a subset of packets is implemented; no complete world/action/media stack                                                            | Too much reconstruction work                                              |
| [MCProtocolLib](https://github.com/GeyserMC/MCProtocolLib)                                                | Java packet/authentication library                                                                       | Networking foundation, not a complete agent environment, renderer or mixer                                                                                      | Suitable transport building block only                                    |
| [node-minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol)                        | JS packet serialization, authentication and encryption                                                   | Removing Mineflayer means rebuilding its world model, inventory and physics                                                                                     | Use beneath an adapter, not as an upgrade alone                           |
| [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer)                                    | Web/first-person visualization of protocol world data                                                    | Separate renderer rather than exact vanilla framebuffer; not a complete client audio/control environment                                                        | Dashboard visualization, not exact perception                             |
| [Baritone](https://github.com/cabaletta/baritone)                                                         | Automation/pathfinding inside a real client                                                              | High-level behavior library, not an exhaustive observation/capture/training system; autonomous paths change the action abstraction                              | Optional controller inside a client backend                               |
| [Citizens](https://github.com/CitizensDev/Citizens2) / [Carpet](https://github.com/gnembon/fabric-carpet) | Server NPCs or fake-player automation                                                                    | No corresponding player framebuffer/mixer; server-only state can violate the observation constraint; Carpet requires Fabric                                     | Environment/test tooling, not player perception                           |
| [Craftium](https://github.com/mikelma/craftium)                                                           | Fast voxel RL, single/multi-agent Gymnasium/PettingZoo, soft resets                                      | Uses Luanti rather than Minecraft: different physics, worlds, items and protocol                                                                                | Consider only if changing the game itself                                 |
| [Craftax](https://github.com/MichaelTMatthews/Craftax)                                                    | JAX-native open-ended RL benchmark                                                                       | Different game/environment; cannot join Minecraft or display agents in ChilledVibe's world                                                                      | Algorithm prototyping only                                                |

The comparison includes node-minecraft-protocol as an additional building block;
the repository snapshot contains 20 directly inspected candidates. Policies such as
Voyager and Mindcraft were also checked: both use Mineflayer and do not replace the
underlying perception/runtime layer. [Voyager](https://github.com/MineDojo/Voyager),
[Mindcraft](https://github.com/mindcraft-bots/mindcraft)

## Acceptance criteria before adopting another backend

Use the same world, server view distance, agent count, input selection, frame size
and cadence when comparing implementations. Measure RSS, CPU, GPU/VRAM, step
latency p50/p95, observation age, render throughput, audio gaps, dropped events and
server TPS. Compare idle, walking, inventory interaction, terrain changes and
combat, including generation reset, death/respawn, cancellation and disconnects.
Do not compare an idle headless bot with a fully rendered training client.

For an exact-media candidate, verify actual entity models, liquids, transparent
blocks, particles, lighting, HUD/GUI, resource packs, and local/ambient/music sounds.
Check timestamps and the connection between the captured player and the actions.
Test player-visible filtering explicitly: no server world queries, commands,
exhaustion probes or unrestricted reflection available to the policy. World reset
and administrative setup remain separate control-service operations.

The current **100-player server capacity is not a tested capacity for 100 rendered
clients**. Full clients add JVM, renderer and audio costs. Start with a small render
fleet, measure it, then scale/cloud-shard deliberately. Increasing policy sampling
speed is also distinct from accelerating the server's simulation ticks.

## What this change implements

Backends are replaceable through a registry, common async-capable Environment
contract, input-selection boundary and a versioned JSON-lines sidecar transport.
TypeScript factories and external Python/C++/Rust processes can implement the same
contract. The dashboard lists registered implementations and their declared
coverage. Each run records its selection and a configuration/source fingerprint.

**Alternative Minecraft engines were researched, not installed or connected by
this change.** The runnable extra adapters are clearly labeled simulator examples.
This keeps future adoption reviewable without representing a transport interface
as working CraftGround/Botcraft integration. See [agent-backends.md](agent-backends.md)
for switching, extension points and the bridge protocol.
