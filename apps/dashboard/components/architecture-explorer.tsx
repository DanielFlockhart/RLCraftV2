"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  GoalModelJob,
  GoalModelSnapshot,
  Metric,
  ModelSnapshot,
  Run,
} from "@mlcraft/core";
import { trainingStages } from "../lib/training-stages";

const systems: { name: string; description: string; stages: string[] }[] = [
  {
    name: "Inputs and state",
    description: "Turn player observations into usable state.",
    stages: ["phase0", "phase1b", "phase2a", "phase2b", "phase2c", "phase2d"],
  },
  {
    name: "Goal hierarchy",
    description: "Represent goals and score what to pursue next.",
    stages: ["phase1a", "phase1c", "phase1d"],
  },
  {
    name: "Memory and prediction",
    description: "Remember locations and predict the outcome of choices.",
    stages: ["phase5", "phase6", "phase7"],
  },
  {
    name: "Planning",
    description: "Turn a final objective into reachable subgoals.",
    stages: ["phase8"],
  },
  {
    name: "Action hierarchy",
    description: "Choose, interrupt and resume skills when priorities change.",
    stages: ["phase4a", "phase4b", "phase4c"],
  },
  {
    name: "Skills",
    description:
      "Execute movement, interaction and combat through player actions.",
    stages: ["phase3a", "phase3b", "phase3c", "phase3d"],
  },
  {
    name: "Integration",
    description: "Combine components and train on complete tasks.",
    stages: ["phase9", "phase10"],
  },
  {
    name: "Outcomes and retraining",
    description: "Measure failures and target weak components.",
    stages: ["phase11"],
  },
];

type GoalConfig = {
  architecture?: { width: number; layers: number; dropout: number };
  goals?: string[];
  features?: { objective?: string };
};

const pct = (value: number | null | undefined) =>
  value == null ? "No sample" : `${(value * 100).toFixed(1)}%`;
const num = (value: number | undefined, digits = 1) =>
  value == null ? "No sample" : value.toFixed(digits);

