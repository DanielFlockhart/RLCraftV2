# Local first, portable runtime

`npm run dev` still runs everything on this PC, bound to loopback. Cloud deployment is opt-in; no cloud account or Docker installation is required locally.

The first migration target is **one larger Linux VM**. Its control runtime owns Minecraft, training subprocesses and SQLite. The dashboard can run there or remain on your PC and connect remotely. A bigger VM provides more CPU/RAM within configured admission limits. Multi-machine training is a later step.

## Connections and storage

| Setting                             | Local default              | Purpose                                        |
| ----------------------------------- | -------------------------- | ---------------------------------------------- |
| `CONTROL_HOST` / `CONTROL_PORT`     | `127.0.0.1` / `4100`       | API listener                                   |
| `DASHBOARD_HOST` / `DASHBOARD_PORT` | `127.0.0.1` / `3000`       | Dashboard listener                             |
| `CONTROL_URL`                       | `http://127.0.0.1:4100`    | Dashboard and CLI runtime destination          |
| `CONTROL_TOKEN_FILE`                | unset                      | Mounted shared secret                          |
| `CONTROL_TOKEN`                     | unset                      | Alternative secret; takes precedence over file |
| `DATA_DIR`                          | `<project>/data`           | SQLite and locally generated token             |
| `ARTIFACT_DIR`                      | `<DATA_DIR>/runs`          | Run configurations, metrics and checkpoints    |
| `SERVER_DIR`                        | `<project>/runtime/server` | Jar, plugins, configuration and worlds         |
| `MC_BIND_HOST`                      | `127.0.0.1`                | Minecraft binding for newly created properties |
| `MC_HOST`                           | `127.0.0.1`                | Address agents connect to                      |

Relative storage paths resolve from the project root. Workers receive resolved paths. Artifact downloads stream from disk through the API/dashboard. A remote dashboard needs neither SQLite nor shared access to world/artifact volumes.

Secrets must have at least 32 non-whitespace characters and stay server-side. Loopback startup still generates `data/control-token`. A non-loopback control binding requires an explicit token/file. Remote connections require explicit credentials and HTTPS. `CONTROL_ALLOW_INSECURE_HTTP=true` allows HTTP on a trusted private container network; avoid this exception for public internet traffic. Redirects are rejected.

For a local dashboard controlling a cloud runtime, leave `DASHBOARD_HOST=127.0.0.1`, set `CONTROL_URL` to its private HTTPS origin, and set `CONTROL_TOKEN_FILE` or `CONTROL_TOKEN`. Run only:

```powershell
npm.cmd run dev -w @mlcraft/dashboard
# npm.cmd run train -- movement also uses these connection settings.
```

Alternatively, forward a remote loopback API:

```sh
ssh -N -L 4410:127.0.0.1:4100 user@your-vm
```

Use `CONTROL_URL=http://127.0.0.1:4410` and the remote runtime's secret. Do not start another local control service for this dashboard.

## Optional containers

`Dockerfile` has separate control and dashboard targets. Control includes Java 17 and compiler tools for Viewer Guard. Images exclude local `.env`, secrets, databases, worlds and checkpoints. Compose mounts persistent host directories and a shared secret. Dashboard and Minecraft ports are published on the host's loopback only; the API remains inside the container network.

Install Docker Engine with the Compose plugin on your Linux VM (or use a local Docker installation). With Node 24 available:

```sh
npm ci
npm run cloud:init
docker compose -f deploy/compose.yml build
```

For a **new world**, place your compatible Paper 1.18.1 jar at `deploy/cloud.state/server/server.jar`, then prepare inside the Java 17 image:

```sh
docker compose -f deploy/compose.yml run --rm --no-deps control npm run server:prepare -- /server/server.jar
```

Read the Minecraft EULA and set `eula=true` in `deploy/cloud.state/server/eula.txt` if you agree. Preparation installs ChilledVibe's admin spectator guard, creates a container-compatible Minecraft binding, and sets at least 100 player slots. EULA acceptance remains explicit.

```sh
docker compose -f deploy/compose.yml up --detach --wait
npm run cloud:verify
docker compose -f deploy/compose.yml logs --follow control
# Shutdown waits for workers and Minecraft's world save:
docker compose -f deploy/compose.yml down
```

Open `http://127.0.0.1:3000` and use **Start server**. Minecraft is started through the existing controls, rather than automatically at container boot. `cloud:verify` submits a short simulator run through the dashboard and downloads its checkpoint, creating a normal run record. No Minecraft jar/world is required for that smoke check.

