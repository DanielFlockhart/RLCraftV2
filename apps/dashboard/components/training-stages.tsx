"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { GoalModelJob, GoalModelSnapshot, Run } from "@mlcraft/core";
import {
  trainingPhases,
  trainingStages,
  type TrainingStageId,
} from "../lib/training-stages";
import { MinecraftIcon } from "./minecraft-icon";
import { Badge } from "./telemetry";

export function TrainingStages({
  runs,
  online,
  onOpen,
  onViewRun,
  completedStages,
  completedPhases,
  onTogglePhase,
  onToggleStage,
}: {
  runs: Run[];
  online: boolean;
  onOpen: (id: TrainingStageId) => void;
  onViewRun: (id: string) => void;
  completedStages: TrainingStageId[];
  completedPhases: number[];
  onTogglePhase: (phase: number) => void;
  onToggleStage: (id: TrainingStageId) => void;
}) {
  const [goalJobs, setGoalJobs] = useState<GoalModelJob[]>([]);
  useEffect(() => {
    if (!online) {
      setGoalJobs([]);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/control/goal-models", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.ok) {
          const snapshot = (await response.json()) as GoalModelSnapshot;
          setGoalJobs(snapshot.jobs.filter((job) => job.status === "running"));
        }
      } catch {}
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [online]);
  const activeRuns = runs
    .filter((run) => ["running", "paused", "pausing", "queued"].includes(run.status))
    .map((run) => {
      const stageId: TrainingStageId | undefined = run.spec.preview
        ? "phase0"
        : run.spec.stage === "motor"
          ? "phase3a"
          : run.spec.stage === "pvp"
            ? "phase3d"
            : run.spec.stage === "interaction"
              ? "phase3c"
            : run.spec.stage === "movement"
              ? "phase3b"
              : ["wood_collection", "block_collection"].includes(run.spec.stage)
                ? "phase3c"
                : undefined;
      return { run, stageId, stage: trainingStages.find((entry) => entry.id === stageId) };
    });
  const activeStageIds = new Set<TrainingStageId | undefined>(
    activeRuns.map(({ stageId }) => stageId),
  );
  if (goalJobs.length) activeStageIds.add("phase1a");
  return (
    <div className="training-roadmap">
      <section className="training-current panel" aria-live="polite">
        <h2>Current training</h2>
        {activeRuns.length || goalJobs.length ? (
          <div className="training-current-list">
            {activeRuns.map(({ run, stageId, stage }) => (
              <div className="training-current-row" key={run.id}>
                <div>
                  <strong>
                    {stage ? `${stage.code} · ${stage.name}` : run.spec.stage}
                    {run.spec.combat ? ` · ${run.spec.combat}` : ""}
                    {run.spec.motor ? ` · ${run.spec.motor}` : ""}
                  </strong>
                  <span>
                    {run.status} · trial {run.episode}/{run.spec.episodes} · run {run.id.slice(0, 8)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => stageId ? onOpen(stageId) : onViewRun(run.id)}
                >
                  {stageId ? "Open stage" : "View run"}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
            {goalJobs.map((job) => (
              <div className="training-current-row" key={job.id}>
                <div>
                  <strong>1A · State-conditioned goal identification</strong>
                  <span>
                    running · {job.phase ?? "training"} · model {job.id.slice(0, 8)}
                  </span>
                </div>
                <button type="button" onClick={() => onOpen("phase1a")}>
                  Open stage
                  <ArrowUpRight size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p>No training run is active.</p>
        )}
      </section>
      <p className="notice">
        Phase 0 offers a live agent preview, Phase 1A has supervised training,
        and Phase 3A has motor skill sessions. Phase 3D has combat sessions. Other stages are planned from the training
        roadmap.
      </p>
      {trainingPhases.map((name, phase) => (
        <section
          className="training-phase"
          key={phase}
          aria-labelledby={`training-phase-${phase}`}
        >
          <h2 id={`training-phase-${phase}`}>
            <label className="phase-check">
              <input
                type="checkbox"
                checked={completedPhases.includes(phase)}
                onChange={() => onTogglePhase(phase)}
              />
              Phase {phase} · {name}
            </label>
          </h2>
          <div className="stage-grid">
            {trainingStages
              .filter((stage) => stage.phase === phase)
              .map((stage) => (
                <section
                  className={`stage-card${activeStageIds.has(stage.id) ? " stage-card-active" : ""}`}
                  key={stage.id}
                >
                  <div className="stage-top">
                    <span className="stage-number">{stage.code}</span>
                    {activeStageIds.has(stage.id) ? (
                      <span className="stage-live-label">Active</span>
                    ) : (
                      <Badge
                        status={
                          stage.id === "phase1a" || stage.id === "phase0" || stage.id === "phase3a" || stage.id === "phase3c" || stage.id === "phase3d"
                            ? "ready"
                            : "not implemented"
                        }
                      />
                    )}
                  </div>
                  <h3 className="minecraft-heading">
                    <MinecraftIcon name={stage.icon} size={30} />
                    {stage.name}
                  </h3>
                  <p>{stage.description}</p>
                  <small>
                    {stage.id === "phase0"
                      ? "Live agent preview · no training"
                      : stage.id === "phase1a"
                        ? "Supervised training · checkpoints · fine-tuning · loss graphs"
                        : stage.id === "phase3a"
                          ? "M0–M8 · NEAT reinforcement learning · isolated arenas"
                        : stage.id === "phase3c"
                          ? "A0–A2 targeting · M0–M5 mining · structured SkillResult"
                        : stage.id === "phase3d"
                          ? "C0–C35 · NEAT combat training · isolated mob arenas"
                        : "Planned stage · training not yet available"}
                  </small>
                  <label className="stage-completion">
                    <input
                      type="checkbox"
                      checked={completedStages.includes(stage.id)}
                      onChange={() => onToggleStage(stage.id)}
                    />
                    Completed
                  </label>
                  <button
                    onClick={() => onOpen(stage.id)}
                    aria-label={`Open Phase ${stage.code} · ${stage.name}`}
                  >
                    {stage.id === "phase1a" || stage.id === "phase0" || stage.id === "phase3a" || stage.id === "phase3c" || stage.id === "phase3d"
                      ? "Open stage"
                      : "View planned stage"}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                </section>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function PlannedTrainingStage({ id }: { id: TrainingStageId }) {
  const stage = trainingStages.find((entry) => entry.id === id);
  if (!stage || stage.id === "phase1a" || stage.id === "phase0" || stage.id === "phase3c") return null;
  return (
    <section className="panel planned-stage">
      <div className="planned-stage-summary">
        <MinecraftIcon name={stage.icon} size={42} />
        <div>
          <Badge status="not implemented" />
          <p>{stage.description}</p>
        </div>
      </div>
      <p className="notice">
        This stage is a planning placeholder. Training, datasets and checkpoints
        for this stage are not yet available.
      </p>
      <dl className="planned-stage-spec">
        <div>
          <dt>Planned inputs</dt>
          <dd>{stage.inputs}</dd>
        </div>
        <div>
          <dt>Planned outputs</dt>
          <dd>{stage.outputs}</dd>
        </div>
        <div>
          <dt>Evaluation goals</dt>
          <dd>{stage.evaluation}</dd>
        </div>
      </dl>
    </section>
  );
}
