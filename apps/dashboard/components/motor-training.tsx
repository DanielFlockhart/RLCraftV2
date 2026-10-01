"use client";
import { useEffect, useState } from "react";
import { Play, Square } from "lucide-react";
import type { Run } from "@mlcraft/core";
import { motorSessions } from "../../../packages/core/src/motor-sessions";

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
}: {
  runs: Run[];
  online: boolean;
  act: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const [world, setWorld] = useState<WorldStatus>();
  const [agents, setAgents] = useState(4);
  const [episodes, setEpisodes] = useState(24);
  const [ticksPerEpisode, setTicksPerEpisode] = useState(80);
  const [tickMs, setTickMs] = useState(100);
  const [seed, setSeed] = useState(42);
  const [backend, setBackend] = useState<"mineflayer" | "fabric">("mineflayer");
  const [busy, setBusy] = useState(false);
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
  return (
    <section className="motor-training">
      <div className="panel">
        <h3>Motor training · NEAT + reinforcement learning</h3>
        <p>
          Each agent learns from target progress in a separate barrier bounded
          arena. Generations evolve graph topology and connection weights from
          actual Minecraft rewards.
        </p>
        <p>
          <strong>Inputs:</strong> target Δx/Δy/Δz, velocity x/y/z, yaw, pitch,
          on ground, and available local depth.
        </p>
        <p>
          <strong>Actions:</strong> forward, back, left, right, jump, sprint,
          yaw delta, pitch delta.
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
              max={backend === "fabric" ? 2 : 16}
              value={agents}
              onChange={(event) => setAgents(Number(event.target.value))}
            />
          </label>
          <label>
            Generations / evaluations{" "}
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
                setAgents(Math.min(agents, value === "fabric" ? 2 : 16));
              }}
            >
              <option value="mineflayer">Protocol agents</option>
              <option value="fabric">Fabric RGB agents</option>
            </select>
          </label>
        </div>
        <p>
          For full population coverage, use at least{" "}
          {Math.ceil(Math.max(8, agents) / Math.max(1, agents))} episodes.
          Fabric clients are limited by renderer capacity.
        </p>
      </div>
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
                  Requires a completed M7 generation and a different terrain
                  seed.
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
                    agents < 1 ||
                    (backend === "fabric" && agents > 2)
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