If local dev also runs, use other host ports. On Linux: `CLOUD_DASHBOARD_PORT=3100 CLOUD_MC_PORT=25575 docker compose -f deploy/compose.yml up --detach --wait`. Set the same `CLOUD_DASHBOARD_PORT` for `cloud:verify`. In PowerShell, set `$env:CLOUD_DASHBOARD_PORT='3100'` and `$env:CLOUD_MC_PORT='25575'` on separate lines before those commands.

Defaults allow 4 CPUs / 6 GB RAM for control, a 4 GB Java heap, and 1 CPU / 1 GB for the dashboard. Configure `CONTROL_CPUS`, `CONTROL_MEMORY`, `MC_MAX_MEMORY`, `DASHBOARD_CPUS` and `DASHBOARD_MEMORY` for a bigger VM. Leave RAM beyond Java's heap for agents, Node, native memory and the OS. `MAX_CONCURRENT_RUNS` supports 1–8; `MAX_AGENTS` supports 1–128. Player slots remain separately configurable with `MC_MAX_PLAYERS` (minimum 100). Capacity does not guarantee 100 active players at a target TPS; measure your workload before increasing concurrency.

Access a VM through a private tunnel:

```sh
ssh -N -L 3000:127.0.0.1:3000 -L 25565:127.0.0.1:25565 user@your-vm
```

Use the forwarded local addresses in your browser and Minecraft client. This dashboard has no user-account authentication and Minecraft uses offline authentication, so the supplied profile keeps access private. Public hosting needs an authenticated HTTPS gateway/VPN and appropriate Minecraft identity/access settings. A username alone cannot protect ChilledVibe's admin privileges on a publicly exposed offline server.

## Move an existing runtime

1. Finish or cancel active runs. Stop Minecraft from the dashboard and wait for `stopped`. Stop the control service so SQLite closes. Keep a backup.
2. Run `cloud:init` on the destination. Repeated runs preserve existing state and credentials.
3. Copy local `data/` contents into `deploy/cloud.state/data/`, including SQLite and any remaining WAL/SHM files. Copy `data/runs/` (or your configured artifact directory) contents into `deploy/cloud.state/artifacts/`. Copy complete `runtime/server/` contents into `deploy/cloud.state/server/`, including worlds, plugins, jar, EULA acceptance and properties. Transfer privately through SSH or equivalent.
4. In the **copied** `server.properties`, set `server-ip=0.0.0.0` and `server-port=25565`. Preparation preserves existing properties; `MC_BIND_HOST` affects only new files. Published host ports remain loopback. Do not copy Windows `.env` or portable Windows Java; the container uses its own Linux Java 17.
5. Build/start Compose, run the simulator check, start Minecraft, inspect its console/TPS, and connect ChilledVibe through your tunnel. Keep the old runtime stopped while validating the copied runtime.

The Compose secret is separate from the copied `data/control-token`. To retain that old secret, copy it to `deploy/cloud.state/control-token` while services are stopped. Otherwise use the new secret from `cloud:init`. Never commit either state or credentials. Back up all three persistent directories with services stopped. Rebuilding containers or `compose down` preserves these directories.

## Scaling boundaries

For real Minecraft RGB agents, see [Fabric clients](fabric-clients.md). The optional
`control-render` Docker target supplies Xvfb/Mesa display dependencies. Prepare
client assets on the destination OS and set a measured `MAX_RENDER_CLIENTS`; the
ordinary headless control image does not supply a rendering display by default.

Use **one control runtime per SQLite database and managed world**. Do not share those volumes between replicas. `RunExecutor` / `LocalProcessExecutor` isolates subprocess creation from orchestration; lifecycle supervision and worker messages still use local IPC. A remote worker implementation needs a different transport, leases, heartbeats, cancellation acknowledgement and recovery.

Multi-machine training also needs a durable queue, PostgreSQL/history ownership, an artifact adapter for object storage, per-worker world/arena allocation, and GPU/resource scheduling. Keep these behind runtime/agent contracts so the dashboard's HTTP interface can remain stable. Your policy/trainer can call an external model service today.

CI includes a Linux container build and dashboard-to-runtime simulator smoke job. Docker execution requires Docker; local TypeScript and lifecycle/connection checks work without it. A simulator check does not verify Paper performance, GPU integration or useful learning.
