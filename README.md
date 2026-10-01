# MLCraft

A local control room for Minecraft agent experiments. Next.js + Tailwind dashboard, TypeScript/Fastify control service, isolated run processes, SQLite history, structured logs and performance charts. The AI policy and trainer are explicit placeholders, ready for your implementations.

The Paper plugin's existing `rlcraft*` commands and saved world filenames remain compatible with prepared servers and worlds from earlier versions.

## Start

Use Node **24+**. From this directory:

```powershell
npm.cmd install
Copy-Item .env.example .env
npm.cmd run dev
```

Open **http://127.0.0.1:3000**. The control service listens at **127.0.0.1:4100**. New runs default to Minecraft: prepare and start the managed server first. For infrastructure checks without Java, explicitly choose **Simulator**; this mode creates no visible Minecraft players. AI policies and trainers remain placeholders.

For a production dashboard build: `npm run build`, then `npm start`. Scripts work on Windows, Linux and macOS. Set `DASHBOARD_PORT` and `CONTROL_PORT` in `.env` if needed.

## Minecraft server

```powershell
npm.cmd run server:prepare
# Read the Minecraft EULA and set eula=true in runtime/server/eula.txt if you agree.
```

The prepare script copies only the Paper 1.18.1 jar from `../RLCraft/server/` into a **new** runtime. It never copies old worlds, credentials, plugins, logs or EULA acceptance. It preserves existing runtime settings while enforcing the player capacity minimum and installing the viewer guard. To use another jar: `npm run server:prepare -- C:/path/to/paper.jar`; match `MC_VERSION` and your Java version to that server. The bundled Paper 1.18.1 build requires **Java 17** and rejects newer Java versions. Install Java 17 separately or use a portable runtime, then set `JAVA_PATH` in `.env` to its `bin/java.exe` on Windows. Restart `npm run dev` after changing `.env`.

The server has **at least 100 total player slots**. Set `MC_MAX_PLAYERS` in `.env` to raise this minimum. Preparation and managed server startup preserve a higher existing limit and allow at least `MAX_AGENTS + 4` slots. `MAX_AGENTS` separately controls training-worker concurrency; player capacity does not automatically increase the number of training agents.

Start/stop from the dashboard's Minecraft server page. Startup waits for Paper's readiness line, with a 180-second deadline. Stop returns immediately with a `stopping` status while Paper saves its world, and forces termination only after 60 seconds. Shutdown affects only the process V2 owns. Console commands use stdin, so no RCON secret is needed. Offline bot authentication and a loopback-only server are configured by default.

Minecraft runs use the selected registered agent backend; Mineflayer remains the default. The training plugin handles starting state, generation resets and respawn; the control service must own the Java console locally or on its cloud runtime. An unrelated external server does not provide this reset protocol. The default isolated world is normal survival. Configure an arena or world profile for your experiment.

## Training world profiles

Use **Minecraft server → Training worlds** to choose normal terrain, superflat, large biomes or amplified, customise seed/difficulty/game mode, and edit flat biomes/layers. Stop Minecraft after finishing/cancelling live runs before switching. Same-seed resets and random-seed refreshes create fresh generations while keeping previous worlds available to restore. World metadata follows the portable server directory; live runs record their generation. See [world management](docs/worlds.md) for the workflow and `npm run worlds:verify` for isolated live verification.

## Starting inventories and player setup

Use **Training → Agent setup presets**, or the starting-setup editor when creating a run, to choose items and slots, armor/off-hand equipment, health, hunger, XP, game mode and optional spawn coordinates. Save reusable presets and choose whether to apply once or before every episode. Runs record their own setup snapshot; later preset edits do not change existing experiments. The Agents page shows observed inventory and hunger.

Use **Minecraft server → Prepare/update server** while Minecraft and live runs are stopped to install/update the training plugin. Starting kits require the managed server with the updated plugin; simulator kits also work. See [starting setup workflow](docs/agent-setup.md) for details, limits and verification.

## Custom training structures

Training speed presets, generation limits in steps or active seconds, and manual advancement are configurable in the new-run form and selected-run details. You can extend a generation, advance a paused run by steps/seconds, or end the generation early. Speed changes agent sampling pace; Minecraft world physics continues normally. See [training playback controls](docs/playback.md).

Use **Training → Training structure blueprints** to design reusable cages, boxes and resource rooms with configurable dimensions/materials, block regions, stocked chests/barrels and mobs. Select a blueprint when creating a Minecraft run, choose a shared arena or separate cells per agent, and optionally rebuild it before every episode. The run records the full layout and placement. See [arena workflow](docs/arenas.md) and `npm run arenas:verify` for isolated live checks.

## Experiment game rules

