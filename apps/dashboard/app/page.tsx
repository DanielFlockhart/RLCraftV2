"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  ChevronRight,
  CircleHelp,
  Cpu,
  Download,
  FlaskConical,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Square,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { Badge, Chart, format } from "../components/telemetry";
import { TrainingWorlds } from "../components/worlds";
import { AgentSetupEditor } from "../components/agent-setup";
import { ArchiveStatus } from "../components/archive";
import { ArenaEditor } from "../components/arenas";
import { PlaybackSetup, PlaybackControls } from "../components/playback";
import { TrainingRulesEditor } from "../components/training-rules";
import { Architecture } from "../components/architecture";
import { Progress } from "../components/progress";
import { Datasets } from "../components/datasets";
import { InputEditor, LiveInputs } from "../components/inputs";
import { BackendSelector } from "../components/backends";
import { FabricSettings } from "../components/fabric";
import { defaultInputs } from "@rlcraft/core";
import { MinecraftIcon, stageIcons } from "../components/minecraft-icon";
import type {
  Snapshot,
  RunSpec,
  Run,
  StageId,
  LogEntry,
  AgentSetup,
  ArenaSpec,
} from "@rlcraft/core";
type View =
  | "overview"
  | "training"
  | "agents"
  | "architecture"
  | "progress"
  | "inputs"
  | "datasets"
  | "server"
  | "logs";
