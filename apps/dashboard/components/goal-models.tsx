"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type {
  DatasetSnapshot,
  GoalModelSnapshot,
  GoalTrainingParameters,
  GoalPrediction,
  GoalSelectionExample,
  DatasetSplit,
  GoalModelJob,
} from "@mlcraft/core";
import { PlayerInventory } from "./player-inventory";

const percentage = (value: number | null | undefined) =>
  value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const fields: {
  key: Exclude<keyof GoalTrainingParameters, "device">;
  label: string;
  min: number;
  max: number;
  step?: number;
}[] = [
  { key: "epochs", label: "Maximum epochs", min: 1, max: 1000 },
  { key: "batchSize", label: "Batch size", min: 8, max: 8192 },
  { key: "width", label: "Hidden width", min: 16, max: 1024 },
  { key: "layers", label: "Hidden layers", min: 1, max: 8 },
  {
    key: "learningRate",
    label: "Learning rate",
    min: 0.000001,
    max: 0.1,
    step: 0.000001,
  },
  { key: "dropout", label: "Dropout", min: 0, max: 0.8, step: 0.01 },
  {
    key: "hardWeight",
    label: "Hard target weight",
    min: 0,
    max: 1,
    step: 0.05,
  },
  { key: "patience", label: "Early stopping patience", min: 1, max: 100 },
  { key: "seed", label: "Training seed", min: 0, max: 2147483647 },
  { key: "threads", label: "CPU threads", min: 1, max: 16 },
];
export function GoalModels({ online }: { online: boolean }) {
  const [data, setData] = useState<GoalModelSnapshot>();
  const [datasets, setDatasets] = useState<DatasetSnapshot>();
  const [parameters, setParameters] = useState<Partial<GoalTrainingParameters>>(
    {},
  );
  const [datasetId, setDatasetId] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  const [split, setSplit] = useState<DatasetSplit>("test");
  const [index, setIndex] = useState(1);
  const [testDataset, setTestDataset] = useState("");
  const [example, setExample] = useState<GoalSelectionExample>();
  const [prediction, setPrediction] = useState<GoalPrediction>();
  const [predictionModel, setPredictionModel] = useState("");
  const [inventorySlot, setInventorySlot] = useState<number>();
  const [showTraining, setShowTraining] = useState(false);
  const [parentId, setParentId] = useState("");
  const [trainingMode, setTrainingMode] = useState<"fine_tune" | "continue">(
    "fine_tune",
  );
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [models, sources] = await Promise.all([
          fetch("/api/control/goal-models", { signal: controller.signal }),
          fetch("/api/control/datasets", { signal: controller.signal }),
        ]);
        if (!models.ok || !sources.ok)
          throw new Error("Training service unavailable");
        setData(await models.json());
        setDatasets(await sources.json());
        setPollError("");
      } catch (err) {
        if (!controller.signal.aborted) setPollError((err as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const eligible =
    datasets?.jobs.filter(
      (job) =>
        job.status === "completed" &&
        job.generatorId === "phase1a" &&
        job.artifacts.includes("train.jsonl"),
    ) ?? [];
  const sourceId = datasetId || eligible[0]?.id || "";
  const focus =
    data?.jobs.find((job) => job.id === selected) ??
    data?.jobs.find((job) => job.status === "running") ??
    data?.jobs.find((job) => job.status === "completed") ??
    data?.jobs[0];
  const config = { ...data?.defaults, ...parameters } as GoalTrainingParameters;
  const running = data?.jobs.some((job) => job.status === "running");
  function fineTune(
    job: GoalModelJob,
    mode: "fine_tune" | "continue" = "fine_tune",
  ) {
    setTrainingMode(mode);
    setParentId(job.id);
    setParameters({
      ...job.parameters,
      learningRate:
        mode === "continue"
          ? job.parameters.learningRate
          : Math.max(0.000001, job.parameters.learningRate / 10),
    });
    setDatasetId(job.datasetId);
    setShowTraining(true);
    setError("");
  }
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/control/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Training request failed");
      setSelected(result.id);
      if (result.loaded) {
        setNotice("Checkpoint reloaded for predictions.");
        setPrediction(undefined);
      } else {
        setNotice("");
        setShowTraining(false);
      }
      const fresh = await fetch("/api/control/goal-models");
      if (fresh.ok) setData(await fresh.json());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspectPrediction() {
    if (!focus) return;
    setBusy(true);
    setError("");
    setPrediction(undefined);
    setExample(undefined);
    setInventorySlot(undefined);
    try {
      const response = await fetch(
        `/api/control/datasets/${testDataset || focus.datasetId}/examples?split=${split}&offset=${index - 1}&limit=1`,
      );
      const preview = await response.json();
      if (!response.ok)
        throw new Error(preview.error ?? "Could not load example");
      if (!preview.examples.length)
        throw new Error(
          `No example at this position. This split contains ${preview.total} rows.`,
        );
      const row = preview.examples[0].data as GoalSelectionExample;
      setExample(row);
      const result = await fetch(
        `/api/control/goal-models/${focus.id}/predict`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ example: row }),
        },
      );
      const value = await result.json();
      if (!result.ok) throw new Error(value.error ?? "Prediction failed");
      setPrediction(value);
      setPredictionModel(focus.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="datasets-page goal-models-page">
      {(error || pollError) && (
        <div className="notice error" role="alert">
          {error || pollError}
        </div>
      )}
      <section className="panel dataset-panel">
        <h2>Phase 1A models</h2>
        <div className="dataset-actions">
          <button
            className="primary"
            disabled={busy || running || !online}
            onClick={() => {
              setParentId("");
              setTrainingMode("fine_tune");
              setParameters({});
              setShowTraining(true);
            }}
          >
            Train new model
          </button>
          <button
            disabled={
              busy || running || !online || focus?.status !== "completed"
            }
            onClick={() => focus && fineTune(focus, "continue")}
          >
            Continue training
          </button>
          <button
            disabled={
              busy || running || !online || focus?.status !== "completed"
            }
            onClick={() => focus && fineTune(focus)}
          >
            Fine-tune selected model
          </button>
          <button
            disabled={busy || !online || focus?.status !== "completed"}
            onClick={() =>
              focus && void action(`goal-models/${focus.id}/reload`)
            }
          >
            Reload selected checkpoint
          </button>
        </div>
      </section>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {showTraining && (
        <section className="panel dataset-panel">
          <h2>
            {parentId
              ? trainingMode === "continue"
                ? "Continue Phase 1A training"
                : "Fine-tune Phase 1A goal prediction"
              : "Train Phase 1A goal prediction"}
          </h2>
          <p className="world-help">
            Learn the iron-pickaxe progression prior from inventory totals and
            player/world context. Train and validation splits must contain
            examples. Test and OOD splits are evaluated after selecting the best
            checkpoint.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void action("goal-models", {
                datasetId: sourceId,
                parameters: config,
                ...(parentId ? { parentId, trainingMode } : {}),
              });
            }}
          >
            <div className="form-grid">
              <label>
                Starting checkpoint
                <select
                  value={parentId}
                  onChange={(event) => {
                    const job = data?.jobs.find(
                      (value) => value.id === event.target.value,
                    );
                    if (job) fineTune(job, trainingMode);
                    else {
                      setParentId("");
                      setParameters({});
                    }
                  }}
                >
                  <option value="">Train from scratch</option>
                  {data?.jobs
                    .filter((job) => job.status === "completed")
                    .map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.id.slice(0, 8)}
                      </option>
                    ))}
                </select>
              </label>
              {parentId && (
                <label>
                  Training mode
                  <select
                    value={trainingMode}
                    onChange={(event) => {
                      const job = data?.jobs.find(
                        (value) => value.id === parentId,
                      );
                      if (job)
                        fineTune(
                          job,
                          event.target.value as "fine_tune" | "continue",
                        );
                    }}
                  >
                    <option value="continue">Continue training</option>
                    <option value="fine_tune">Fine-tune</option>
                  </select>
                </label>
              )}
              <label>
                Training dataset
                <select
                  required
                  value={sourceId}
                  disabled={!!parentId && trainingMode === "continue"}
                  onChange={(event) => setDatasetId(event.target.value)}
                >
                  <option value="" disabled>
                    Select a completed dataset
                  </option>
                  {eligible.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.id.slice(0, 8)} ·{" "}
                      {new Date(job.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Training device
                <select
                  value={config.device ?? "cpu"}
                  onChange={(event) =>
                    setParameters({
                      ...parameters,
                      device: event.target.value as "cpu" | "cuda",
                    })
                  }
                >
                  <option value="cpu">CPU</option>
                  <option value="cuda">CUDA GPU</option>
                </select>
              </label>
              {fields.map((field) => (
                <label key={field.key}>
                  {trainingMode === "continue" &&
                  parentId &&
                  field.key === "epochs"
                    ? "Additional epochs"
                    : field.label}
                  <input
                    type="number"
                    required
                    min={field.min}
                    max={field.max}
                    step={field.step ?? 1}
                    value={config[field.key] ?? ""}
                    disabled={
                      !!parentId &&
                      (["width", "layers", "dropout"].includes(field.key) ||
                        (trainingMode === "continue" &&
                          [
                            "batchSize",
                            "learningRate",
                            "hardWeight",
                            "seed",
                          ].includes(field.key)))
                    }
                    onChange={(event) =>
                      setParameters({
                        ...parameters,
                        [field.key]: Number(event.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <p className="world-help">
              {parentId &&
                trainingMode === "continue" &&
                "Continuation keeps the dataset and learning settings. Saved optimizer state is restored when available; older weights-only checkpoints use a fresh optimizer. Each continuation saves a new model and loss curve. "}
              Hard target weight balances preferred-goal learning against the
              teacher’s probability distribution. Blocked examples train a
              separate output. Early stopping uses validation loss.
            </p>
            <div className="dataset-actions">
              <button
                type="submit"
                className="primary"
                disabled={!online || busy || running || !sourceId || !data}
              >
                {parentId
                  ? trainingMode === "continue"
                    ? "Start continuation"
                    : "Fine-tune model"
                  : "Train goal model"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setParentId("");
                  setParameters({});
                }}
              >
                Reset parameters
              </button>
              <Link href="/?view=datasets">Generate or inspect datasets</Link>
              <button type="button" onClick={() => setShowTraining(false)}>
                Close training setup
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="panel dataset-panel">
        <h2>Goal model history</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model / dataset</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Validation accuracy</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.jobs.map((job) => (
                <tr
                  key={job.id}
                  className={focus?.id === job.id ? "selected" : ""}
                >
                  <td>
                    <button
                      className="run-link"
                      onClick={() => {
                        setSelected(job.id);
                        setPrediction(undefined);
                        setExample(undefined);
                      }}
                    >
                      {job.id.slice(0, 8)}
                    </button>
                    <small>{new Date(job.createdAt).toLocaleString()}</small>
                    <small>Dataset {job.datasetId.slice(0, 8)}</small>
                    {job.parentId && (
                      <small>
                        {job.trainingMode === "continue"
                          ? "Continued"
                          : "Fine-tuned"}{" "}
                        from {job.parentId.slice(0, 8)}
                      </small>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${job.status}`}>{job.status}</span>
                  </td>
                  <td>{job.phase ?? "—"}</td>
                  <td>
                    {percentage(
                      job.evaluation?.splits.validation.top1 ??
                        job.metrics.at(-1)?.validation_top1,
                    )}
                  </td>
                  <td>
                    {job.status === "running" ? (
                      <button
                        disabled={busy || !online}
                        onClick={() =>
                          void action(`goal-models/${job.id}/cancel`)
                        }
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        disabled={busy || running || !online}
                        onClick={() =>
                          void action(`goal-models/${job.id}/rerun`)
                        }
                      >
                        Rerun training
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data?.jobs.length && (
          <p className="world-help">
            No goal models yet. Choose a dataset above to train the baseline.
          </p>
        )}
      </section>
      {focus && (
        <>
          <section className="panel dataset-panel">
            <h2>Training results · {focus.id.slice(0, 8)}</h2>
            {focus.error && (
              <p className="error-text" role="alert">
                {focus.error}
              </p>
            )}
            {!!focus.metrics.length && (
              <div className="goal-loss-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={focus.metrics}>
                    <CartesianGrid stroke="#25332f" strokeDasharray="3 5" />
                    <XAxis dataKey="epoch" />
                    <YAxis />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="train_loss"
                      name="Training loss"
                      stroke="#72e0ac"
                      fill="#72e0ac"
                      fillOpacity={0.08}
                    />
                    <Area
                      type="monotone"
                      dataKey="validation_loss"
                      name="Validation loss"
                      stroke="#80afff"
                      fill="#80afff"
                      fillOpacity={0.08}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
            {focus.evaluation && (
              <>
                <p className="world-help">
                  Best epoch {focus.evaluation.best_epoch} ·{" "}
                  {focus.evaluation.parameter_count.toLocaleString()} parameters
                  · warm CPU prediction{" "}
                  {focus.evaluation.latency.median_ms.toFixed(2)} ms median /{" "}
                  {focus.evaluation.latency.p95_ms.toFixed(2)} ms p95
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Split</th>
                        <th>Rows</th>
                        <th>Top 1</th>
                        <th>Top 3</th>
                        <th>Invalid before mask</th>
                        <th>Invalid after mask</th>
                        <th>Blocked accuracy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(focus.evaluation.splits).map(
                        ([name, value]) => (
                          <tr key={name}>
                            <td>{name}</td>
                            <td>{value.rows.toLocaleString()}</td>
                            <td>{percentage(value.top1)}</td>
                            <td>{percentage(value.top3)}</td>
                            <td>{percentage(value.raw_invalid_rate)}</td>
                            <td>{percentage(value.masked_invalid_rate)}</td>
                            <td>{percentage(value.blocked_accuracy)}</td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="world-help">
                  Goal accuracy is measured on non-blocked examples and includes
                  COMPLETE. The legality mask guarantees valid selections;
                  blocked accuracy measures the learned blocked output
                  independently.
                </p>
                <details>
                  <summary>Test performance by goal and sample family</summary>
                  <div className="goal-breakdowns">
                    <div>
                      <h3>Goals</h3>
                      <table>
                        <thead>
                          <tr>
                            <th>Goal</th>
                            <th>Rows</th>
                            <th>Accuracy</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(
                            focus.evaluation.splits.test.per_goal ?? {},
                          ).map(([goal, value]) => (
                            <tr key={goal}>
                              <td>{goal}</td>
                              <td>{value.rows}</td>
                              <td>{percentage(value.accuracy)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div>
                      <h3>Sample families</h3>
                      <table>
                        <thead>
                          <tr>
                            <th>Family</th>
                            <th>Rows</th>
                            <th>Goal accuracy</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(
                            focus.evaluation.splits.test.per_family ?? {},
                          ).map(([family, value]) => (
                            <tr key={family}>
                              <td>{family}</td>
                              <td>{value.rows}</td>
                              <td>{percentage(value.goal_accuracy)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </details>
              </>
            )}
            <div className="dataset-actions">
              {focus.artifacts.map((file) => (
                <a
                  key={file}
                  href={`/api/control/goal-models/${focus.id}/artifacts/${file}`}
                >
                  {file}
                </a>
              ))}
            </div>
            <details>
              <summary>Training logs</summary>
              <pre className="dataset-job-log">
                {focus.logs.join("\n") || "Waiting for trainer output…"}
              </pre>
            </details>
          </section>
          {focus.status === "completed" && (
            <section className="panel dataset-panel">
              <h2>Test a goal prediction</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void inspectPrediction();
                }}
              >
                <div className="form-grid">
                  <label>
                    Example dataset
                    <select
                      value={testDataset || focus.datasetId}
                      onChange={(event) => {
                        setTestDataset(event.target.value);
                        setPrediction(undefined);
                        setExample(undefined);
                      }}
                    >
                      {eligible.map((job) => (
                        <option key={job.id} value={job.id}>
                          {job.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Prediction split
                    <select
                      value={split}
                      onChange={(event) => {
                        setSplit(event.target.value as DatasetSplit);
                        setIndex(1);
                        setPrediction(undefined);
                        setExample(undefined);
                      }}
                    >
                      {["train", "validation", "test", "ood_test"].map(
                        (value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    Example number
                    <input
                      type="number"
                      required
                      min={1}
                      step={1}
                      value={index}
                      onChange={(event) => {
                        setIndex(Number(event.target.value));
                        setPrediction(undefined);
                        setExample(undefined);
                      }}
                    />
                  </label>
                </div>
                <button className="primary" disabled={busy || !online}>
                  Predict goal
                </button>
              </form>
              {example && (
                <div className="goal-prediction-grid">
                  <div>
                    <PlayerInventory
                      value={example.inventory}
                      onSelect={setInventorySlot}
                    />
                    {inventorySlot !== undefined && (
                      <div>
                        <h3>Inventory slot {inventorySlot}</h3>
                        <pre className="dataset-raw-data">
                          {JSON.stringify(
                            example.inventory.slots.find(
                              (stack) => stack.slot === inventorySlot,
                            ) ?? { slot: inventorySlot, item: null, count: 0 },
                            null,
                            2,
                          )}
                        </pre>
                      </div>
                    )}
                    <p>
                      Teacher: <b>{example.target.goal ?? "BLOCKED"}</b>
                    </p>
                    <details>
                      <summary>Inventory and context data</summary>
                      <pre className="dataset-raw-data">
                        {JSON.stringify(
                          {
                            inventory: example.inventory,
                            context: example.context,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </div>
                  {prediction && predictionModel === focus.id && (
                    <div>
                      <h3>Prediction: {prediction.goal ?? "BLOCKED"}</h3>
                      <p>
                        Learned blocked probability:{" "}
                        {percentage(prediction.blocked_probability)}
                      </p>
                      <p className="world-help">
                        {prediction.latency_ms.toFixed(2)} ms in the inference
                        worker. Ranked probabilities use the rule-based mask.
                      </p>
                      <table>
                        <thead>
                          <tr>
                            <th>Goal</th>
                            <th>Probability</th>
                          </tr>
                        </thead>
                        <tbody>
                          {prediction.ranked_goals.map((goal) => (
                            <tr key={goal.goal}>
                              <td>{goal.goal}</td>
                              <td>{percentage(goal.probability)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!prediction.ranked_goals.length && (
                        <p>No valid progression goal for this state.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