Experiment setup includes keep inventory, no hunger loss, separate creeper block/agent damage switches, PvP, environmental damage, difficulty and native world rules. Agent switches apply to owned players; shared overworld settings require compatible concurrent experiments and restore when the final run exits. See [game rules](docs/training-rules.md).

## Human training viewer

ChilledVibe also receives a personal training sidebar and generation progress boss bar. It shows experiment/generation, step counts, current/previous generation length and total runtime. It follows the agent being spectated; `/rlcrafthud next` switches experiments and `/rlcrafthud off` hides it. Generation currently means training episode. See [the in-game HUD guide](docs/viewer-hud.md).

**ChilledVibe** is protected by the `RLCraftViewerGuard` Paper plugin. It grants operator permissions on join, restores them if removed while online, locks the player to spectator mode, and reapplies protection after reconnect/respawn/world changes. The viewer cannot collide, pick up/drop items, attack, modify blocks/inventories, become a mob target or influence mob spawning or sleep votes through normal player actions. The plugin hides the viewer from other players, including Mineflayer agents. The agent package also exports `trainingEntities()` to filter viewers when adding entity observations/targets.

The plugin sets `spectatorsGenerateChunks=false` in loaded worlds, including worlds loaded later. This limits spectators to terrain already available around agents/spawn and avoids spectator-driven generation/simulation; normal survival agents keep their own normal world behavior. Observing still consumes networking/CPU resources. Full operator commands are intentionally available, so commands such as `/give` or `/summon` can deliberately affect a run. Spectator mode changes for this viewer are blocked.

The plugin is installed by `npm run server:prepare`. For an existing prepared server, run `npm run viewer:build`, then restart **Minecraft** from the dashboard to load the jar. Building needs a JDK 17 or newer (`javac` and `jar`); running Paper still uses Java 17. Set `JAVAC_PATH` and `JAR_PATH` in `.env` if the compiler tools are not on PATH. Source and default viewer names live under `plugins/viewer-guard/`; the installed plugin config is `runtime/server/plugins/RLCraftViewerGuard/config.yml`.

To watch through an agent's camera, use `/spectate <agent-username>`. Use `/spectate` to stop following. `viewerguard ChilledVibe` in the server console reports current protection. `npm run viewer:verify` runs live protection tests in a temporary isolated world/port and leaves the training world alone.

## Run stages and components

Choose movement, wood collection, block collection, survival, or combat in the dashboard. Each has its own configuration, metrics, logs and checkpoint directory. Components:

- **Full pipeline:** environment → policy → transition → trainer → episode report → checkpoint.
- **Environment check:** connects/spawns each agent and samples observations without a policy/trainer update.
- **Evaluation:** runs the policy and rewards without trainer updates.

Runs support queueing, pause/resume at tick boundaries, cancellation and rerunning the same configuration. Paused runs retain their slots. On service restart, queued work resumes; formerly active work is marked interrupted, and may be rerun. Model checkpoint resume is deliberately left to your trainer.

CLI submission to the running control service:

```powershell
npm.cmd run train -- movement
npm.cmd run train -- wood_collection --minecraft
npm.cmd run train -- block_collection --environment
npm.cmd run train -- movement --evaluation
npm.cmd run train -- movement --simulator
# Optional CLI overrides: AGENTS, EPISODES, TICKS, TICK_MS, SEED
```

## Add your AI

Select **Fabric RGB** in a new run to use an actual Minecraft client and first-person
camera. Prepare from the dashboard or `npm run clients:prepare`, then use **View agent
feed** in Agents. See [Fabric client setup](docs/fabric-clients.md) for resource limits,
supported inputs, live viewing and cloud requirements. Mineflayer remains the default.

The **Progress** tab tracks the [75-step Minecraft 1.18.1 completion checklist](docs/progression/README.md),
including minimum resource formulas and alternate routes. Each reached milestone
records the first agent/run and its evidence; history persists across world resets.
Native player evidence is collected independently of policy input selection.
Read-only Paper attribution adds crystal/spawner sightings and accepted player combat
events. After updating, restart control/dashboard and Minecraft; the updated viewer
plugin is installed with `npm run viewer:build`. Regenerate the shared checklist and
README with `npm run progress:catalog`. Optional Firebase archiving includes progress
and tracker records; the live dashboard reads local SQLite.

See the [complete player output/action reference](docs/player-outputs/README.md)
for movement, combat, every inventory click mode, crafting/workstations, item use,
client UI and restricted actions, plus all 1.18.1 item IDs and outgoing packet schemas.
It distinguishes possible Minecraft actions from the small action API implemented today.
The matching [human-readable input reference](docs/agent-inputs/README.md) lists
every observation channel and field, incoming event and packet, with availability
and coverage limits.

