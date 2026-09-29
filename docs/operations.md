# Operations

## Configuration

Copy `.env.example` to `.env`. The root configuration loads even when commands run from npm workspaces. Capacity and connection settings are validated on startup. Memory arguments accept values such as `1G` or `512M`. `JAVA_PATH` is passed as an executable, and no shell is used to compose server commands. `DATA_DIR` and `SERVER_DIR` can relocate generated state; set them to absolute paths. Dashboard token lookup uses `DATA_DIR` if set. A supplied `CONTROL_TOKEN` must be identical for API and dashboard.

## API

All endpoints except `GET /health` require `Authorization: Bearer <token>`. The token is generated in `data/control-token` unless `CONTROL_TOKEN` is configured. Do not commit it. Default API base: `http://127.0.0.1:4100`.

| Endpoint                      | Purpose                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| GET /health                   | Service liveness                                                             |
| GET /snapshot                 | Bounded current runs, agents, metrics and logs                               |
| GET /models                   | Stage catalog and source fingerprint                                         |
| GET /models/stage/:stage      | Fresh registry factory inspection, cached until code changes                 |
| GET /models/run/:id           | Actual run model snapshot; see [model inspection](model-inspection.md)       |
| POST /runs                    | Validate and enqueue a RunSpec                                               |
| GET /runs/:id                 | Run details, last 1,000 samples and last 500 logs                            |
| POST /runs/:id/pause          | Request pause at tick boundary                                               |
| POST /runs/:id/resume         | Resume a paused worker                                                       |
| POST /runs/:id/cancel         | Cancel queued/active work                                                    |
| POST /runs/:id/rerun          | Create a new run with original configuration                                 |
| POST /runs/:id/watch          | Follow owned live agent as ChilledVibe; body `{ "username": "rl_abcdef_0" }` |
| GET /runs/:id/artifacts/:name | Download allowlisted run artifact                                            |
| POST /server/start            | Spawn the prepared managed server                                            |
| POST /server/stop             | Stop managed Java after cancelling live Minecraft runs                       |
| POST /server/command          | Send `{ "command": "tps" }` to the console                                   |

## Metrics and artifacts

`POST /runs/:id/playback` provides acknowledged speed, generation-length, extension, manual step/time/generation and early-ending controls. See [playback](playback.md). Current settings are in `Run.playback`, active training time in `Run.timing.trainingElapsedMs`, and live changes in the downloadable `controls.jsonl` artifact.

Protected viewers receive an [in-game training HUD](viewer-hud.md) when the managed server reports `server.hudReady`. The control process sends a bounded console state frame once a second, without adding each frame to application logs. Run details include `timing`; completed episode duration and total runtime are recorded in `episodes.jsonl`. Generation clocks exclude acknowledged pauses; total runtime includes them.

Additional dashboard-backed endpoints:

| Endpoint                       | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| GET /agent-presets             | Saved starting setups and item catalog                   |
| POST /agent-presets            | Save a named setup                                       |
| POST /agent-presets/:id        | Update a named setup                                     |
| POST /agent-presets/:id/delete | Delete a preset without changing recorded runs           |
| POST /server/prepare           | Run preparation/plugin update; optional `sourceJar` path |
| POST /archive/sync             | Request one immediate Firebase archive batch             |
| GET /worlds                    | Terrain profiles and saved generations                   |
| POST /worlds                   | Create a training world profile                          |
| POST /worlds/:id/activate      | Select an existing generation                            |
| POST /worlds/:id/reset         | Allocate a fresh generation                              |

`RunSpec.setup` configures inventories and player state. See [starting setups](agent-setup.md) and [training worlds](worlds.md) for schemas and lifecycle constraints. Preparation status is included in `/snapshot`, and its output appears in logs with source `preparation`.

- Throughput is completed **agent steps per wall-clock second**; it is not Minecraft TPS.
- Tick duration includes environment steps, waiting for physics and policy/trainer work.
- Reward is the mean **cumulative** reward per agent, across the run.
- Worker RSS includes Mineflayer and model allocations in that worker.
- Control CPU/memory/event-loop delay measure the **API process only**, not all machine or Java usage. CPU can exceed 100% if native work uses multiple cores.
- Paper TPS is available only after its `tps` console output is observed. Unknown TPS stays unknown.

Each `data/runs/<uuid>/` contains `config.json`, `metrics.jsonl`, `episodes.jsonl`, and, on success, `checkpoint.json`. Checkpoints are metadata-only until a model trainer is plugged in. Downloads may return 404 before the worker creates the requested artifact. Logs persist in SQLite with timestamps, severity, source and optional run ID; the API itself emits request logs to stdout.

Database retention trims logs/metrics to the latest 100,000 entries and control samples to 3,600 entries once a minute. Agent detail is retained for the last 100 terminal runs and active work. Run records and artifact files are retained indefinitely; plan archival/removal for long experiments. The dashboard shows the latest 100 runs, 180 global metrics, 180 control metrics and 150 logs. Run files retain their full metric history even after database retention.

Arena blueprint endpoints are `GET /arena-presets`, `POST /arena-presets`, `POST /arena-presets/:id` and `POST /arena-presets/:id/delete`. `RunSpec.arena` stores a blueprint, origin, grid/shared layout and reset frequency. See [arena workflow](arenas.md) for placement budgets and world-mutation boundaries. Agent snapshots include their observed positions; server snapshots report `arenaReady` after the plugin loads.

## Optional cloud archive

Use `ARCHIVE_PROVIDER=firebase`, project/bucket settings and server-only Application Default Credentials to enable optional experiment archiving. The snapshot includes archive status; the dashboard can request a sync. Local data remains the operational store and durable retry queue. See [Firebase setup](firebase.md) for configuration and limits. Include the SQLite database and unsent run/model files in backups even when archiving is enabled.

## Backups and recovery

Stop the service before copying `data/` and `runtime/server/`. SQLite WAL files must be included if using a live backup mechanism; prefer SQLite's backup API or a filesystem snapshot rather than copying only the main DB while running. Never run two control services against the same database/runtime. Checkpoints do not automatically restore a model or environment yet. Restart retains the durable queue and marks active jobs interrupted.

Use `npm run build && npm start` for a production dashboard. On a dedicated host, run `npm start` under a supervisor that restarts the full process group and forwards termination signals. Shutdown has bounded worker/server termination deadlines. Avoid exposing offline-mode Minecraft or control ports to the internet. Multi-user/public use needs a real authenticated reverse proxy, authorization and secured Minecraft authentication before changing bind addresses.

## Dependency audit

The installed dependency tree currently reports seven moderate npm audit findings from older transitive UUID packages in Minecraft authentication libraries and the Google Cloud Storage HTTP dependency chain. The suggested forced fix downgrades Mineflayer to an incompatible legacy release; it has not been applied. Track upstream updates and run `npm audit` when updating dependencies. Type checks and simulator/process tests do not validate Microsoft sign-in, live Firebase permissions or live Paper compatibility.
