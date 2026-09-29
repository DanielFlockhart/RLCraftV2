# Real Minecraft RGB agents and live dashboard camera

Select **Minecraft client · Fabric RGB** in **New training run → Agent backend**.
This is a real Minecraft Java 1.18.1 client, with a small Fabric mod that captures
its vanilla framebuffer and applies the agent's controls. Each agent has exactly
one player connection. It does not attach a spectator or another connection under
the same username.

## Local setup

1. Restart control and dashboard after updating the project.
2. Select the Fabric backend. Click **Prepare / update Fabric clients** and wait
   for **Client runtime ready**. The first preparation downloads an isolated Java
   17 JDK, pinned Gradle/Fabric dependencies, Minecraft client and verified assets,
   then builds the mod. Your existing launcher, installations and worlds are not
   edited. Preparation can take several minutes. CLI equivalent:

   ```powershell
   npm run clients:prepare
   ```

3. Start Minecraft from the dashboard. The managed backend currently supports
   the project's trusted **offline-authenticated 1.18.1 server**.
4. Create a Fabric run with one agent initially. Choose RGB resolution, capture
   frames per second, view distance, HUD visibility and whether to show local game
   windows. Selecting Fabric enables the RGB policy channel by default. Its other
   supported inputs are listed in the backend's coverage panel.
5. In **Agents**, click an agent row/name or **View state & perspective** to open
   its dedicated inspector at `/agents/<run-id>/<username>`. It shows health,
   hunger, position, inventory, training progress and selected input channels
   alongside its active first-person feed. You can also select an agent in
   **Agent inputs**. Pause viewing and change
   viewer refresh independently of training. Offline, unavailable and stale images
   are explicitly shown; old images are not presented as live.

Defaults: **256 × 192**, **10 capture frames/s**, **4-chunk client view distance**,
HUD included, game windows hidden. The server's own view distance bounds received
terrain. Dashboard viewer polling defaults to 5/s; there is only one outstanding
request per mounted viewer. The capture is the real framebuffer, resized with
nearest-neighbor sampling to the configured dimensions. This includes vanilla
world textures/lighting, entities, particles, held items, HUD and any currently
rendered client menu. Screen images and policy inputs are separate choices.

## Capacity, lifecycle and storage

`MAX_RENDER_CLIENTS=2` defaults to two simultaneous game clients across all Fabric
runs. This is independent of `MAX_AGENTS` and Minecraft's 100-player capacity. Runs
larger than the renderer limit are rejected; runs that fit individually wait for
renderer slots. One full Java client runs per rendered agent; start with one and
benchmark GPU memory, CPU, RAM and throughput before raising the limit.

Use `FABRIC_CLIENT_MEMORY=-Xmx1G` to change the per-client Java heap ceiling.
Game processes are launched without shell expansion, with OS/display environment
and a private per-session RPC secret only. They do not receive control/Firebase
credentials. The client socket listens on loopback; losing the authenticated
parent connection closes its owned game client. Cancellation, generation resets,
respawn and managed arena placement share the existing worker lifecycle. A two
second action lease releases held movement/digging if the controller stops sending
actions; paused training releases them immediately through the worker.

Shared assets/builds/toolchain live in `DATA_DIR/fabric`, or `FABRIC_DIR` if set.
Per-agent game directories and diagnostics live under
`fabric/sessions/<full-run-id>/<agent>-<session>/`. The bridge keeps a bounded
`client.log`; Minecraft also keeps its own log and crash report. Shared runtime
paths in `runtime.json` are relative, so changing the base mount is supported.
Artifacts are checked against mod bytes and current client sources. After editing
Java client code, prepare again; restart control when backend code changes.

`npm run clients:build` compiles the mod without preparing all assets.
`npm run clients:verify` starts an isolated Paper test world on a random port,
launches one hidden real client, checks RGB bytes, movement, starting inventory and
generation resets, and shuts down only its owned processes. It preserves diagnostic
artifacts in `runtime/fabric-verification-*`. It does not start or modify your normal
managed server. No AI policy is trained by this verification.

## Policy inputs and progression

The Fabric adapter currently provides native RGB, identity, pose, health/hunger,
inventory, controls, experience and world/game-mode state. Additional catalog
channels explicitly report unavailable; switching backends does not fabricate
depth, audio or protocol inputs. Exact audio capture and a full replacement of the
Mineflayer sensor catalog are separate extension work. The shared input boundary
still enforces selected channels and field masks before policy/trainer calls.

The administrative viewer feed uses a separate `Environment.feed()` capability.
It remains available with `vision.rgb` disabled or its frame field masked, without
adding images to the policy observation. Current images are not added to global
telemetry, SQLite snapshots or Firebase logs. Selected RGB policy observations are
recorded in `inputs.jsonl` only when observation recording is enabled.

The Fabric mod also reports ordinary received advancement/statistic, inventory,
dimension, block/menu and completion evidence to the existing Progress tab.
Server-owned actor attribution continues through the read-only Paper plugin.
Existing, setup and live evidence remain distinct.

## Cloud and alternative adapters

The pinned client/native libraries support **x64 Windows, Linux and macOS**.
Prepare on the destination OS; Windows native libraries/JDKs cannot be reused on
Linux. Keep the persistent Fabric directory alongside runtime data. A cloud
renderer needs a graphics-capable display and OpenGL driver even with hidden
windows. GPU workers are the intended scale-up route; measure capacity first.

An optional Docker target, **`control-render`**, installs Xvfb and Mesa/display
dependencies and starts control under a virtual display. Build with:

```sh
docker build --target control-render -t rlcraft-control-render .
```

This supplies a software-rendering fallback, not a benchmarked GPU deployment.
Use the same private bindings, data/server/artifact mounts and secret configuration
documented in [cloud.md](cloud.md). Prepare clients on that host from the dashboard.
Hardware GPU drivers/device passthrough depend on the cloud provider.

Backends stay interchangeable through `Environment` and the registry. Mineflayer
remains the lightweight default. Policies use the same selected input envelope and
common radians-based movement/look/dig contract. Fabric is an additional selectable
implementation; it currently uses ordinary client controls, not a complete new
crafting/combat action API.

## HTTP interface

All routes require the existing control authorization. Dashboard calls pass through
the server-side same-origin proxy; the browser never receives the control secret.

| Route                                 | Purpose                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /clients`                        | Prepared runtime status, renderer capacity and preparation state             |
| `POST /clients/prepare`               | Prepare/rebuild client assets; blocked while Fabric workers are active       |
| `GET /runs/:id/agents/:username/feed` | Latest fresh RGB frame for an active owned agent, or explicit unavailability |

The feed responds with `{ status: "ready", frame }` using the existing `rgb8`
base64 format. Frames older than two seconds are unavailable. It polls the selected
worker on demand; there is no unbounded frame queue or background broadcast of every
agent's pixels. Viewing stops when the agent selection changes or the page unmounts.

Version references: [Fabric 1.18 support](https://fabricmc.net/2021/11/30/118.html),
[MinecraftClient rendering facilities](https://maven.fabricmc.net/docs/yarn-1.18.1%2Bbuild.22/net/minecraft/client/MinecraftClient.html),
and [NativeImage pixel format](https://maven.fabricmc.net/docs/yarn-1.18.1%2Bbuild.22/net/minecraft/client/texture/NativeImage.html).
