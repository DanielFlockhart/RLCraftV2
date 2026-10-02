"use client";
import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Run } from "@mlcraft/core";
import { combatSessions, combatSetup } from "../../../packages/core/src/combat";
import { CombatFullRunPanel } from "./combat-full-run";

type WorldStatus = { ready: boolean; server: string; reason: string };
const terminal = new Set(["completed", "interrupted", "failed", "cancelled"]);
function jsonl<T>(body: string): T[] {
  return body
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}
function CombatChart({
  rows,
  field,
  label,
  color,
}: {
  rows: Array<Record<string, number>>;
  field: string;
  label: string;
  color: string;
}) {
  return (
    <div className="chart">
      {rows.length ? (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 10, right: 15, left: -15, bottom: 0 }}
          >
            <CartesianGrid
              stroke="#25332f"
              vertical={false}
              strokeDasharray="3 5"
            />
            <XAxis dataKey="episode" stroke="#788b82" fontSize={10} />
            <YAxis stroke="#788b82" fontSize={10} />
            <Tooltip
              contentStyle={{
                background: "#17231d",
                border: "1px solid #35483c",
              }}
            />
            <Line
              dataKey={field}
              name={label}
              type="monotone"
              stroke={color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <p className="chart-empty">Waiting for completed trials…</p>
      )}
    </div>
  );
}