const active = ["running", "paused", "pausing", "queued"];
export default function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState<Snapshot>();
  const [view, setView] = useState<View>("overview");
  const [online, setOnline] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(false);
  const [selected, setSelected] = useState<string>("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "agents") setView("agents");
    if (params.get("view") === "datasets") setView("datasets");
    if (params.get("view") === "training") {
      setView("training");
      setSelected(params.get("run") ?? "");
    }
  }, []);
  const [detail, setDetail] = useState<{
    run: Run;
    metrics: Snapshot["metrics"];
    agents: Snapshot["agents"];
    logs: Snapshot["logs"];
  }>();
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const [command, setCommand] = useState("");
  const [presetSetup, setPresetSetup] = useState<AgentSetup>();
  const [presetArena, setPresetArena] = useState<ArenaSpec>();
  const [sourceJar, setSourceJar] = useState("");
  const [spec, setSpec] = useState<RunSpec>({
    stage: "movement",
    mode: "minecraft",
    component: "pipeline",
    agents: 4,
    episodes: 10,
    ticksPerEpisode: 100,
    tickMs: 100,
    seed: 42,
  });
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/control/snapshot", { signal });
      if (!res.ok) throw new Error((await res.json()).error);
      setData(await res.json());
      setOnline(true);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setOnline(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      await refresh(controller.signal);
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!selected) {
      setDetail(undefined);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      try {
        const r = await fetch(`/api/control/runs/${selected}`, {
          signal: controller.signal,
        });
        if (r.ok) setDetail(await r.json());
      } catch {}
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    setDetail(undefined);
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [selected]);
  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/control/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Request failed");
      await refresh();
      return result;
    } catch (err) {
      setError((err as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  const runs = data?.runs ?? [];
  const agents =
    data?.agents.filter((a) =>
      active.includes(runs.find((r) => r.id === a.runId)?.status ?? ""),
    ) ?? [];
  const focus = selected
    ? (detail?.run ?? runs.find((r) => r.id === selected))
    : (runs.find((r) => r.status === "running") ?? runs[0]);
  const metrics = selected
    ? (detail?.metrics ?? [])
    : (data?.metrics.filter((m) => m.runId === focus?.id) ?? []);
  const last = metrics.at(-1);
  const host = data?.hostMetrics.at(-1);
  const logs = (selected ? detail?.logs : data?.logs) ?? [];
  const filteredLogs = logs.filter(
    (l) =>
      (level === "all" || l.level === level) &&
      `${l.source} ${l.message}`.toLowerCase().includes(query.toLowerCase()),
  );
  function newRun(stage?: StageId) {
    setSpec((s) => ({ ...s, stage: stage ?? s.stage }));
    setModal(true);
  }
  function runTable() {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Run / stage</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Agents</th>
              <th>Mode</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                className={selected === run.id ? "selected" : ""}
              >
                <td>
                  <button
                    className="run-link"
                    onClick={() => setSelected(run.id)}
                  >
                    {run.spec.stage.replaceAll("_", " ")}{" "}
                    <ArrowUpRight size={13} />
                  </button>
                  <small className="mono">
                    {run.id.slice(0, 8)} · {run.spec.component}
                  </small>
                </td>
                <td>
                  <Badge status={run.status} />
                </td>
                <td>
                  <div className="progress">
                    <i style={{ width: `${run.progress * 100}%` }} />
                  </div>
                  <small>
                    Episode {run.episode}/{run.spec.episodes} ·{" "}
                    {format(run.progress * 100, 0)}%
                  </small>
                </td>
                <td>{run.spec.agents}</td>
                <td>
                  <span className="mode-tag">{run.spec.mode}</span>
                </td>
                <td>
                  <div className="actions">
                    {run.status === "running" && (
                      <button
                        disabled={busy || !online}
                        title="Pause run"
                        aria-label="Pause run"
                        onClick={() => act(`runs/${run.id}/pause`)}
                      >
                        <Pause size={14} />
                      </button>
                    )}
                    {run.status === "paused" && (
                      <button
                        disabled={busy || !online}
                        title="Resume run"
                        aria-label="Resume run"
                        onClick={() => act(`runs/${run.id}/resume`)}
                      >
                        <Play size={14} />
                      </button>
                    )}
                    {active.includes(run.status) ? (
                      <button
                        disabled={busy || !online}
                        title="Cancel run"
                        aria-label="Cancel run"
                        onClick={() => act(`runs/${run.id}/cancel`)}
                      >
                        <Square size={14} />
                      </button>
                    ) : (
                      <button
                        disabled={busy || !online}
                        title="Rerun with same configuration"
                        aria-label="Rerun"
                        onClick={() => act(`runs/${run.id}/rerun`)}
                      >
                        <RefreshCw size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!runs.length && (
          <div className="empty">
            <FlaskConical size={28} />
            <h3>Your first experiment starts here</h3>
            <p>Choose a stage and run the simulator to verify your pipeline.</p>
            <button
              className="primary"
              disabled={!online}
              onClick={() => newRun()}
            >
              <Plus size={15} /> Create run
            </button>
          </div>
        )}
      </div>
    );
  }
  function logPanel() {
    return (
      <div className="log-panel">
        {filteredLogs.length ? (
          filteredLogs.slice(-120).map((log: LogEntry) => (
            <div className="log-line" key={log.id}>
              <time>{new Date(log.at).toLocaleTimeString()}</time>
              <span className={`log-level ${log.level}`}>{log.level}</span>
              <span className="log-source">{log.source}</span>
              <span>{log.message}</span>
            </div>
          ))
        ) : (
          <p className="muted">No matching log entries.</p>
        )}
      </div>
    );
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <div className="brand-icon">
            <MinecraftIcon
              name="grass_block"
              size={42}
              label="Minecraft grass block"
            />
          </div>
          <div>
            RLCraft <span>V2</span>
            <small>TRAINING INFRASTRUCTURE</small>
          </div>
        </a>
        <div className="workspace-label">
          WORKSPACE <span>LOCAL</span>
        </div>
        <nav>
          {(
            [
              { id: "overview", label: "Overview", icon: "compass" },
              {
                id: "training",
                label: "Training stages",
                icon: "experience_bottle",
              },
              { id: "agents", label: "Agent fleet", icon: "crafting_table" },
              { id: "architecture", label: "Architecture", icon: "diamond" },
              { id: "progress", label: "Progress", icon: "experience_bottle" },
              { id: "inputs", label: "Agent inputs", icon: "compass" },
              { id: "datasets", label: "Datasets", icon: "book" },
              { id: "server", label: "Minecraft server", icon: "furnace" },
              { id: "logs", label: "Activity & logs", icon: "book" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "nav-active" : ""}
              onClick={() => {
                setView(item.id);
                setQuery("");
              }}
            >
              <MinecraftIcon name={item.icon} size={24} />
              {item.label}
              {view === item.id && <ChevronRight size={14} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className={`dot ${online ? "live" : ""}`} />
            <strong>
              {online ? "Control service online" : "Control service offline"}
            </strong>
            <p>127.0.0.1 · private workspace</p>
          </div>
          <div className="build-label">
            <CircleHelp size={14} /> Infrastructure v0.1 <span>Node 24</span>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace <ChevronRight size={13} />{" "}
            <b>
              {view === "overview"
                ? "Overview"
                : view === "training"
                  ? "Training stages"
                  : view === "agents"
                    ? "Agent fleet"
                    : view === "server"
                      ? "Minecraft server"
                      : view === "architecture"
                        ? "Architecture"
                        : view === "inputs"
                          ? "Agent inputs"
                          : view === "datasets"
                            ? "Datasets"
                            : view === "progress"
                              ? "Progress"
                              : "Activity & logs"}
            </b>
          </div>
          <div className="top-status">
            <span className={`dot ${online ? "live" : ""}`} />
            {online ? "Live telemetry" : "Disconnected"}
            <span className="avatar">RL</span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">CONTROL ROOM / {view.toUpperCase()}</div>
              <h1>
                {view === "overview"
                  ? "A better place to train."
                  : view === "training"
                    ? "Build skills. Then combine them."
                    : view === "agents"
                      ? "Your agent fleet."
                      : view === "server"
                        ? "The world behind your runs."
                        : view === "architecture"
                          ? "Inside your agent models."
                          : view === "inputs"
                            ? "What your agents can perceive."
                            : view === "datasets"
                              ? "Data for each training stage."
                              : view === "progress"
                                ? "Every milestone on the way to the End."
                                : "Every event, in context."}
              </h1>
              <p>
                {view === "overview"
                  ? "Orchestrate agents, run experiments, and see what happens."
                  : view === "training"
                    ? "Independent stages with shared lifecycle, telemetry, and checkpoints."
                    : view === "agents"
                      ? "Agents belong to isolated run workers and share a bounded capacity."
                      : view === "server"
                        ? "Manage the local Java process and inspect its console output."
                        : view === "architecture"
                          ? "Inspect actual model structures, module configuration and hyperparameters."
                          : view === "inputs"
                            ? "Inspect selected, realtime inputs from each player connection."
                            : view === "datasets"
                              ? "Run generators, expand datasets, and download versioned results."
                              : view === "progress"
                                ? "Track survival routes, required resources and the first agent to reach each checkpoint."
                                : "Persistent, structured logs from the control service, workers, and server."}
              </p>
            </div>
            <button
              className="primary"
              disabled={!online || busy}
              onClick={() => newRun()}
            >
              <Plus size={16} /> New training run
            </button>
          </div>
          {!online && (
            <div className="notice warn">
              Control service unavailable. Run <code>npm run dev</code> from the
              RLCraftV2 root. Controls become available when connected.
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          <div className="notice">
            <FlaskConical size={16} />
            <span>
              Infrastructure is ready. Policies and trainers are placeholders;
              simulator runs verify plumbing and do not train AI.
            </span>
            <span className="notice-tag">AI EXTENSION POINTS</span>
          </div>
          {(view === "overview" || view === "agents") && (
            <div className="stats">
              {[
                {
                  label: "Minecraft server",
                  value: data?.server.status ?? "offline",
                  sub: data?.server.pid
                    ? `Process ${data.server.pid}`
                    : "Managed Java process",
                  icon: Server,
                },
                {
                  label: "Active agents",
                  value: String(data?.capacity.activeAgents ?? 0),
                  sub: `of ${data?.capacity.maxAgents ?? 16} available slots`,
                  icon: Users,
                },
                {
                  label: "Running experiments",
                  value: String(data?.capacity.activeRuns ?? 0),
                  sub: `${runs.filter((r) => r.status === "queued").length} queued · ${data?.capacity.maxRuns ?? 2} worker slots`,
                  icon: FlaskConical,
                },
                {
                  label: "Control memory",
                  value: host ? `${format(host.memoryMb, 0)} MB` : "—",
                  sub: host
                    ? `${format(host.cpuPercent)}% CPU · control process`
                    : "Waiting for telemetry",
                  icon: Cpu,
                },
              ].map((stat) => (
                <div className="stat" key={stat.label}>
                  <div>
                    {stat.label}
                    <stat.icon size={17} />
                  </div>
                  <strong
                    className={
                      stat.label === "Minecraft server" ? "status-value" : ""
                    }
                  >
                    {stat.value}
                  </strong>
                  <small>{stat.sub}</small>
                </div>
              ))}
            </div>
          )}
          {view === "overview" && (
            <>
              <div className="section-heading">
                <h2>
                  Performance <span className="live-pill">LIVE</span>
                </h2>
                <div className="performance-selector">
                  <select
                    aria-label="Performance run"
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    <option value="">Latest active run</option>
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.spec.stage} · {r.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="chart-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Agent throughput</h3>
                      <p>
                        Completed agent steps per second ·{" "}
                        {focus?.spec.mode ?? "no run"}
                      </p>
                    </div>
                    <strong>
                      {last ? format(last.stepsPerSecond) : "—"}{" "}
                      <small>steps/s</small>
                    </strong>
                  </div>
                  <Chart
                    data={metrics as unknown as Array<Record<string, number>>}
                    field="stepsPerSecond"
                    label="Steps / second"
                  />
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Control process health</h3>
                      <p>CPU utilization · control service only</p>
                    </div>
                    <strong>
                      {host ? format(host.cpuPercent) : "—"}{" "}
                      <small>% CPU</small>
                    </strong>
                  </div>
                  <Chart
                    data={
                      (data?.hostMetrics ?? []) as unknown as Array<
                        Record<string, number>
                      >
                    }
                    field="cpuPercent"
                    color="#b4a0f5"
                    label="CPU percent"
                  />
                </section>
              </div>
              <div className="section-heading">
                <h2>
                  Training runs <span className="count">{runs.length}</span>
                </h2>
                <button
                  className="text-button"
                  onClick={() => setView("training")}
                >
                  Explore stages <ArrowUpRight size={14} />
                </button>
              </div>
              <section className="panel">{runTable()}</section>
              <ArchiveStatus
                state={data?.archive}
                disabled={!online || busy}
                sync={() => act("archive/sync")}
              />
            </>
          )}
          {view === "training" && (
            <>
              <div className="stage-grid">
                {data?.stages.map((stage, i) => (
                  <section className="stage-card" key={stage.id}>
                    <div className="stage-top">
                      <span className="stage-number">0{i + 1}</span>
                      <Badge status="placeholder" />
                    </div>
                    <h3 className="minecraft-heading">
                      <MinecraftIcon name={stageIcons[stage.id]} size={30} />
                      {stage.name}
                    </h3>
                    <p>{stage.description}</p>
                    <small>{stage.readiness}</small>
                    <button
                      disabled={!online || busy}
                      onClick={() => newRun(stage.id)}
                    >
                      Configure run <ArrowUpRight size={14} />
                    </button>
                  </section>
                ))}
              </div>
              <div className="section-heading">
                <h2>Run history</h2>
                <span className="muted">Newest first</span>
              </div>
              <section className="panel">{runTable()}</section>
              <section className="panel world-panel">
                <div className="panel-heading">
                  <div>
                    <h3>Agent setup presets</h3>
                    <p>
                      Build reusable starting kits and agent state for different
                      experiments.
                    </p>
                  </div>
                </div>
                <AgentSetupEditor
                  value={presetSetup}
                  onChange={setPresetSetup}
                  act={act}
                  online={online}
                  idPrefix="preset-setup"
                />
              </section>
              <section className="panel world-panel">
                <div className="panel-heading">
                  <div>
                    <h3>Training structure blueprints</h3>
                    <p>
                      Design cages, resource rooms and shared arenas with
                      stocked containers and mobs.
                    </p>
                  </div>
                </div>
                <ArenaEditor
                  value={presetArena}
                  onChange={setPresetArena}
                  act={act}
                  online={online}
                  idPrefix="preset-arena"
                  placement={false}
                />
              </section>
            </>
          )}
          {selected &&
            (view === "training" || view === "overview") &&
            focus && (
              <section className="panel detail">
                <div className="panel-heading">
                  <div>
                    <h3>
                      {focus.spec.stage.replaceAll("_", " ")}{" "}
                      <span className="mono">{focus.id.slice(0, 8)}</span>
                    </h3>
                    <p>
                      {focus.spec.component} · seed {focus.spec.seed} ·{" "}
                      {focus.spec.tickMs}ms cadence ·{" "}
                      <Badge status={focus.status} />
                    </p>
                  </div>
                  <button
                    aria-label="Close run details"
                    onClick={() => setSelected("")}
                  >
                    <X size={18} />
                  </button>
                </div>
                {focus.error && (
                  <div className="notice error">{focus.error}</div>
                )}
                <PlaybackControls
                  key={focus.id}
                  run={focus}
                  act={async (path, body) => {
                    const result = await act(path, body);
                    if (result?.id === focus.id)
                      setDetail((previous) =>
                        previous ? { ...previous, run: result } : previous,
                      );
                    return result;
                  }}
                  busy={busy}
                  online={online}
                />
                {focus.spec.mode === "minecraft" &&
                  active.includes(focus.status) && (
                    <div className="notice">
                      <div>
                        Join Minecraft as ChilledVibe, then watch an agent.
                        Agents remain idle until you implement their policy.
                      </div>
                      <div className="agent-watch-list">
                        {(data?.agents ?? [])
                          .filter((agent) => agent.runId === focus.id)
                          .map((agent) => (
                            <button
                              key={agent.id}
                              className="run-link"
                              disabled={
                                busy ||
                                !online ||
                                !["active", "paused"].includes(agent.status)
                              }
                              onClick={() =>
                                void act(`runs/${focus.id}/watch`, {
                                  username: agent.username,
                                })
                              }
                            >
                              Watch {agent.username} · {agent.status}
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                {focus.world && (
                  <div className="notice">
                    World: <code>{focus.world.levelName}</code> ·{" "}
                    {focus.world.settings.type} · seed{" "}
                    {focus.world.settings.seed || "unrecorded"}
                  </div>
                )}
                {focus.spec.rules && (
                  <div className="notice">
                    Rules: inventory on death{" "}
                    {focus.spec.rules.keepInventory ? "kept" : "dropped"} ·
                    hunger loss {focus.spec.rules.noHungerLoss ? "off" : "on"} ·
                    creeper block damage{" "}
                    {focus.spec.rules.creeperBlockDamage ? "world" : "off"} ·
                    difficulty {focus.spec.rules.difficulty}. Full rules are
                    recorded in config.json.
                  </div>
                )}
                {focus.spec.setup && (
                  <div className="notice">
                    Starting setup: {focus.spec.setup.items.length} configured
                    slots ·{" "}
                    {focus.spec.setup.applyEachEpisode
                      ? "each episode"
                      : "once per run"}{" "}
                    ·{" "}
                    {focus.spec.setup.items
                      .map(
                        (item) =>
                          `${item.item.replace("minecraft:", "")} ×${item.count}`,
                      )
                      .join(", ") || "empty inventory"}
                  </div>
                )}
                {focus.spec.arena && (
                  <p className="world-help">
                    Training arena: {focus.spec.arena.blueprint.width} ×{" "}
                    {focus.spec.arena.blueprint.depth} ×{" "}
                    {focus.spec.arena.blueprint.height} interior ·{" "}
                    {focus.spec.arena.layout === "shared"
                      ? "shared"
                      : "one cell per agent"}{" "}
                    ·{" "}
                    {focus.spec.arena.resetEachEpisode
                      ? "rebuild each episode"
                      : "build once"}{" "}
                    · origin {focus.spec.arena.origin.x},{" "}
                    {focus.spec.arena.origin.y}, {focus.spec.arena.origin.z}.
                    Full blueprint is saved in config.json.
                  </p>
                )}
                <div className="chart-grid">
                  <div>
                    <h3>Mean cumulative reward</h3>
                    <Chart
                      data={metrics as unknown as Array<Record<string, number>>}
                      field="reward"
                      label="Reward"
                    />
                  </div>
                  <div>
                    <h3>Worker memory (MB)</h3>
                    <Chart
                      data={metrics as unknown as Array<Record<string, number>>}
                      field="workerMemoryMb"
                      color="#e8b875"
                      label="Worker memory MB"
                    />
                  </div>
                </div>
                <div className="artifacts">
                  {[
                    "config.json",
                    "metrics.jsonl",
                    "episodes.jsonl",
                    ...(focus.status === "completed"
                      ? ["checkpoint.json"]
                      : []),
                  ].map((name) => (
                    <a
                      key={name}
                      href={`/api/control/runs/${focus.id}/artifacts/${name}`}
                    >
                      <Download size={14} />
                      {name}
                    </a>
                  ))}
                </div>
                <p className="muted">
                  Checkpoints contain metadata until you implement a trainer.
                  Metrics measure infrastructure performance.
                </p>
              </section>
            )}
          {view === "agents" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Active agents</h3>
                  <p>
                    Click an agent to inspect its state and perspective. Pause
                    or cancel a run to control its agents together.
                  </p>
                </div>
                <Badge status={`${agents.length} agents`} />
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Run</th>
                      <th>Status</th>
                      <th>Ticks</th>
                      <th>Reward</th>
                      <th>Health</th>
                      <th>Hunger</th>
                      <th>Inventory</th>
                      <th>Position</th>
                      <th>Inspector</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((a) => (
                      <tr
                        key={a.id}
                        className="agent-fleet-row"
                        onClick={(event) => {
                          if (
                            !(event.target as HTMLElement).closest(
                              "a, button, input, select",
                            )
                          )
                            router.push(
                              `/agents/${encodeURIComponent(a.runId)}/${encodeURIComponent(a.username)}`,
                            );
                        }}
                      >
                        <td className="mono">
                          <Link
                            className="run-link"
                            href={`/agents/${encodeURIComponent(a.runId)}/${encodeURIComponent(a.username)}`}
                            aria-label={`Inspect ${a.username}`}
                          >
                            {a.username}
                          </Link>
                        </td>
                        <td>
                          <button
                            className="run-link"
                            onClick={() => {
                              setSelected(a.runId);
                              setView("training");
                            }}
                          >
                            {a.runId.slice(0, 8)} <ArrowUpRight size={12} />
                          </button>
                        </td>
                        <td>
                          <Badge status={a.status} />
                        </td>
                        <td>{a.ticks}</td>
                        <td>{format(a.reward)}</td>
                        <td>{a.health}/20</td>
                        <td>{a.food === undefined ? "—" : `${a.food}/20`}</td>
                        <td
                          title={Object.entries(a.inventory ?? {})
                            .map(([item, count]) => `${item} ×${count}`)
                            .join(", ")}
                        >
                          {Object.entries(a.inventory ?? {})
                            .slice(0, 4)
                            .map(([item, count]) => `${item} ×${count}`)
                            .join(", ") || "Empty"}
                          {Object.keys(a.inventory ?? {}).length > 4
                            ? " …"
                            : ""}
                        </td>
                        <td className="mono">
                          {a.position
                            ? [a.position.x, a.position.y, a.position.z]
                                .map((coordinate) => coordinate.toFixed(1))
                                .join(", ")
                            : "—"}
                        </td>
                        <td>
                          <button
                            className="run-link"
                            disabled={
                              busy ||
                              !online ||
                              !["active", "paused"].includes(a.status) ||
                              data?.runs.find((run) => run.id === a.runId)?.spec
                                .mode !== "minecraft"
                            }
                            onClick={() =>
                              void act(`runs/${a.runId}/watch`, {
                                username: a.username,
                              })
                            }
                          >
                            Watch as ChilledVibe
                          </button>
                          <Link
                            className="run-link"
                            href={`/agents/${encodeURIComponent(a.runId)}/${encodeURIComponent(a.username)}`}
                          >
                            View state & perspective <ArrowUpRight size={12} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!agents.length && (
                  <div className="empty">
                    <Users size={28} />
                    <h3>No agents running</h3>
                    <p>
                      Agents are created automatically when a queued run starts.
                    </p>
                  </div>
                )}
              </div>
            </section>
          )}
          {view === "server" && (
            <>
              <section className="panel server-panel">
                <div className="server-visual">
                  <MinecraftIcon name="furnace" size={54} />
                </div>
                <div>
                  <h2>Managed Minecraft server</h2>
                  <p>Isolated managed runtime</p>
                  <Badge status={data?.server.status ?? "stopped"} />
                  {data?.server.error && (
                    <p className="error-text">{data.server.error}</p>
                  )}
                </div>
                <div className="server-actions">
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !online ||
                      data?.preparation?.status === "running" ||
                      ["running", "starting", "stopping"].includes(
                        data?.server.status ?? "",
                      )
                    }
                    onClick={() => act("server/start")}
                  >
                    <Play size={14} /> Start server
                  </button>
                  <button
                    className="secondary"
                    disabled={
                      busy ||
                      !online ||
                      !["running", "starting"].includes(
                        data?.server.status ?? "",
                      )
                    }
                    onClick={() => act("server/stop")}
                  >
                    <Square size={14} /> Stop server
                  </button>
                </div>
              </section>
              <div className="notice">
                Prepare with <code>npm run server:prepare</code>, then accept
                the EULA in <code>runtime/server/eula.txt</code>. The original
                server and worlds remain separate.
              </div>
              <TrainingWorlds
                online={online}
                serverStatus={data?.server.status}
                act={act}
              />
              <section className="panel world-panel">
                <div className="panel-heading">
                  <div>
                    <h3>Prepare server and training plugin</h3>
                    <p>
                      Install or update the viewer protection and inventory
                      setup plugin while Minecraft is stopped.
                    </p>
                  </div>
                </div>
                <div className="form-grid">
                  <label>
                    Optional source Paper jar path
                    <input
                      value={sourceJar}
                      onChange={(e) => setSourceJar(e.target.value)}
                      placeholder="Use the existing runtime jar or default source"
                    />
                  </label>
                </div>
                <p className="world-help">
                  The source path is on the runtime machine and is used only
                  when its server jar is missing. Existing worlds and EULA
                  acceptance are preserved.
                </p>
                <div className="world-actions">
                  <button
                    className="secondary"
                    disabled={
                      busy ||
                      !online ||
                      data?.preparation?.status === "running" ||
                      ["running", "starting", "stopping"].includes(
                        data?.server.status ?? "",
                      )
                    }
                    onClick={() =>
                      act(
                        "server/prepare",
                        sourceJar.trim() ? { sourceJar: sourceJar.trim() } : {},
                      )
                    }
                  >
                    Prepare/update server
                  </button>
                  <span className="muted">
                    {data?.preparation?.status ?? "idle"}
                  </span>
                </div>
                {data?.preparation?.error && (
                  <p className="error-text">{data.preparation.error}</p>
                )}
                <p className="world-help">
                  Follow preparation messages in Logs. Start Minecraft after
                  completion to load the plugin. Starting inventory support:{" "}
                  {data?.server.setupReady ? "ready" : "not loaded"}. Arena
                  support: {data?.server.arenaReady ? "ready" : "not loaded"}.
                  Training rules support:{" "}
                  {data?.server.rulesReady ? "ready" : "not loaded"}.
                </p>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h3>Server console</h3>
                    <p>
                      TPS{" "}
                      {data?.server.tps !== undefined
                        ? format(data.server.tps)
                        : "unavailable"}{" "}
                      · send <code>tps</code> to sample Paper TPS.
                    </p>
                  </div>
                  <Terminal size={18} />
                </div>
                <div className="log-panel">
                  {(
                    data?.logs.filter((l) => l.source === "minecraft") ?? []
                  ).map((l) => (
                    <div className="log-line" key={l.id}>
                      <time>{new Date(l.at).toLocaleTimeString()}</time>
                      <span>{l.message}</span>
                    </div>
                  ))}
                </div>
                <form
                  className="console-input"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await act("server/command", { command }))
                      setCommand("");
                  }}
                >
                  <ChevronRight size={16} />
                  <input
                    aria-label="Minecraft console command"
                    placeholder="Enter a server command…"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    maxLength={1000}
                  />
                  <button
                    className="secondary"
                    disabled={
                      busy ||
                      !online ||
                      data?.server.status !== "running" ||
                      !command.trim()
                    }
                  >
                    Send command
                  </button>
                </form>
              </section>
            </>
          )}
          {view === "architecture" && (
            <Architecture runs={data?.runs ?? []} online={online} />
          )}
          {view === "datasets" && <Datasets online={online} />}
          {view === "progress" && (
            <Progress runs={data?.runs ?? []} online={online} />
          )}
          {view === "inputs" && (
            <LiveInputs agents={data?.agents ?? []} online={online} act={act} />
          )}
          {view === "logs" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Activity stream</h3>
                  <p>
                    {selected ? `Run ${selected.slice(0, 8)}` : "All sources"} ·
                    latest 150 entries
                  </p>
                </div>
                <div className="log-filters">
                  <label>
                    <Search size={14} />
                    <input
                      aria-label="Search logs"
                      placeholder="Search logs…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Log level"
                    value={level}
                    onChange={(e) => setLevel(e.target.value)}
                  >
                    <option value="all">All levels</option>
                    <option value="info">Info</option>
                    <option value="warn">Warning</option>
                    <option value="error">Error</option>
                  </select>
                  <button className="secondary" onClick={() => setSelected("")}>
                    All runs
                  </button>
                </div>
              </div>
              {logPanel()}
            </section>
          )}
          <footer>
            <span>
              <MinecraftIcon name="grass_block" size={18} /> RLCraft V2
            </span>
            <span>Local orchestration. Room to grow.</span>
            <span>Telemetry refreshes every 2 seconds</span>
          </footer>
        </div>
      </main>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-title"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) setModal(false);
            }}
          >
            <div className="panel-heading">
              <div>
                <div className="eyebrow">NEW EXPERIMENT</div>
                <h2 id="run-title">Configure a training run</h2>
              </div>
              <button aria-label="Close dialog" onClick={() => setModal(false)}>
                <X size={20} />
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await act("runs", spec);
                if (result) {
                  setModal(false);
                  setSelected(result.id);
                  setView("training");
                }
              }}
            >
              <div className="form-grid">
                <label>
                  Training stage
                  <select
                    autoFocus
                    value={spec.stage}
                    onChange={(e) =>
                      setSpec({ ...spec, stage: e.target.value as StageId })
                    }
                  >
                    {(data?.stages ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Environment
                  <select
                    value={spec.mode}
                    onChange={(e) =>
                      setSpec({
                        ...spec,
                        mode: e.target.value as RunSpec["mode"],
                        backend: undefined,
                      })
                    }
                  >
                    <option value="simulator">
                      Simulator · no visible Minecraft agents
                    </option>
                    <option value="minecraft">
                      Minecraft · live connection
                    </option>
                  </select>
                </label>
                <label className="full">
                  Component
                  <select
                    value={spec.component}
                    onChange={(e) =>
                      setSpec({
                        ...spec,
                        component: e.target.value as RunSpec["component"],
                      })
                    }
                  >
                    <option value="pipeline">
                      Full pipeline · environment + policy + trainer
                    </option>
                    <option value="environment">
                      Environment connectivity check
                    </option>
                    <option value="evaluation">
                      Evaluation · policy without trainer updates
                    </option>
                  </select>
                </label>
                {(
                  [
                    {
                      key: "agents",
                      label: "Agents",
                      min: 1,
                      max: data?.capacity.maxAgents ?? 16,
                    },
                    {
                      key: "episodes",
                      label: "Generations (episodes)",
                      min: 1,
                      max: 100000,
                    },
                    {
                      key: "tickMs",
                      label: "Base step interval (ms)",
                      min: 20,
                      max: 5000,
                    },
                    {
                      key: "seed",
                      label: "Random seed",
                      min: 0,
                      max: 2147483647,
                    },
                  ] as const
                ).map((f) => (
                  <label key={f.key}>
                    {f.label}
                    <input
                      type="number"
                      required
                      min={f.min}
                      max={f.max}
                      value={spec[f.key]}
                      onChange={(e) =>
                        setSpec({ ...spec, [f.key]: Number(e.target.value) })
                      }
                    />
                  </label>
                ))}
              </div>
              <PlaybackSetup value={spec} onChange={setSpec} />
              <BackendSelector
                mode={spec.mode}
                value={spec.backend}
                inputs={spec.inputs}
                onChange={(backend) => {
                  const inputs = structuredClone(spec.inputs ?? defaultInputs);
                  if (backend === "fabric")
                    inputs.channels["vision.rgb"].enabled = true;
                  setSpec({
                    ...spec,
                    backend,
                    inputs,
                    ...(backend === "fabric" ? { agents: 1 } : {}),
                  });
                }}
              />
              {spec.backend === "fabric" && (
                <FabricSettings
                  value={spec.render}
                  onChange={(render) => setSpec({ ...spec, render })}
                  act={act}
                />
              )}
              <InputEditor
                value={spec.inputs}
                onChange={(inputs) => setSpec({ ...spec, inputs })}
              />
              <TrainingRulesEditor
                value={spec.rules}
                onChange={(rules) => setSpec({ ...spec, rules })}
                minecraft={spec.mode === "minecraft"}
              />
              <section className="setup-run">
                <h3>Starting inventory and agent state</h3>
                <AgentSetupEditor
                  value={spec.setup}
                  onChange={(setup) => setSpec({ ...spec, setup })}
                  act={act}
                  online={online}
                  idPrefix="run-setup"
                />
              </section>
              <div className="notice">
                {spec.mode === "simulator"
                  ? "Simulator checks lifecycle and telemetry. No Minecraft connection or AI learning."
                  : "Spawns real players on the managed Minecraft server. Each generation restores the starting state and position by default; arenas can also restore blocks, containers and mobs. Watch agents as ChilledVibe. Policies remain idle until implemented."}
              </div>
              <section className="setup-run">
                <h3>Training arena and structures</h3>
                <ArenaEditor
                  value={spec.arena}
                  onChange={(arena) =>
                    setSpec({
                      ...spec,
                      arena,
                      ...(arena
                        ? {
                            mode: "minecraft" as const,
                            backend:
                              spec.mode === "minecraft"
                                ? spec.backend
                                : undefined,
                          }
                        : {}),
                    })
                  }
                  act={act}
                  online={online}
                  idPrefix="run-arena"
                  agents={spec.agents}
                />
              </section>
              {spec.arena && (
                <div className="notice">
                  Arena configuration is copied into this run. Preset edits will
                  not change queued experiments. Requires the managed server
                  with arena support ready.
                </div>
              )}
              {error && (
                <p className="error-text" role="alert">
                  {error}
                </p>
              )}
              <div className="modal-footer">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setModal(false)}
                >
                  Cancel
                </button>
                <button className="primary" disabled={busy || !online}>
                  <Play size={15} />
                  {busy ? "Starting…" : "Queue run"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
