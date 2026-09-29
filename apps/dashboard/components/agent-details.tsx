"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import type { AgentState, LogEntry, Run } from "@rlcraft/core";
import { AgentFeed } from "./fabric";
import { LiveInputs } from "./inputs";
import { Badge, format } from "./telemetry";
import { MinecraftIcon, stageIcons } from "./minecraft-icon";

type Details = { run: Run; agents: AgentState[]; logs: LogEntry[] };

export function AgentDetails({
  runId,
  username,
}: {
  runId: string;
  username: string;
}) {
  const [detail, setDetail] = useState<Details>();
  const [online, setOnline] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(
          `/api/control/runs/${encodeURIComponent(runId)}`,
          {
            signal: controller.signal,
            cache: "no-store",
          },
        );
        const result = await response.json();
        if (!response.ok) {
          if (response.status === 404 && !stopped) setDetail(undefined);
          throw new Error(result.error ?? "Agent state is unavailable.");
        }
        if (!stopped) {
          setDetail(result);
          setOnline(true);
          setError("");
        }
      } catch (error) {
        if (!stopped) {
          setOnline(false);
          setError((error as Error).message);
        }
      } finally {
        if (!stopped) setLoaded(true);
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId]);
  const agent = detail?.agents.find(
    (entry) => entry.runId === runId && entry.username === username,
  );
  const run = detail?.run;
  const connected =
    !!agent && ["active", "paused", "dead", "resetting"].includes(agent.status);
  return (
    <main className="agent-detail-page">
      <Link className="agent-back-link" href="/?view=agents">
        <ArrowLeft size={16} /> Back to agent fleet
      </Link>
      <header className="agent-detail-heading">
        <MinecraftIcon
          name={run ? stageIcons[run.spec.stage] : "compass"}
          size={40}
        />
        <div>
          <p>Agent inspector</p>
          <h1>{username}</h1>
          <p>
            {run
              ? `${run.spec.stage} · ${run.backend?.descriptor.label ?? run.spec.backend ?? run.spec.mode}`
              : "Loading run…"}{" "}
            · {runId.slice(0, 8)}
          </p>
        </div>
        {agent && <Badge status={agent.status} />}
      </header>
      {error && (
        <div className="notice" role="status">
          {error}
          {detail
            ? " Showing the last received state; live updates are unavailable."
            : ""}
        </div>
      )}
      {!loaded && (
        <section className="panel agent-detail-card" role="status">
          Loading agent state…
        </section>
      )}
      {loaded && !agent && !error && (
        <section className="panel agent-detail-card" role="status">
          This agent is not available in this run. It may not have connected
          yet.
        </section>
      )}
      {agent && run && (
        <>
          {!connected && (
            <div className="notice" role="status">
              This agent is {agent.status}. Its last worker-reported state
              remains below; live perspective and inputs require a connected
              agent.
            </div>
          )}
          {agent.error && (
            <div className="notice" role="alert">
              {agent.error}
            </div>
          )}
          <div className="agent-detail-grid">
            {connected ? (
              <AgentFeed agent={agent} online={online} />
            ) : (
              <section className="panel agent-detail-card">
                <h2>First-person perspective</h2>
                <p role="status">
                  Camera unavailable while this agent is {agent.status}.
                </p>
              </section>
            )}
            <section className="panel agent-detail-card">
              <h2>Current state</h2>
              <p className="muted">
                Worker-reported state · refreshed every second.
              </p>
              <dl className="agent-state-values">
                <dt>Health</dt>
                <dd>{format(agent.health)} / 20</dd>
                <dt>Hunger</dt>
                <dd>
                  {agent.food === undefined
                    ? "Unavailable"
                    : `${format(agent.food)} / 20`}
                </dd>
                <dt>Position (X, Y, Z)</dt>
                <dd className="mono">
                  {agent.position
                    ? [agent.position.x, agent.position.y, agent.position.z]
                        .map((value) => format(value, 2))
                        .join(", ")
                    : "Unavailable"}
                </dd>
                <dt>Training ticks</dt>
                <dd>{agent.ticks.toLocaleString()}</dd>
                <dt>Reward</dt>
                <dd>{format(agent.reward, 3)}</dd>
                <dt>Generation</dt>
                <dd>
                  {run.episode} / {run.spec.episodes}
                </dd>
                <dt>Generation step</dt>
                <dd>
                  {run.timing
                    ? `${run.timing.tick} / ${run.timing.ticks}`
                    : "Unavailable"}
                </dd>
                <dt>Active training time</dt>
                <dd>
                  {run.timing?.trainingElapsedMs === undefined
                    ? "Unavailable"
                    : `${format(run.timing.trainingElapsedMs / 1000)}s`}
                </dd>
                <dt>Run status</dt>
                <dd>
                  <Badge status={run.status} />
                </dd>
              </dl>
              <h3>Inventory</h3>
              {agent.inventory === undefined ? (
                <p className="muted">Inventory unavailable.</p>
              ) : Object.keys(agent.inventory).length ? (
                <ul className="agent-inventory-list">
                  {Object.entries(agent.inventory).map(([item, count]) => (
                    <li key={item}>
                      <span>
                        {item.replace(/^minecraft:/, "").replaceAll("_", " ")}
                      </span>
                      <strong>×{count}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Empty inventory.</p>
              )}
              <details className="agent-raw-state">
                <summary>Full worker state</summary>
                <pre>{JSON.stringify(agent, null, 2)}</pre>
              </details>
            </section>
          </div>
          <section className="agent-detail-inputs">
            <h2>Live player inputs</h2>
            <p className="muted">
              The channels enabled for this agent, including their availability
              and sampled state.
            </p>
            <LiveInputs
              agents={[agent]}
              online={online}
              selectedAgentId={agent.id}
              embedded
            />
          </section>
          <section className="panel agent-detail-card">
            <h2>Run context</h2>
            <p>
              Stage {run.spec.stage} · seed {run.spec.seed} · {run.spec.tickMs}
              ms base cadence · {run.spec.agents} agent
              {run.spec.agents === 1 ? "" : "s"}
            </p>
            <Link
              className="agent-back-link"
              href={`/?view=training&run=${encodeURIComponent(runId)}`}
            >
              Open training run <ArrowUpRight size={14} />
            </Link>
            <details className="agent-raw-state">
              <summary>Recent run events</summary>
              {detail.logs.length ? (
                <ul className="agent-event-list">
                  {detail.logs.slice(-20).map((log, index) => (
                    <li key={log.id ?? index}>
                      <time>{new Date(log.at).toLocaleTimeString()}</time>
                      <span>
                        {log.level} · {log.source} · {log.message}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No recorded events.</p>
              )}
            </details>
          </section>
        </>
      )}
    </main>
  );
}
