"use client";

import { useState } from "react";
import { Play, Square } from "lucide-react";
import type { MotorFullRun, MotorFullRunStage, Run } from "@mlcraft/core";
import { motorSessions } from "../../../packages/core/src/motor-sessions";
import { motorArena, motorTrialPlan } from "../../../packages/core/src/motor";
import {
  ARENA_BLOCK_BUDGET,
  arenaBlockCount,
} from "../../../packages/core/src/arenas";

type StageSettings = Omit<
  MotorFullRunStage,
  "runIds" | "lastSuccessRate" | "lastBestFitness"
>;

export function MotorFullRunPanel({
  plans,
  runs,
  online,
  available,
  act,
  onPlanChanged,
  busy,
  maxAgents,
  renderLimit,
  defaults,
}: {
  plans: MotorFullRun[];
  runs: Run[];
  online: boolean;
  available: boolean;
  act: (path: string, body?: unknown) => Promise<unknown>;
  onPlanChanged: (plan: MotorFullRun) => void;
  busy: boolean;
  maxAgents: number;
  renderLimit: number;
  defaults: {
    agents: number;
    episodes: number;
    ticksPerEpisode: number;
    tickMs: number;
    seed: number;
    backend: "mineflayer" | "fabric";
  };
}) {
  const [stages, setStages] = useState<StageSettings[]>(() =>
    motorSessions.map((session, index) => ({
      session: session.id,
      agents: Math.min(32, maxAgents),
      episodes: 64,
      ticksPerEpisode: 80,
      tickMs: 100,
      seed: 42 + index,
      backend: "mineflayer",
      minSuccessRate: 0,
      maxAttempts: 1,
    })),
  );
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const acceptPlan = (value: unknown) => {
    if (value && typeof value === "object" && "id" in value)
      onPlanChanged(value as MotorFullRun);
  };
  const activePlan = plans.find((plan) =>
    ["running", "paused"].includes(plan.status),
  );
  const selectedPlan =
    plans.find((plan) => plan.id === selectedPlanId) ?? activePlan ?? plans[0];
  const update = (index: number, change: Partial<StageSettings>) =>
    setStages((current) =>
      current.map((stage, position) =>
        position === index ? { ...stage, ...change } : stage,
      ),
    );
  const issue =
    stages.flatMap((stage, index) => {
      const population = motorTrialPlan(1, Math.max(1, stage.agents));
      const cellBlocks = arenaBlockCount(
        motorArena(stage.session, stage.seed),
        1,
      );
      const arenaLimit = Math.floor(ARENA_BLOCK_BUDGET / cellBlocks);
      const limit = Math.min(
        maxAgents,
        arenaLimit,
        stage.backend === "fabric" ? renderLimit : Infinity,
      );
      if (
        !Number.isInteger(stage.agents) ||
        stage.agents < 1 ||
        stage.agents > limit
      )
        return [`${stage.session}: agent count must be 1–${limit}`];
      if (
        !Number.isInteger(stage.episodes) ||
        stage.episodes < (index === 8 ? 1 : population.episodesPerEvolution)
      )
        return [
          `${stage.session}: allow at least ${index === 8 ? 1 : population.episodesPerEvolution} trial episodes`,
        ];
      if (stage.episodes * stage.maxAttempts > 100000)
        return [`${stage.session}: total retry episodes exceed 100,000`];
      if (
        !Number.isInteger(stage.ticksPerEpisode) ||
        stage.ticksPerEpisode < 1 ||
        stage.ticksPerEpisode > 100000
      )
        return [`${stage.session}: steps per episode must be 1–100,000`];
      if (
        !Number.isInteger(stage.tickMs) ||
        stage.tickMs < 20 ||
        stage.tickMs > 5000
      )
        return [`${stage.session}: step interval must be 20–5,000 ms`];
      if (
        !Number.isInteger(stage.seed) ||
        stage.seed < 0 ||
        stage.seed > 2147483647
      )
        return [`${stage.session}: terrain seed is invalid`];
      if (
        !Number.isFinite(stage.minSuccessRate) ||
        stage.minSuccessRate < 0 ||
        stage.minSuccessRate > 1
      )
        return [`${stage.session}: success condition must be 0–100%`];
      if (
        stage.minBestFitness !== undefined &&
        !Number.isFinite(stage.minBestFitness)
      )
        return [`${stage.session}: best fitness condition is invalid`];
      if (
        !Number.isInteger(stage.maxAttempts) ||
        stage.maxAttempts < 1 ||
        stage.maxAttempts > 10
      )
        return [`${stage.session}: attempts must be 1–10`];
      return [];
    })[0] ??
    (stages[7].seed === stages[8].seed
      ? "M8 needs a different terrain seed from M7"
      : "");
  return (
    <section className="panel motor-full-run">
      <div className="motor-full-run-heading">
        <div>
          <h3>Full Run · M0–M8</h3>
          <p>
            Train each motor session in order. Each completed stage passes its
            champion to the next. Set conditions below to control when it
            advances.
          </p>
        </div>
        {!!plans.length && (
          <label>
            Run plan
            <select
              value={selectedPlan?.id ?? ""}
              onChange={(event) => setSelectedPlanId(event.target.value)}
            >
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.id.slice(0, 8)} · {plan.status} ·{" "}
                  {Math.min(plan.stageIndex + 1, 9)}/9
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {online && !available && (
        <p role="status">
          Full Run controls will be available after the control service
          restarts. Let any active training run finish before restarting it.
        </p>
      )}
      {selectedPlan && (
        <div className="motor-full-run-progress">
          <div className="motor-full-run-heading">
            <strong>
              {selectedPlan.status === "completed"
                ? "All sessions complete"
                : `${selectedPlan.stages[Math.min(selectedPlan.stageIndex, 8)].session} · ${selectedPlan.status}`}
            </strong>
            <span>{selectedPlan.stageIndex}/9 stages passed</span>
          </div>
          <progress value={selectedPlan.stageIndex} max={9} />
          {selectedPlan.error && <p role="status">{selectedPlan.error}</p>}
          <div className="motor-full-run-progress-grid">
            {selectedPlan.stages.map((stage, index) => {
              const latest = stage.runIds.at(-1);
              const run = latest
                ? runs.find((entry) => entry.id === latest)
                : undefined;
              return (
                <div key={stage.session}>
                  <strong>{stage.session}</strong>
                  <span>
                    {index < selectedPlan.stageIndex
                      ? "Passed"
                      : index === selectedPlan.stageIndex &&
                          selectedPlan.status !== "completed"
                        ? ["failed", "cancelled"].includes(selectedPlan.status)
                          ? selectedPlan.status
                          : (run?.status ?? "Preparing")
                        : "Waiting"}
                  </span>
                  <small>
                    {stage.runIds.length} run
                    {stage.runIds.length === 1 ? "" : "s"}
                    {stage.lastSuccessRate !== undefined
                      ? ` · ${(stage.lastSuccessRate * 100).toFixed(1)}% success`
                      : ""}
                    {stage.lastBestFitness !== undefined && index < 8
                      ? ` · best ${stage.lastBestFitness.toFixed(2)}`
                      : ""}
                  </small>
                </div>
              );
            })}
          </div>
          {activePlan?.id === selectedPlan.id && (
            <div className="input-actions">
              {selectedPlan.status === "running" ? (
                <button
                  type="button"
                  disabled={submitting || !available}
                  onClick={async () => {
                    setSubmitting(true);
                    try {
                      const plan = await act(
                        `phase3a/full-runs/${selectedPlan.id}/pause`,
                        {},
                      );
                      acceptPlan(plan);
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                >
                  Pause after current session
                </button>
              ) : (
                <button
                  type="button"
                  disabled={submitting || !available}
                  onClick={async () => {
                    setSubmitting(true);
                    try {
                      const plan = await act(
                        `phase3a/full-runs/${selectedPlan.id}/resume`,
                        {},
                      );
                      acceptPlan(plan);
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                >
                  <Play size={14} /> Resume sequence
                </button>
              )}
              <button
                type="button"
                disabled={submitting || !available}
                onClick={async () => {
                  setSubmitting(true);
                  try {
                    const plan = await act(
                      `phase3a/full-runs/${selectedPlan.id}/cancel`,
                      {},
                    );
                    acceptPlan(plan);
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                <Square size={14} /> Stop Full Run
              </button>
            </div>
          )}
        </div>
      )}
      <div className="input-actions">
        <button
          type="button"
          disabled={!!activePlan || submitting}
          onClick={() =>
            setStages(
              motorSessions.map((session, index) => ({
                session: session.id,
                agents: defaults.agents,
                episodes:
                  session.id === "M8"
                    ? defaults.episodes
                    : Math.max(
                        defaults.episodes,
                        motorTrialPlan(1, defaults.agents).episodesPerEvolution,
                      ),
                ticksPerEpisode: defaults.ticksPerEpisode,
                tickMs: defaults.tickMs,
                seed: (defaults.seed + index) % 2147483648,
                backend: defaults.backend,
                minSuccessRate: 0,
                maxAttempts: 1,
              })),
            )
          }
        >
          Apply current training settings to all
        </button>
        <small>
          Each session has its own agents, duration, client, terrain seed and
          pass conditions.
        </small>
      </div>
      <div className="motor-full-run-stages">
        {stages.map((stage, index) => {
          const minimum =
            index === 8
              ? 1
              : motorTrialPlan(1, Math.max(1, stage.agents))
                  .episodesPerEvolution;
          return (
            <details key={stage.session}>
              <summary>
                <strong>{stage.session}</strong> {motorSessions[index].name}
                <span>
                  {stage.agents} agents · {stage.episodes} episodes ·{" "}
                  {stage.minSuccessRate
                    ? `${(stage.minSuccessRate * 100).toFixed(0)}% success`
                    : "completion"}
                </span>
              </summary>
              <div className="input-limit-grid">
                <label>
                  Agents
                  <input
                    type="number"
                    min={1}
                    max={maxAgents}
                    value={stage.agents}
                    onChange={(event) =>
                      update(index, { agents: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Trial episodes
                  <input
                    type="number"
                    min={minimum}
                    max={100000}
                    value={stage.episodes}
                    onChange={(event) =>
                      update(index, { episodes: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Steps per episode
                  <input
                    type="number"
                    min={1}
                    max={100000}
                    value={stage.ticksPerEpisode}
                    onChange={(event) =>
                      update(index, {
                        ticksPerEpisode: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Step interval (ms)
                  <input
                    type="number"
                    min={20}
                    max={5000}
                    value={stage.tickMs}
                    onChange={(event) =>
                      update(index, { tickMs: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Terrain seed
                  <input
                    type="number"
                    min={0}
                    max={2147483647}
                    value={stage.seed}
                    onChange={(event) =>
                      update(index, { seed: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Agent client
                  <select
                    value={stage.backend}
                    onChange={(event) =>
                      update(index, {
                        backend: event.target.value as StageSettings["backend"],
                      })
                    }
                  >
                    <option value="mineflayer">Protocol agents</option>
                    <option value="fabric">Fabric RGB agents</option>
                  </select>
                </label>
                <label>
                  Minimum success (%)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(stage.minSuccessRate * 100)}
                    onChange={(event) =>
                      update(index, {
                        minSuccessRate: Number(event.target.value) / 100,
                      })
                    }
                  />
                </label>
                {index < 8 && (
                  <>
                    <label>
                      Minimum best fitness
                      <input
                        type="number"
                        placeholder="No minimum"
                        value={stage.minBestFitness ?? ""}
                        onChange={(event) =>
                          update(index, {
                            minBestFitness:
                              event.target.value === ""
                                ? undefined
                                : Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Maximum attempts
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={stage.maxAttempts}
                        onChange={(event) =>
                          update(index, {
                            maxAttempts: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  </>
                )}
              </div>
              <small>
                {index === 8
                  ? "M8 evaluates the frozen M7 champion once on a different seed."
                  : `One NEAT evolution takes ${minimum} trial episodes. If the conditions are missed, another attempt continues the full population.`}
              </small>
            </details>
          );
        })}
      </div>
      {issue && <p role="status">{issue}</p>}
      <button
        type="button"
        disabled={
          !online ||
          !available ||
          busy ||
          submitting ||
          !!activePlan ||
          !!issue ||
          runs.some(
            (run) =>
              run.spec.mode === "minecraft" &&
              ["queued", "running", "paused", "pausing"].includes(run.status),
          )
        }
        onClick={async () => {
          setSubmitting(true);
          try {
            const plan = await act("phase3a/full-runs", { stages });
            acceptPlan(plan);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <Play size={14} /> Start Full Run
      </button>
    </section>
  );
}