export function CombatTraining({
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
  const combatRuns = runs.filter((run) => run.spec.stage === "pvp");
  const current = combatRuns.find((run) =>
    ["running", "queued", "paused", "pausing"].includes(run.status),
  );
  const otherMinecraftActive = runs.some(
    (run) =>
      run.spec.mode === "minecraft" &&
      run.spec.stage !== "pvp" &&
      ["running", "queued", "paused", "pausing"].includes(run.status),
  );
  const [world, setWorld] = useState<WorldStatus>();
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState(Math.min(32, maxAgents));
  const [episodes, setEpisodes] = useState(64);
  const [ticksPerEpisode, setTicksPerEpisode] = useState(120);
  const [tickMs, setTickMs] = useState(100);
  const [seed, setSeed] = useState(42);
  const [sourceRunId, setSourceRunId] = useState("");
  const [resumeRunId, setResumeRunId] = useState("");
  const [additionalEpisodes, setAdditionalEpisodes] = useState(64);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [trials, setTrials] = useState<
    Array<{ episode: number; winRate: number; kills: number }>
  >([]);
  const [evolutions, setEvolutions] = useState<
    Array<{ episode: number; bestFitness: number; species: number; generationBestWins?: number }>
  >([]);
  const [episodesHistory, setEpisodesHistory] = useState<
    Array<{ episode: number; reward: number }>
  >([]);
  const selected =
    combatRuns.find((run) => run.id === selectedRunId) ?? combatRuns[0];
  useEffect(() => {
    if (!online) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch("/api/control/phase3d/world", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) setWorld(await response.json());
        if (selected) {
          const base = `/api/control/runs/${selected.id}/artifacts/`;
          const [trialsResponse, evolutionResponse, episodesResponse] =
            await Promise.all([
              fetch(base + "combat-trials.jsonl", {
                cache: "no-store",
                signal: controller.signal,
              }),
              fetch(base + "evolution.jsonl", {
                cache: "no-store",
                signal: controller.signal,
              }),
              fetch(base + "episodes.jsonl", {
                cache: "no-store",
                signal: controller.signal,
              }),
            ]);
          if (trialsResponse.ok) setTrials(jsonl(await trialsResponse.text()));
          if (evolutionResponse.ok)
            setEvolutions(jsonl(await evolutionResponse.text()));
          if (episodesResponse.ok)
            setEpisodesHistory(
              jsonl<{
                episode: number;
                agents: Array<{ reward: number }>;
              }>(await episodesResponse.text()).map((row) => ({
                episode: row.episode,
                reward:
                  row.agents.reduce((sum, agent) => sum + agent.reward, 0) /
                  Math.max(1, row.agents.length),
              })),
            );
        }
      } catch {}
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [online, selected?.id]);
  const eligibleSources = combatRuns.filter(
    (run) =>
      run.status === "completed" &&
      run.spec.agents === agents &&
      run.spec.seed === seed,
  );
  const source = eligibleSources.find((run) => run.id === sourceRunId);
  const resumable = combatRuns.filter((run) => terminal.has(run.status));
  const resume =
    resumable.find((run) => run.id === resumeRunId) ?? resumable[0];
  const retryFullRun = !!resume?.spec.combatFullRunId &&
    ["failed", "cancelled"].includes(resume.status) && resume.episode === 0;
  async function perform(path: string, body: unknown = {}) {
    setBusy(true);
    try {
      await act(path, body);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="motor-training combat-training">
      <div className="panel">
        <h3>Combat training · NEAT in Minecraft</h3>
        <p>
          Each agent fights separately in a 3D arena. {combatSessions.length}{" "}
          sessions change the opponent, weapon, armor and shield. Every genome
          receives three trials before NEAT evolves the population.
        </p>
        <p>
          <strong>Inputs:</strong> mob type and temperament, multiple opponents,
          movement and special status, player health, equipment, attack
          cooldown, pose and local geometry. <strong>Actions:</strong> movement,
          aim, melee attack, shield block and item use.
        </p>
        <button
          type="button"
          disabled={
            !online || busy || !!current || otherMinecraftActive || world?.ready
          }
          onClick={() => perform("phase3d/world")}
        >
          Prepare combat world
        </button>
        <span role="status">
          {" "}
          {world?.ready
            ? "Combat world ready"
            : (world?.reason ?? "Checking combat world…")}
        </span>
        {otherMinecraftActive && (
          <p role="status">
            Stop the active Minecraft training run before switching to the
            combat world.
          </p>
        )}
      </div>
      <div className="panel">
        <h3>Training settings</h3>
        <div className="input-limit-grid">
          <label>
            <span>Agents</span>
            <input
              type="number"
              min={1}
              max={maxAgents}
              value={agents}
              onChange={(event) => setAgents(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Trial episodes</span>
            <input
              type="number"
              min={1}
              max={100000}
              value={episodes}
              onChange={(event) => setEpisodes(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Steps per trial</span>
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
            <span>Step interval (ms)</span>
            <input
              type="number"
              min={20}
              max={5000}
              value={tickMs}
              onChange={(event) => setTickMs(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Training seed</span>
            <input
              type="number"
              min={0}
              max={2147483647}
              value={seed}
              onChange={(event) => setSeed(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Transfer complete population from</span>
            <select
              value={sourceRunId}
              onChange={(event) => setSourceRunId(event.target.value)}
            >
              <option value="">Start a new population</option>
              {eligibleSources.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.spec.combat} · {run.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {source && (
          <p>
            All genomes, species and network structure carry forward from{" "}
            {source.spec.combat}. Fitness resets for the new combat session.
          </p>
        )}
      </div>
      <CombatFullRunPanel
        runs={runs}
        online={online}
        act={act}
        agents={agents}
        seed={seed}
        tickMs={tickMs}
      />
      <div className="panel">
        <h3>Continue from checkpoint</h3>
        <div className="input-limit-grid">
          <label>
            <span>Previous run</span>
            <select
              value={resume?.id ?? ""}
              onChange={(event) => setResumeRunId(event.target.value)}
            >
              {!resumable.length && (
                <option value="">No previous combat runs</option>
              )}
              {resumable.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.spec.combat} · {run.id.slice(0, 8)} · {run.status}
                </option>
              ))}
            </select>
          </label>
          {!retryFullRun && <label>
            <span>Additional trials</span>
            <input
              type="number"
              min={1}
              max={100000}
              value={additionalEpisodes}
              onChange={(event) =>
                setAdditionalEpisodes(Number(event.target.value))
              }
            />
          </label>}
        </div>
        <button
          type="button"
          disabled={!online || busy || !!current || !resume}
          onClick={() =>
            resume &&
            perform("phase3d/resume", { runId: resume.id, additionalEpisodes })
          }
        >
          {retryFullRun ? `Resume Full Run at ${resume?.spec.combat}` : "Continue full population"}
        </button>
        {retryFullRun && <p>This stage has no checkpoint yet. The Full Run will retry it from the previous completed stage's full population.</p>}
      </div>
      {combatRuns.length > 0 && (
        <div className="panel">
          <h3>Combat performance</h3>
          <label>
            Run{" "}
            <select
              value={selected?.id ?? ""}
              onChange={(event) => setSelectedRunId(event.target.value)}
            >
              {combatRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.spec.combat} · {run.id.slice(0, 8)} · {run.status}
                </option>
              ))}
            </select>
          </label>
          <p>
            These graphs use completed trial results, including trials saved
            before reopening the dashboard.
          </p>
          <div className="stage-grid">
            <div>
              <h4>Trial win rate</h4>
              <CombatChart
                rows={trials}
                field="winRate"
                label="Win rate"
                color="#72e0ac"
              />
            </div>
            <div>
              <h4>Population reward</h4>
              <CombatChart
                rows={episodesHistory}
                field="reward"
                label="Reward"
                color="#e8b875"
              />
            </div>
            <div>
              <h4>Best verified wins per generation</h4>
              <CombatChart
                rows={evolutions.filter((row) => row.generationBestWins !== undefined)}
                field="generationBestWins"
                label="Training wins"
                color="#72e0ac"
              />
            </div>
            <div>
              <h4>Best fitness</h4>
              <CombatChart
                rows={evolutions}
                field="bestFitness"
                label="Best fitness"
                color="#b4a0f5"
              />
            </div>
            <div>
              <h4>Species</h4>
              <CombatChart
                rows={evolutions}
                field="species"
                label="Species"
                color="#79c9ef"
              />
            </div>
          </div>
        </div>
      )}
      <div className="stage-grid">
        {combatSessions.map((session) => {
          const active =
            current?.spec.combat === session.id ? current : undefined;
          const latest = combatRuns.find(
            (run) => run.spec.combat === session.id,
          );
          const loadout = combatSetup(session.id)
            .items.map((item) =>
              item.item.replace("minecraft:", "").replaceAll("_", " "),
            )
            .join(", ");
          return (
            <section className="stage-card" key={session.id}>
              <div className="stage-top">
                <span className="stage-number">{session.id}</span>
                <span>{active?.status ?? latest?.status ?? "Ready"}</span>
              </div>
              <h3>{session.name}</h3>
              <p>{session.detail}</p>
              <small>
                Opponent: {session.mob}
                {"secondMob" in session
                  ? ` + ${session.secondMob}`
                  : "count" in session
                    ? ` × ${session.count}`
                    : ""}
              </small>
              <small>Loadout: {loadout || "unarmed"}</small>
              {latest && (
                <small>
                  Latest run {latest.id.slice(0, 8)} · {latest.status}
                </small>
              )}
              {active ? (
                <div className="input-actions">
                  <button
                    onClick={() =>
                      perform(
                        `runs/${active.id}/${active.status === "paused" ? "resume" : "pause"}`,
                      )
                    }
                    disabled={busy}
                  >
                    {active.status === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button
                    onClick={() => perform(`runs/${active.id}/cancel`)}
                    disabled={busy}
                  >
                    Stop
                  </button>
                </div>
              ) : (
                <button
                  disabled={
                    !online ||
                    busy ||
                    !!current ||
                    otherMinecraftActive ||
                    agents < 1 ||
                    agents > maxAgents
                  }
                  onClick={() =>
                    perform("phase3d/sessions", {
                      session: session.id,
                      agents,
                      episodes,
                      ticksPerEpisode,
                      tickMs,
                      seed,
                      ...(source ? { sourceRunId: source.id } : {}),
                    })
                  }
                >
                  Train {session.id}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
