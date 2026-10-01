"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AgentState, Metric, Run } from "@mlcraft/core";
import { motorTrialPlan } from "../../../packages/core/src/motor";
import { Chart } from "./telemetry";

type AgentSample = { at: number; episode: number; key: string } & Record<
  string,
  number | string
>;
type EvolutionRecord = { episode: number; at: number } & NonNullable<
  Metric["neat"]
>;
type TrialRecord = { episode: number; at: number } & NonNullable<
  Metric["motor"]
>;
type Located<T> = T & { runId: string };
function parseJsonl<T>(body: string): T[] {
  const lines = body.split("\n").filter(Boolean);
  return lines.flatMap((line, index) => {
    try {
      return [JSON.parse(line) as T];
    } catch (error) {
      if (index === lines.length - 1 && !body.endsWith("\n")) return [];
      throw error;
    }
  });
}
const colors = [
  "#72e0ac",
  "#e8b875",
  "#b4a0f5",
  "#79c9ef",
  "#f59da8",
  "#c6db7b",
];
const active = new Set(["running", "paused", "pausing", "queued"]);

function HistoryChart({
  data,
  xKey,
  labelKey,
  field,
  color,
  label,
  boundaries = [],
}: {
  data: Array<Record<string, number | null>>;
  xKey: string;
  labelKey: string;
  field: string;
  color: string;
  label: string;
  boundaries?: Array<{ x: number; label: string }>;
}) {
  if (!data.length)
    return (
      <div className="chart-empty">Waiting for {label.toLowerCase()}…</div>
    );
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 10, right: 12, left: -18, bottom: 0 }}
        >
          <CartesianGrid
            stroke="#25332f"
            vertical={false}
            strokeDasharray="3 5"
          />
          <XAxis
            dataKey={xKey}
            stroke="#788b82"
            fontSize={10}
            tickFormatter={(value) =>
              String(data[Number(value) - 1]?.[labelKey] ?? value)
            }
          />
          <YAxis stroke="#788b82" fontSize={10} />
          <Tooltip
            contentStyle={{
              background: "#17231d",
              border: "1px solid #35483c",
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value) => [Number(value).toFixed(2), label]}
            labelFormatter={(value) =>
              `${labelKey === "episode" ? "Episode" : "Generation"} ${data[Number(value) - 1]?.[labelKey] ?? value}`
            }
          />
          {boundaries.map((boundary) => (
            <ReferenceLine
              key={`${boundary.x}-${boundary.label}`}
              x={boundary.x}
              stroke="#aab8ad"
              strokeDasharray="4 4"
              label={{ value: boundary.label, fill: "#cbd8cf", fontSize: 10 }}
            />
          ))}
          <Line
            dataKey={field}
            name={label}
            type="monotone"
            stroke={color}
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MotorTelemetry({
  runs,
  online,
}: {
  runs: Run[];
  online: boolean;
}) {
  const motorRuns = runs.filter((run) => run.spec.stage === "motor");
  const [runId, setRunId] = useState("");
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [savedMetrics, setSavedMetrics] = useState<Metric[]>([]);
  const [historyRuns, setHistoryRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [samples, setSamples] = useState<AgentSample[]>([]);
  const [focusGeneration, setFocusGeneration] = useState(0);
  const [savedEvolutions, setSavedEvolutions] = useState<
    Located<EvolutionRecord>[]
  >([]);
  const [savedTrials, setSavedTrials] = useState<Located<TrialRecord>[]>([]);
  const [error, setError] = useState("");
  const selected =
    motorRuns.find((run) => run.id === runId) ??
    motorRuns.find((run) => active.has(run.status)) ??
    motorRuns[0];

  useEffect(() => {
    setMetrics([]);
    setSavedMetrics([]);
    setHistoryRuns([]);
    setAgents([]);
    setSamples([]);
    setFocusGeneration(0);
    setSavedEvolutions([]);
    setSavedTrials([]);
    setError("");
    if (!online || !selected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function loadHistory() {
      try {
        const chain: Run[] = [selected!];
        const visited = new Set([selected!.id]);
        while (chain[0].spec.motorResume && chain.length < 32) {
          const sourceId = chain[0].spec.motorResume;
          if (visited.has(sourceId)) break;
          visited.add(sourceId);
          const known = runs.find((run) => run.id === sourceId);
          if (known) {
            chain.unshift(known);
            continue;
          }
          const response = await fetch(`/api/control/runs/${sourceId}`, {
            signal: controller.signal,
            cache: "no-store",
          });
          if (!response.ok) break;
          const detail = (await response.json()) as { run: Run };
          chain.unshift(detail.run);
        }
        const artifact = async <T,>(id: string, name: string): Promise<T[]> => {
          const response = await fetch(
            `/api/control/runs/${id}/artifacts/${name}`,
            { signal: controller.signal, cache: "no-store" },
          );
          return response.ok ? parseJsonl<T>(await response.text()) : [];
        };
        const histories = await Promise.all(
          chain.map(async (run) => {
            const [metrics, evolutions, trials] = await Promise.all([
              artifact<Metric>(run.id, "metrics.jsonl"),
              artifact<EvolutionRecord>(run.id, "evolution.jsonl"),
              artifact<TrialRecord>(run.id, "motor-trials.jsonl"),
            ]);
            const storedMetrics = metrics.length
              ? metrics
              : await fetch(`/api/control/runs/${run.id}`, {
                  signal: controller.signal,
                  cache: "no-store",
                }).then(async (response) =>
                  response.ok
                    ? ((await response.json()) as { metrics: Metric[] }).metrics
                    : [],
                );
            const legacyEpisodes =
              trials.length && evolutions.length
                ? []
                : await artifact<{
                    episode: number;
                    at: number;
                    motor?: NonNullable<Metric["motor"]>;
                  }>(run.id, "episodes.jsonl");
            const checkpointHistory =
              evolutions.length || run.spec.motorResume
                ? []
                : await fetch(
                    `/api/control/runs/${run.id}/artifacts/checkpoint.json`,
                    {
                      signal: controller.signal,
                      cache: "no-store",
                    },
                  ).then(async (response) =>
                    response.ok
                      ? ((
                          (await response.json()) as {
                            speciesHistory?: Array<{
                              generation: number;
                              bestFitness: number;
                              generationBestFitness: number;
                              species: NonNullable<
                                Metric["neat"]
                              >["speciesDetails"];
                            }>;
                          }
                        ).speciesHistory ?? [])
                      : [],
                  );
            return {
              metrics: storedMetrics,
              evolutions: (evolutions.length
                ? evolutions
                : checkpointHistory.map((entry) => ({
                    episode:
                      entry.generation *
                      motorTrialPlan(1, run.spec.agents).episodesPerEvolution,
                    at: new Date(run.createdAt).getTime(),
                    generation: entry.generation,
                    bestFitness: entry.bestFitness,
                    generationBestFitness: entry.generationBestFitness,
                    species: entry.species?.length ?? 0,
                    population: Math.max(8, run.spec.agents),
                    speciesDetails: entry.species,
                  }))
              ).map((entry) => ({ ...entry, runId: run.id })),
              trials: (trials.length
                ? trials
                : legacyEpisodes.flatMap((record) =>
                    record.motor
                      ? [
                          {
                            episode: record.episode,
                            at: record.at,
                            ...record.motor,
                          },
                        ]
                      : [],
                  )
              ).map((entry) => ({ ...entry, runId: run.id })),
            };
          }),
        );
        if (!controller.signal.aborted) {
          setHistoryRuns(chain);
          setSavedMetrics(histories.flatMap((entry) => entry.metrics));
          setSavedEvolutions(histories.flatMap((entry) => entry.evolutions));
          setSavedTrials(histories.flatMap((entry) => entry.trials));
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      }
    }
    async function poll() {
      try {
        const response = await fetch(`/api/control/runs/${selected!.id}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Run telemetry unavailable");
        const detail = (await response.json()) as {
          metrics: Metric[];
          agents: AgentState[];
          run: Run;
        };
        if (controller.signal.aborted) return;
        setMetrics((current) => {
          const collected = new Map<string, Metric>();
          for (const metric of [...current, ...detail.metrics])
            collected.set(
              `${metric.runId}:${metric.kind ?? "sample"}:${metric.episode}:${metric.at}`,
              metric,
            );
          return [...collected.values()];
        });
        setAgents(detail.agents);
        setError("");
        if (active.has(detail.run.status) && detail.agents.length) {
          const key = `${detail.run.episode}:${detail.agents.map((agent) => `${agent.username}:${agent.ticks}:${agent.reward}`).join("|")}`;
          const sample: AgentSample = {
            at: Date.now(),
            episode: detail.run.episode,
            key,
          };
          for (const agent of detail.agents)
            sample[agent.username] = agent.reward;
          setSamples((current) =>
            current.at(-1)?.key === key
              ? current
              : [...current.slice(-179), sample],
          );
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void loadHistory();
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [online, selected?.id]);

  const metricsBySample = new Map<string, Metric>();
  for (const metric of [...savedMetrics, ...metrics])
    metricsBySample.set(
      `${metric.runId}:${metric.kind ?? "sample"}:${metric.episode}:${metric.at}`,
      metric,
    );
  const allMetrics = [...metricsBySample.values()].sort((a, b) => a.at - b.at);
  const liveMetrics = allMetrics.filter((metric) => !metric.kind);
  const trialMetrics = metrics.filter(
    (metric) => metric.kind === "motor-trial",
  );
  const evolutionMetrics = metrics.filter(
    (metric) => metric.kind === "evolution",
  );
  const trialsByEpisode = new Map<string, Located<TrialRecord>>();
  for (const trial of savedTrials)
    trialsByEpisode.set(`${trial.runId}:${trial.episode}`, trial);
  for (const metric of trialMetrics)
    if (metric.motor)
      trialsByEpisode.set(`${metric.runId}:${metric.episode}`, {
        runId: metric.runId,
        episode: metric.episode,
        at: metric.at,
        ...metric.motor,
      });
  const allTrials = [...trialsByEpisode.values()].sort(
    (a, b) => a.at - b.at || a.episode - b.episode,
  );
  const evolutionsByGeneration = new Map<string, Located<EvolutionRecord>>();
  for (const evolution of savedEvolutions)
    evolutionsByGeneration.set(
      `${evolution.runId}:${evolution.generation}`,
      evolution,
    );
  for (const metric of evolutionMetrics)
    if (metric.neat)
      evolutionsByGeneration.set(`${metric.runId}:${metric.neat.generation}`, {
        runId: metric.runId,
        episode: metric.episode,
        at: metric.at,
        ...metric.neat,
      });
  const allEvolutions = [...evolutionsByGeneration.values()].sort(
    (a, b) => a.generation - b.generation || a.at - b.at,
  );
  const latest = liveMetrics.at(-1);
  const latestTrial = allTrials.at(-1);
  const latestEvolution = allEvolutions.at(-1);
  const selectedEvolution =
    allEvolutions.find((entry) => entry.generation === focusGeneration) ??
    latestEvolution;
  const expectedEvolutions = selected
    ? selected.spec.component === "evaluation"
      ? 0
      : Math.floor(
          selected.spec.episodes /
            motorTrialPlan(1, selected.spec.agents).episodesPerEvolution,
        )
    : 0;
  const trialHistory = allTrials.map((trial, index) => ({
    point: index + 1,
    episode: trial.episode,
    successRate: trial.successRate * 100,
    meanSuccessSteps: trial.meanSuccessSteps,
  }));
  const evolutionHistory = allEvolutions.map((entry, index) => ({
    point: index + 1,
    generation: entry.generation,
    generationBestFitness: entry.generationBestFitness ?? entry.bestFitness,
    species: entry.species,
  }));
  const continuedRuns = historyRuns.slice(1);
  const metricBoundaries = continuedRuns.flatMap((run) => {
    const first = liveMetrics.find((metric) => metric.runId === run.id);
    return first
      ? [{ x: first.at, label: `Continued ${run.id.slice(0, 8)}` }]
      : [];
  });
  const trialBoundaries = continuedRuns.flatMap((run) => {
    const index = allTrials.findIndex((entry) => entry.runId === run.id);
    return index >= 0 ? [{ x: index + 1, label: "Continued" }] : [];
  });
  const evolutionBoundaries = continuedRuns.flatMap((run) => {
    const index = allEvolutions.findIndex((entry) => entry.runId === run.id);
    return index >= 0 ? [{ x: index + 1, label: "Continued" }] : [];
  });
  const generationStarts = samples.filter(
    (sample, index) =>
      !!selected &&
      index > 0 &&
      motorTrialPlan(sample.episode, selected.spec.agents).evolution !==
        motorTrialPlan(samples[index - 1].episode, selected.spec.agents)
          .evolution,
  );
  return (
    <section className="panel motor-telemetry">
      <div className="motor-telemetry-heading">
        <div>
          <h3>Live experiment performance</h3>
          <p>Run samples update every two seconds while training is active.</p>
        </div>
        <label>
          Experiment
          <select
            value={selected?.id ?? ""}
            onChange={(event) => setRunId(event.target.value)}
          >
            {!motorRuns.length && <option value="">No motor runs yet</option>}
            {motorRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.spec.motor} · {run.id.slice(0, 8)} · {run.status}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!online ? (
        <p>Connect the control service to view performance.</p>
      ) : !selected ? (
        <p>Start a motor experiment to see its live graph.</p>
      ) : (
        <>
          <div className="motor-telemetry-stats">
            <div>
              <small>Trial episode</small>
              <strong>
                {selected.episode} / {selected.spec.episodes}
              </strong>
            </div>
            <div>
              <small>
                {selected.spec.component === "evaluation"
                  ? "Evaluation mode"
                  : "NEAT evolutions"}
              </small>
              <strong>
                {selected.spec.component === "evaluation"
                  ? "Frozen M7 champion"
                  : `${latestEvolution?.generation ?? 0} / ${expectedEvolutions}`}
              </strong>
            </div>
            <div>
              <small>Current species</small>
              <strong>
                {selected.spec.component === "evaluation"
                  ? "—"
                  : (latestEvolution?.species ?? 1)}
              </strong>
            </div>
            <div>
              <small>Mean cumulative reward</small>
              <strong>{latest ? latest.reward.toFixed(2) : "—"}</strong>
            </div>
            <div>
              <small>Agent steps / second</small>
              <strong>{latest ? latest.stepsPerSecond.toFixed(1) : "—"}</strong>
            </div>
            <div>
              <small>Observed step duration</small>
              <strong>{latest ? `${latest.tickMs.toFixed(0)} ms` : "—"}</strong>
              <small>Configured interval {selected.spec.tickMs} ms</small>
            </div>
            <div>
              <small>Run status</small>
              <strong>{selected.status}</strong>
            </div>
            <div>
              <small>Last trial success</small>
              <strong>
                {latestTrial
                  ? `${latestTrial.successes}/${latestTrial.trials} (${(latestTrial.successRate * 100).toFixed(0)}%)`
                  : "—"}
              </strong>
            </div>
            <div>
              <small>Mean steps to target</small>
              <strong>
                {latestTrial?.meanSuccessSteps == null
                  ? "—"
                  : latestTrial.meanSuccessSteps.toFixed(1)}
              </strong>
            </div>
          </div>
          {historyRuns.length > 1 && (
            <p>
              Showing the saved history of {historyRuns.length} linked runs,
              from {historyRuns[0].spec.motor} {historyRuns[0].id.slice(0, 8)}{" "}
              through {historyRuns.at(-1)?.id.slice(0, 8)}. Dashed lines mark
              continuations.
            </p>
          )}
          {error && <p role="status">{error}</p>}
          <div className="motor-telemetry-charts">
            <div>
              <h4>Population reward</h4>
              <p>Mean cumulative reward during each trial episode</p>
              <Chart
                data={liveMetrics as unknown as Array<Record<string, number>>}
                field="reward"
                label="Mean reward"
                boundaries={metricBoundaries}
              />
            </div>
            <div>
              <h4>Training throughput</h4>
              <p>Completed agent steps per second</p>
              <Chart
                data={liveMetrics as unknown as Array<Record<string, number>>}
                field="stepsPerSecond"
                label="Steps / second"
                color="#b4a0f5"
                boundaries={metricBoundaries}
              />
            </div>
            {selected.spec.component !== "evaluation" && (
              <div>
                <h4>Generation best fitness</h4>
                <p>Best genome in each completed NEAT evolution</p>
                <HistoryChart
                  data={evolutionHistory}
                  xKey="point"
                  labelKey="generation"
                  field="generationBestFitness"
                  color="#72e0ac"
                  label="Generation best fitness"
                  boundaries={evolutionBoundaries}
                />
              </div>
            )}
            {selected.spec.component !== "evaluation" && (
              <div>
                <h4>Species history</h4>
                <p>Surviving species after each evolution</p>
                <HistoryChart
                  data={evolutionHistory}
                  xKey="point"
                  labelKey="generation"
                  field="species"
                  color="#b4a0f5"
                  label="Species"
                  boundaries={evolutionBoundaries}
                />
              </div>
            )}
            <div>
              <h4>Trial success rate</h4>
              <p>Agents that reached their target in each trial episode</p>
              <HistoryChart
                data={trialHistory}
                xKey="point"
                labelKey="episode"
                field="successRate"
                color="#e8b875"
                label="Success %"
                boundaries={trialBoundaries}
              />
            </div>
            <div>
              <h4>Steps to target</h4>
              <p>Mean steps among successful agents in each trial episode</p>
              <HistoryChart
                data={trialHistory}
                xKey="point"
                labelKey="episode"
                field="meanSuccessSteps"
                color="#79c9ef"
                label="Steps to target"
                boundaries={trialBoundaries}
              />
            </div>
          </div>
          {!!allEvolutions.length && (
            <div className="motor-species-history">
              <div>
                <h4>Species by evolutionary generation</h4>
                {historyRuns.map((run) => (
                  <a
                    key={run.id}
                    href={`/api/control/runs/${run.id}/artifacts/evolution.jsonl`}
                    download
                  >
                    Download {run.id.slice(0, 8)} history
                  </a>
                ))}
                <label>
                  Generation
                  <select
                    value={selectedEvolution?.generation ?? 0}
                    onChange={(event) =>
                      setFocusGeneration(Number(event.target.value))
                    }
                  >
                    {allEvolutions.map((entry) => (
                      <option key={entry.generation} value={entry.generation}>
                        {entry.generation}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Species</th>
                    <th>Genomes</th>
                    <th>Best fitness</th>
                    <th>Offspring</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedEvolution?.speciesDetails?.map((species) => (
                    <tr key={species.id}>
                      <td>#{species.id}</td>
                      <td>{species.size}</td>
                      <td>{species.bestFitness.toFixed(2)}</td>
                      <td>{species.offspring}</td>
                      <td>
                        {species.stagnant
                          ? "Stagnant"
                          : species.offspring
                            ? "Breeding"
                            : "No offspring"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="motor-agent-chart">
            <h4>Agent client rewards</h4>
            <p>
              Each line follows a Minecraft client; genomes rotate between
              clients across trial batches. Rewards reset each trial episode.
              Dashed lines mark new NEAT evolutions.
            </p>
            {!samples.length ? (
              <div className="chart-empty">Waiting for agent samples…</div>
            ) : (
              <div className="chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={samples}
                    margin={{ top: 10, right: 12, left: -18, bottom: 0 }}
                  >
                    <CartesianGrid
                      stroke="#25332f"
                      vertical={false}
                      strokeDasharray="3 5"
                    />
                    <XAxis
                      dataKey="at"
                      tickFormatter={(value) =>
                        new Date(value).toLocaleTimeString([], {
                          minute: "2-digit",
                          second: "2-digit",
                        })
                      }
                      stroke="#788b82"
                      fontSize={10}
                      minTickGap={50}
                    />
                    <YAxis stroke="#788b82" fontSize={10} />
                    <Tooltip
                      labelFormatter={(value) =>
                        new Date(Number(value)).toLocaleTimeString()
                      }
                      contentStyle={{
                        background: "#17231d",
                        border: "1px solid #35483c",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    {generationStarts.map((sample) => (
                      <ReferenceLine
                        key={`${sample.episode}-${sample.at}`}
                        x={sample.at}
                        stroke="#aab8ad"
                        strokeDasharray="4 4"
                        strokeWidth={1.5}
                        label={{
                          value: `Evolution ${motorTrialPlan(sample.episode, selected.spec.agents).evolution + 1}`,
                          position: "insideTopRight",
                          fill: "#cbd8cf",
                          fontSize: 11,
                        }}
                      />
                    ))}
                    {agents.map((agent, index) => (
                      <Line
                        key={agent.username}
                        dataKey={agent.username}
                        name={agent.username}
                        type="monotone"
                        stroke={colors[index % colors.length]}
                        dot={false}
                        strokeWidth={2}
                        isAnimationActive={false}
                        connectNulls={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            {!!agents.length && (
              <div className="motor-agent-list">
                {agents.map((agent, index) => (
                  <div key={agent.id}>
                    <span style={{ color: colors[index % colors.length] }}>
                      {agent.username}
                    </span>
                    <strong>{agent.reward.toFixed(2)} reward</strong>
                    <small>
                      {agent.ticks} steps · {agent.status} ·{" "}
                      {agent.health.toFixed(1)} health
                    </small>
                    {agent.targetReached && (
                      <small>Target reached in {agent.targetSteps} steps</small>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