Select an **Agent backend** in the new-run dialog. The common contract supports
TypeScript factories and external-process adapters while preserving the same policy
input schema. See [switching backends](docs/agent-backends.md) and the
[20-project research survey](docs/backend-research.md) for recommendations, coverage
and version constraints. Alternatives require an installed adapter; the included
module/process examples are simulators.

Configure observations in **New training run → Agent inputs**, then inspect a
connected player on the **Agent inputs** tab. The [full JSON catalog](docs/agent-inputs.catalog.json)
lists structured channels and every incoming Minecraft 1.18.1 PLAY packet schema.
Policies/trainers receive only selected channels and fields. See [agent inputs](docs/agent-inputs.md)
for native geometry vision, sound events/PCM, exact RGB/audio capture integration,
sampling, recordings, limits and unavailable-data handling.

The **Architecture** dashboard tab inspects registered models and actual run objects,
with interactive graphs, parameter counts, module details and hyperparameters. It
shows the current placeholders honestly. Connect your model/optimizer once through
`inspectModel()` or `inspectModuleTree()`; subsequent changes are read from the
objects rather than maintained in a separate diagram. See [model inspection](docs/model-inspection.md).

1. Implement `Policy` in `packages/agents/src/policy.ts`: reset, act, close.
2. Implement `Trainer`: consume transitions, update at episode boundaries, serialize model checkpoint state. Evaluation skips updates.
3. Add task-specific preparation and reward functions in `packages/agents/src/stages.ts`. Agent spawning, generation reset/respawn and configured arena reconstruction are already handled by the worker.
4. Register your stage-specific policy/trainer factories in `packages/agents/src/registry.ts`; the worker loads them automatically.
5. Extend the core observation/action contract and participating backend adapters together; keep client-specific APIs inside those adapters.
6. Implement the policy/trainer inspection hooks against your actual model and optimizer so the Architecture tab follows runtime changes automatically.

The runner supplies a run seed and deterministic policy reset seeds. World randomness is not controlled until your environment setup implements seeding/reset. Policy and trainer hooks have deadlines so a stuck component fails its run. Keep CPU-heavy inference in the run worker or a dedicated external model service.

## Dataset generation

Use **Datasets** in the dashboard to run the Phase 1A synthetic goal-selection generator with configurable split sizes, seed and sampling settings. Jobs support progress/logs, cancellation, downloads, reproducible reruns and expansion into new versions. Python 3.10+ must be installed on the control host; set `PYTHON_PATH` if needed. See [dataset generators](docs/datasets.md) for CLI usage, output details and registration of future scripts.

Open **Training stages / Phase 1A · Goal prediction** to train the Phase 1A supervised MLP, inspect evaluation metrics,
download checkpoints, and compare predictions with dataset examples. See
[Phase 1A training](docs/phase1a-training.md) for Python dependencies and the reusable
prediction interface.

## Layout

```text
apps/control/src/        API, scheduler, Java lifecycle, persistence, worker entrypoint
apps/dashboard/app/     Next.js dashboard and same-origin control proxy
packages/core/src/      Shared contracts and stage registry
packages/agents/src/    Policy/trainer extension points, rewards and environments
packages/runtime/src/   Node-only connection, secret and storage configuration
scripts/                Cross-platform launcher, server preparation, CLI submission
deploy/                 Optional container deployment and ignored persistent state
tests/                  Lifecycle, queue, auth, artifacts and recovery integration tests
docs/                   Architecture and operations
data/                   Generated SQLite DB, access token, run artifacts (ignored)
runtime/server/         Isolated Minecraft runtime (ignored)
```

Run `npm test` and `npm run build` to verify the project. CI runs the same checks on Windows and Linux. Dependencies are pinned by `package-lock.json`.

See [architecture](docs/architecture.md) for scaling boundaries and [operations](docs/operations.md) for API, metrics, retention and backups.

## Future cloud deployment

An optional Firebase archive stores experiment metadata, batched logs/graph samples and run/model artifacts in Firestore and Cloud Storage. Local storage stays the default, and the live scheduler/dashboard still use SQLite. The dashboard shows archive backlog/status and can request a sync. No Firebase project or credentials are required until you enable it. See [Firebase setup](docs/firebase.md) for settings, the container secret overlay and remaining cloud-history work.

Local startup remains the default. The dashboard and CLI can connect to another runtime with `CONTROL_URL` and a server-side shared secret. Configurable data, artifact and Minecraft directories, separate container images, Java 17, persistent storage, health checks and graceful shutdown are provided for a larger Linux VM. `npm run cloud:init` prepares optional deployment state without starting services. See [cloud setup and migration](docs/cloud.md) for commands and the remaining steps before distributed training.