export function ArchitectureExplorer({
  runs,
  metrics,
  online,
}: {
  runs: Run[];
  metrics: Metric[];
  online: boolean;
}) {
  const [stageId, setStageId] = useState("phase1a");
  const [models, setModels] = useState<GoalModelSnapshot>();
  const [modelId, setModelId] = useState("");
  const [runId, setRunId] = useState("");
  const [config, setConfig] = useState<GoalConfig>();
  const [inspection, setInspection] = useState<ModelSnapshot>();
  const [historyMetrics, setHistoryMetrics] = useState<Metric[]>();
  const [modelError, setModelError] = useState("");
  const [variantIndex, setVariantIndex] = useState(0);

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/control/goal-models", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Model catalog unavailable");
        setModels(await response.json());
        setModelError("");
      } catch (failure) {
        if (!controller.signal.aborted)
          setModelError((failure as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [online]);

  const stage = trainingStages.find((item) => item.id === stageId)!;
  const jobs = (models?.jobs ?? []).filter(
    (job) => (job.stageId ?? "phase1a") === stageId,
  );
  const selectedJob = jobs.find((job) => job.id === modelId) ?? jobs[0];
  const motorRuns =
    stageId === "phase3a"
      ? runs.filter((run) => run.spec.stage === "motor")
      : [];
  const selectedRun = motorRuns.find((run) => run.id === runId) ?? motorRuns[0];
  const runMetrics = selectedRun
    ? (historyMetrics ??
      metrics.filter((metric) => metric.runId === selectedRun.id))
    : [];
  const latestRunMetric = runMetrics.filter((metric) => !metric.kind).at(-1);
  const latestTrial = runMetrics
    .filter((metric) => metric.kind === "motor-trial")
    .at(-1)?.motor;
  const variant = inspection?.variants[variantIndex] ?? inspection?.variants[0];

  useEffect(() => {
    setConfig(undefined);
    if (!selectedJob?.artifacts.includes("config.json")) return;
    const controller = new AbortController();
    void fetch(
      `/api/control/goal-models/${selectedJob.id}/artifacts/config.json`,
      { signal: controller.signal },
    )
      .then((response) => (response.ok ? response.json() : undefined))
      .then((value) => {
        if (!controller.signal.aborted) setConfig(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [selectedJob?.id, selectedJob?.artifacts.includes("config.json")]);

  useEffect(() => {
    setInspection(undefined);
    setHistoryMetrics(undefined);
    setVariantIndex(0);
    if (!selectedRun || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(
          `/api/control/models/run/${selectedRun!.id}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (response.ok) setInspection(await response.json());
        const detail = await fetch(`/api/control/runs/${selectedRun!.id}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (detail.ok) setHistoryMetrics((await detail.json()).metrics);
      } catch {}
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [online, selectedRun?.id]);

  const modelCount = (id: string) =>
    (models?.jobs.filter((job) => (job.stageId ?? "phase1a") === id).length ??
      0) +
    (id === "phase3a"
      ? runs.filter((run) => run.spec.stage === "motor").length
      : 0);

  return (
    <div className="arch-page">
      <header className="panel arch-intro">
        <div>
          <span className="arch-kicker">SYSTEM ARCHITECTURE</span>
          <h2>Minecraft learning system</h2>
          <p>
            Explore how observations become goals, plans and player actions.
            Select a component to see its contracts, actual models and measured
            performance.
          </p>
        </div>
        <div className="arch-summary">
          <strong>
            {trainingStages.length}
            <small>roadmap components</small>
          </strong>
          <strong>
            {(models?.jobs.length ?? 0) +
              runs.filter((run) => run.spec.stage === "motor").length}
            <small>model records</small>
          </strong>
        </div>
      </header>

      <section className="panel arch-flow" aria-label="Architecture flow">
        <h3>System flow</h3>
        <div className="arch-flow-line">
          {systems.map((system, index) => (
            <div className="arch-flow-step" key={system.name}>
              <button
                className={system.stages.includes(stageId) ? "active" : ""}
                onClick={() => setStageId(system.stages[0])}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{system.name}</strong>
                <small>{system.description}</small>
              </button>
              {index < systems.length - 1 && (
                <span className="arch-flow-arrow" aria-hidden="true">
                  →
                </span>
              )}
            </div>
          ))}
        </div>
        <p>
          Information also loops back through outcomes, memory and retraining;
          the sequence above is a navigation map.
        </p>
      </section>

      <div className="arch-workspace">
        <nav
          className="panel arch-navigation"
          aria-label="Architecture components"
        >
          <h3>Components</h3>
          {systems.map((system) => (
            <div key={system.name} className="arch-nav-group">
              <h4>{system.name}</h4>
              {system.stages.map((id) => {
                const item = trainingStages.find((entry) => entry.id === id)!;
                const count = modelCount(id);
                return (
                  <button
                    key={id}
                    className={stageId === id ? "active" : ""}
                    aria-current={stageId === id ? "page" : undefined}
                    onClick={() => setStageId(id)}
                  >
                    <span>
                      {item.code} · {item.name}
                    </span>
                    {count > 0 && <b>{count}</b>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <main className="arch-component">
          <section className="panel arch-component-head">
            <span className="arch-kicker">
              PHASE {stage.code} ·{" "}
              {systems
                .find((system) => system.stages.includes(stageId))
                ?.name.toUpperCase()}
            </span>
            <h2>{stage.name}</h2>
            <p>{stage.description}</p>
            <div className="arch-contracts">
              <div>
                <small>Inputs</small>
                <p>{stage.inputs}</p>
              </div>
              <div>
                <small>Outputs</small>
                <p>{stage.outputs}</p>
              </div>
              <div>
                <small>Evaluation</small>
                <p>{stage.evaluation}</p>
              </div>
            </div>
            <Link href={`/?view=training&stage=${stage.id}`}>
              Open training stage ↗
            </Link>
          </section>

          <section className="panel arch-models">
            <div className="arch-section-heading">
              <div>
                <h3>Models and implementations</h3>
                <p>
                  Records update from the training service and run snapshots.
                </p>
              </div>
              <strong>{jobs.length + motorRuns.length} records</strong>
            </div>
            {!online ? (
              <p>Connect the control service to load model records.</p>
            ) : modelError ? (
              <p role="status">{modelError}</p>
            ) : !models ? (
              <p>Loading model records…</p>
            ) : !jobs.length && !motorRuns.length ? (
              <p>
                No trained model is recorded for this component yet. Its inputs,
                outputs and evaluation criteria are shown above.
              </p>
            ) : null}
            {!!jobs.length && (
              <div className="arch-record-layout">
                <div
                  className="arch-record-list"
                  role="group"
                  aria-label="Saved models"
                >
                  {jobs.map((job) => (
                    <button
                      key={job.id}
                      aria-pressed={selectedJob?.id === job.id}
                      onClick={() => setModelId(job.id)}
                    >
                      <strong>
                        {job.id.slice(0, 8)} · {job.status}
                      </strong>
                      <small>{new Date(job.createdAt).toLocaleString()}</small>
                    </button>
                  ))}
                </div>
                {selectedJob && (
                  <GoalModelDetail job={selectedJob} config={config} />
                )}
              </div>
            )}
            {!!motorRuns.length && (
              <div className="arch-record-layout">
                <div
                  className="arch-record-list"
                  role="group"
                  aria-label="Motor runs"
                >
                  {motorRuns.map((run) => (
                    <button
                      key={run.id}
                      aria-pressed={selectedRun?.id === run.id}
                      onClick={() => setRunId(run.id)}
                    >
                      <strong>
                        {run.spec.motor} · {run.id.slice(0, 8)}
                      </strong>
                      <small>
                        {run.status} ·{" "}
                        {new Date(run.createdAt).toLocaleString()}
                      </small>
                    </button>
                  ))}
                </div>
                {selectedRun && (
                  <div className="arch-record-detail">
                    <h4>
                      {selectedRun.spec.motor} · {selectedRun.status}
                    </h4>
                    <p>
                      Trial episode {selectedRun.episode} ·{" "}
                      {selectedRun.spec.agents} agents
                    </p>
                    {!inspection ? (
                      <p>No model inspection snapshot is available yet.</p>
                    ) : !inspection.variants.length ? (
                      <p>No model was active in this run.</p>
                    ) : (
                      <>
                        <div className="arch-variant-picker">
                          {inspection.variants.map((item, index) => (
                            <button
                              key={`${item.role}-${item.fingerprint}`}
                              aria-pressed={variant === item}
                              onClick={() => setVariantIndex(index)}
                            >
                              {item.role} ·{" "}
                              {item.agents.length === 1
                                ? item.agents[0]
                                : item.agents.length > 1
                                  ? `${item.agents.length} clients`
                                  : item.inspection.implementation}
                            </button>
                          ))}
                        </div>
                        {variant && (
                          <>
                            <p>
                              {variant.inspection.framework} ·{" "}
                              {variant.inspection.status} ·{" "}
                              {variant.inspection.parameters?.toLocaleString() ??
                                "Unknown"}{" "}
                              parameters
                            </p>
                            {variant.inspection.status === "ready" ? (
                              <>
                                {variant.inspection.hyperparameters
                                  .genomeIndex !== undefined && (
                                  <p>
                                    Active genome #
                                    {String(
                                      variant.inspection.hyperparameters
                                        .genomeIndex,
                                    )}{" "}
                                    · partial fitness{" "}
                                    {num(
                                      variant.inspection.hyperparameters
                                        .partialFitness as number,
                                      2,
                                    )}
                                  </p>
                                )}
                                {variant.inspection.hyperparameters
                                  .assignment && (
                                  <p>
                                    {String(
                                      variant.inspection.hyperparameters
                                        .assignment,
                                    )}
                                  </p>
                                )}
                                <div className="arch-module-list">
                                  {variant.inspection.nodes.map((node) => (
                                    <div key={node.id}>
                                      <strong>{node.label}</strong>
                                      <span>{node.kind}</span>
                                    </div>
                                  ))}
                                </div>
                                <details className="arch-connections">
                                  <summary>
                                    Connections (
                                    {variant.inspection.edges.length})
                                  </summary>
                                  <div className="arch-edge-list">
                                    {variant.inspection.edges.map(
                                      (edge, index) => (
                                        <div
                                          key={`${edge.from}-${edge.to}-${index}`}
                                        >
                                          {variant.inspection.nodes.find(
                                            (node) => node.id === edge.from,
                                          )?.label ?? edge.from}
                                          {" → "}
                                          {variant.inspection.nodes.find(
                                            (node) => node.id === edge.to,
                                          )?.label ?? edge.to}
                                          {" · "}
                                          {edge.label}
                                        </div>
                                      ),
                                    )}
                                  </div>
                                </details>
                              </>
                            ) : (
                              <p>
                                {variant.inspection.reason ??
                                  "This run does not expose a trained model."}
                              </p>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel arch-performance">
            <h3>Performance</h3>
            {selectedJob ? (
              <GoalPerformance job={selectedJob} />
            ) : selectedRun ? (
              <>
                <div className="arch-metrics">
                  <MetricCard
                    label="Mean reward"
                    value={num(latestRunMetric?.reward, 2)}
                    detail="Latest sampled episode"
                  />
                  <MetricCard
                    label="Agent throughput"
                    value={num(latestRunMetric?.stepsPerSecond)}
                    detail="Steps per second"
                  />
                  <MetricCard
                    label="Worker memory"
                    value={num(latestRunMetric?.workerMemoryMb)}
                    detail="MB, latest sample"
                  />
                  <MetricCard
                    label="Run progress"
                    value={`${(selectedRun.progress * 100).toFixed(0)}%`}
                    detail={`${selectedRun.episode} episodes reached`}
                  />
                  <MetricCard
                    label="Last trial success"
                    value={
                      latestTrial
                        ? `${latestTrial.successes}/${latestTrial.trials}`
                        : "No sample"
                    }
                    detail="Agents reaching their target"
                  />
                </div>
                {!latestRunMetric && (
                  <p className="arch-empty">
                    This run has no performance samples yet.
                  </p>
                )}
              </>
            ) : (
              <p className="arch-empty">
                No performance metrics are recorded for this component yet.
                Metrics will appear when a model or run reports them.
              </p>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="arch-metric">
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function GoalModelDetail({
  job,
  config,
}: {
  job: GoalModelJob;
  config?: GoalConfig;
}) {
  return (
    <div className="arch-record-detail">
      <h4>Goal predictor · {job.status}</h4>
      <p>
        Model {job.id} · version {job.modelVersion}
        {job.parentId ? ` · derived from ${job.parentId.slice(0, 8)}` : ""}
      </p>
      {job.error && <p role="status">{job.error}</p>}
      {config?.architecture ? (
        <>
          <div className="arch-network" aria-label="Saved model architecture">
            <div>Structured state</div>
            <span>→</span>
            <div>
              {config.architecture.layers} hidden layers
              <br />
              <small>
                {config.architecture.width} units · dropout{" "}
                {config.architecture.dropout}
              </small>
            </div>
            <span>→</span>
            <div>
              Goal scores
              <br />
              <small>{config.goals?.length ?? "?"} goals</small>
            </div>
            <div>Blocked score</div>
          </div>
          <p>
            {job.evaluation?.parameter_count?.toLocaleString() ?? "Unknown"}{" "}
            parameters · {config.features?.objective ?? "Goal selection"}
          </p>
        </>
      ) : (
        <p>
          {job.status === "running"
            ? "Architecture will appear after this training job saves its configuration."
            : "No saved architecture is available for this model."}
        </p>
      )}
    </div>
  );
}

function GoalPerformance({ job }: { job: GoalModelJob }) {
  const evaluation = job.evaluation;
  const test = evaluation?.splits.test;
  const ood = evaluation?.splits.ood_test;
  const latest = job.metrics.at(-1);
  return (
    <>
      <div className="arch-metrics">
        <MetricCard
          label="Validation top 1"
          value={pct(latest?.validation_top1)}
          detail="Latest training epoch"
        />
        <MetricCard
          label="Test top 1"
          value={pct(test?.top1)}
          detail="Held out states"
        />
        <MetricCard
          label="Out of distribution"
          value={pct(ood?.top1)}
          detail="OOD top 1"
        />
        <MetricCard
          label="Inference latency"
          value={
            evaluation
              ? `${num(evaluation.latency.median_ms, 2)} ms`
              : "No sample"
          }
          detail="Median, warm process"
        />
      </div>
      {evaluation && (
        <div className="arch-evaluation">
          <div>
            <strong>Top 3 test accuracy</strong>
            <span>{pct(test?.top3)}</span>
          </div>
          <div>
            <strong>Invalid goal selection</strong>
            <span>{pct(test?.masked_invalid_rate)}</span>
          </div>
          <div>
            <strong>Blocked state accuracy</strong>
            <span>{pct(test?.blocked_accuracy)}</span>
          </div>
          <div>
            <strong>Best epoch</strong>
            <span>
              {evaluation.best_epoch} / {evaluation.epochs_completed}
            </span>
          </div>
        </div>
      )}
      {!evaluation && (
        <p className="arch-empty">
          Evaluation will appear after this model completes training.
        </p>
      )}
    </>
  );
}
