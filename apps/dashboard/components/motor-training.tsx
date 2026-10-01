"use client";
import { useEffect, useState } from "react";
import { Play, Square } from "lucide-react";
import type { MotorFullRun, Run } from "@mlcraft/core";
import { motorSessions } from "../../../packages/core/src/motor-sessions";
import { motorArena, motorTrialPlan } from "../../../packages/core/src/motor";
import {
  ARENA_BLOCK_BUDGET,
  arenaBlockCount,
} from "../../../packages/core/src/arenas";
import { MotorTelemetry } from "./motor-telemetry";
import { MotorFullRunPanel } from "./motor-full-run";

type WorldStatus = {
  ready: boolean;
  profile?: string;
  server: string;
  reason: string;
};
export function MotorTraining({
  runs,
  online,
  act,
  maxAgents,
}: {
  runs: Run[];
  online: boolean;
  act: (path: string, body?: unknown) => Promise<unknown>;
  maxAgents: number;
}) {
  const [world, setWorld] = useState<WorldStatus>();
  const [agents, setAgents] = useState(Math.min(32, maxAgents));
  const [episodes, setEpisodes] = useState(64);
  const [ticksPerEpisode, setTicksPerEpisode] = useState(80);
  const [tickMs, setTickMs] = useState(100);
  const [seed, setSeed] = useState(42);
  const [backend, setBackend] = useState<"mineflayer" | "fabric">("mineflayer");
  const [busy, setBusy] = useState(false);
  const [renderLimit, setRenderLimit] = useState(2);
  const [fullRuns, setFullRuns] = useState<MotorFullRun[]>([]);
  const [fullRunAvailable, setFullRunAvailable] = useState(false);
  const [resumeRunId, setResumeRunId] = useState("");
  const [additionalEpisodes, setAdditionalEpisodes] = useState(64);
  useEffect(() => {
    if (!online) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch("/api/control/phase3a/world", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.ok) setWorld(await response.json());
        const clients = await fetch("/api/control/clients", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (clients.ok) {
          const status = (await clients.json()) as { maxClients?: number };
          if (status.maxClients) setRenderLimit(status.maxClients);
        }
        const plans = await fetch("/api/control/phase3a/full-runs", {
          signal: controller.signal,
          cache: "no-store",
        });
        setFullRunAvailable(plans.ok);
        if (plans.ok) setFullRuns(await plans.json());
      } catch {}
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [online]);
  const current = runs.filter(
    (run) =>
      run.spec.stage === "motor" &&
      ["running", "queued", "paused", "pausing"].includes(run.status),
  );
  const fullRunActive = fullRuns.some((plan) => ["running", "paused"].includes(plan.status));
  const resumableRuns = runs.filter((run) =>
    run.spec.stage === "motor" && run.spec.component === "pipeline" &&
    ["completed", "interrupted", "failed", "cancelled"].includes(run.status),
  );
  const selectedResumeRun = resumableRuns.find((run) => run.id === resumeRunId)
    ?? resumableRuns[0];
  const arenaCellBlocks = Math.max(
    ...motorSessions.map((session) =>
      arenaBlockCount(motorArena(session.id, seed), 1),
    ),
  );
  const arenaLimit = Math.floor(ARENA_BLOCK_BUDGET / arenaCellBlocks);
  const trialPlan = motorTrialPlan(1, Math.max(1, agents));
  const effectiveLimit = Math.min(
    maxAgents,
    arenaLimit,
    backend === "fabric" ? renderLimit : Infinity,
  );
  useEffect(() => {
    setAgents((current) => Math.min(current, effectiveLimit));
  }, [effectiveLimit]);
  return (
    <section className="motor-training">
      <div className="panel">
        <h3>Motor training · NEAT + reinforcement learning</h3>
        <p>
          Each agent learns from target progress in a separate barrier bounded
          arena. M0–M7 evaluate each genome on three shared seeded trials before
          NEAT evolves its graph and weights. M8 evaluates the frozen M7
          champion on a different terrain seed.
        </p>
        <p>
          <strong>Inputs:</strong> target direction and distance in world and
          agent coordinates, velocity, orientation, ground and jump state,
          water and collision state, and available local depth.
        </p>
        <p>
          <strong>Actions:</strong> forward, back, left, right, jump, sprint,
          sneak, yaw delta, pitch delta.
        </p>
        <div className="input-actions">
          <button
            type="button"
            disabled={!online || busy || !!current.length || world?.ready}
            onClick={async () => {
              setBusy(true);
              try {
                await act("phase3a/world", {});
              } finally {
                setBusy(false);
              }
            }}
          >
            Prepare motor superflat world
          </button>
          <span role="status">
            {world?.ready
              ? "Motor superflat world ready"
              : (world?.reason ?? "Checking world…")}
          </span>
        </div>
      </div>
      <div className="panel">
        <h3>Training settings</h3>
        <div className="input-limit-grid">
          <label>
            Agents{" "}
            <input
              type="number"
              min={1}
              max={effectiveLimit}
              value={agents}
              onChange={(event) => setAgents(Number(event.target.value))}
            />
          </label>
          <label>
            Trial episodes{" "}
            <input
              type="number"
              min={1}
              max={100000}
              value={episodes}
              onChange={(event) => setEpisodes(Number(event.target.value))}
            />
          </label>
          <label>
            Steps per episode{" "}
            <input
              type="number"
              min={1}
              max={100000}
              value={ticksPerEpisode}
              onChange={(event) =>
                setTicksPerEpisode(Number(event.target.value))
              }
            />
          </label>
          <label>
            Step interval (ms){" "}
            <input
              type="number"
              min={20}
              max={5000}
              value={tickMs}
              onChange={(event) => setTickMs(Number(event.target.value))}
            />
          </label>
          <label>
            Terrain seed{" "}
            <input
              type="number"
              min={0}
              max={2147483647}
              value={seed}
              onChange={(event) => setSeed(Number(event.target.value))}
            />
          </label>
          <label>
            Agent client{" "}
            <select
              value={backend}
              onChange={(event) => {
                const value = event.target.value as "mineflayer" | "fabric";
                setBackend(value);
                setAgents(
                  Math.min(
                    agents,
                    maxAgents,
                    arenaLimit,
                    value === "fabric" ? renderLimit : Infinity,
                  ),
                );
              }}
            >
              <option value="mineflayer">Protocol agents</option>
              <option value="fabric">Fabric RGB agents</option>
            </select>
          </label>
        </div>
        <p>
          The largest isolated session arena uses{" "}
          {arenaCellBlocks.toLocaleString()} blocks, including its floor, walls
          and roof. The {ARENA_BLOCK_BUDGET.toLocaleString()}-block preparation
          budget allows {arenaLimit} agents here; the configured global limit is{" "}
          {maxAgents}
          {backend === "fabric"
            ? ` and the rendered-client limit is ${renderLimit}`
            : ""}
          .
        </p>
        <p>
          For M0–M7, {trialPlan.episodesPerEvolution} trial episodes complete
          one NEAT evolution with {agents} agents. This run can complete{" "}
          {Math.floor(episodes / trialPlan.episodesPerEvolution)} full
          evolutions; extra episodes evaluate the next population without
          evolving it. Fabric clients are limited by renderer capacity.
        </p>
      </div>
      <div className="panel motor-viewer-help">
        <h3>In-world training markers</h3>
        <p>
          Protected admin viewers see a green particle beacon at each agent's
          current target and a blue ring at its spawn. These are sent only to
          viewer clients; no blocks or entities are placed in the training
          arena. Spectate an agent or fly near its arena to see them.
        </p>
      </div>
      <MotorFullRunPanel
        plans={fullRuns} runs={runs} online={online} available={fullRunAvailable} act={act} busy={busy}
        onPlanChanged={(plan) => setFullRuns((current) => [plan, ...current.filter((entry) => entry.id !== plan.id)])}
        maxAgents={maxAgents} renderLimit={renderLimit}
        defaults={{ agents, episodes, ticksPerEpisode, tickMs, seed, backend }}
      />
      <div className="panel">
        <h3>Continue a previous population</h3>
        <p>
          Restore the saved genomes, species, unfinished trial scores and NEAT
          random state from a previous M0–M7 run. The continuation is a new run
          linked to its source. Its world generation and training settings must
          still match. Older checkpoints keep the whole population but restart
          its current evolution from a fresh trial round because they did not
          save partial trial and random state.
          The performance charts also include the source run's saved history.
        </p>
        <div className="input-limit-grid">
          <label>
            Checkpoint run{" "}
            <select value={selectedResumeRun?.id ?? ""} onChange={(event) => setResumeRunId(event.target.value)}>
              {resumableRuns.length === 0 && <option value="">No previous runs</option>}
              {resumableRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.spec.motor} · {run.id.slice(0, 8)} · {run.status}
                </option>
              ))}
            </select>
          </label>
          <label>
            Additional trial episodes{" "}
            <input type="number" min={1} max={100000} value={additionalEpisodes}
              onChange={(event) => setAdditionalEpisodes(Number(event.target.value))} />
          </label>
        </div>
        <button type="button" disabled={!online || busy || fullRunActive || !!current.length || !selectedResumeRun ||
          !Number.isInteger(additionalEpisodes) || additionalEpisodes < 1}
          onClick={async () => {
            if (!selectedResumeRun) return;
            setBusy(true);
            try {
              await act("phase3a/resume", {
                runId: selectedResumeRun.id,
                additionalEpisodes,
              });
            } finally {
              setBusy(false);
            }
          }}>
          <Play size={14} /> Continue training
        </button>
      </div>
      <MotorTelemetry runs={runs} online={online} />
      <div className="stage-grid">
        {motorSessions.map((session) => {
          const active = current.find((run) => run.spec.motor === session.id);
          const latest = runs.find(
            (run) =>
              run.spec.stage === "motor" && run.spec.motor === session.id,
          );
          return (
            <section className="stage-card" key={session.id}>
              <div className="stage-top">
                <span className="stage-number">{session.id}</span>
                <span>{active?.status ?? latest?.status ?? "Ready"}</span>
              </div>
              <h3>{session.name}</h3>
              <p>{session.detail}</p>
              {session.id === "M8" && (
                <small>
                  Frozen evaluation of an evolved M7 champion on a different
                  terrain seed. No M8 evolution occurs.
                </small>
              )}
              {latest && (
                <small>
                  Latest run {latest.id.slice(0, 8)} · {latest.status}
                </small>
              )}
              {active ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(`runs/${active.id}/cancel`, {})}
                >
                  <Square size={14} /> Stop session
                </button>
              ) : (
                <button
                  type="button"
                  disabled={
                    !online ||
                    busy ||
                    !!current.length ||
                    fullRunActive ||
                    agents < 1 ||
                    agents > effectiveLimit
                  }
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await act("phase3a/sessions", {
                        session: session.id,
                        agents,
                        episodes,
                        ticksPerEpisode,
                        tickMs,
                        seed,
                        backend,
                      });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Play size={14} /> Run {session.id}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
