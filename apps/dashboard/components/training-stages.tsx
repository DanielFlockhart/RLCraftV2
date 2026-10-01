"use client";
import { ArrowUpRight } from "lucide-react";
import {
  trainingPhases,
  trainingStages,
  type TrainingStageId,
} from "../lib/training-stages";
import { MinecraftIcon } from "./minecraft-icon";
import { Badge } from "./telemetry";

export function TrainingStages({
  onOpen,
  completedPhases,
  onTogglePhase,
}: {
  onOpen: (id: TrainingStageId) => void;
  completedPhases: number[];
  onTogglePhase: (phase: number) => void;
}) {
  return (
    <div className="training-roadmap">
      <p className="notice">
        Phase 0 offers a live agent preview, Phase 1A has supervised training,
        and Phase 3A has motor skill sessions. Later stages are planned placeholders from the training
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
                <section className="stage-card" key={stage.id}>
                  <div className="stage-top">
                    <span className="stage-number">{stage.code}</span>
                    <Badge
                      status={
                        stage.id === "phase1a" || stage.id === "phase0" || stage.id === "phase3a"
                          ? "ready"
                          : "not implemented"
                      }
                    />
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
                        : "Planned stage · training not yet available"}
                  </small>
                  <button
                    onClick={() => onOpen(stage.id)}
                    aria-label={`Open Phase ${stage.code} · ${stage.name}`}
                  >
                    {stage.id === "phase1a" || stage.id === "phase0" || stage.id === "phase3a"
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
  if (!stage || stage.id === "phase1a" || stage.id === "phase0") return null;
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
