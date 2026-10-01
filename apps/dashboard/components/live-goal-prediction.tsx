"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  AgentInputFrame,
  AgentState,
  GoalModelJob,
  GoalModelSnapshot,
  GoalPrediction,
} from "@mlcraft/core";
import { PlayerInventory } from "./player-inventory";
import { liveGoalInput } from "../lib/live-goal";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function LiveGoalPrediction({
  agent,
  online,
}: {
  agent: AgentState;
  online: boolean;
}) {
  const [models, setModels] = useState<GoalModelJob[]>([]);
  const [selected, setSelected] = useState("");
  const [frame, setFrame] = useState<AgentInputFrame>();
  const [prediction, setPrediction] = useState<GoalPrediction>();
  const [error, setError] = useState("");
  const [slot, setSlot] = useState<number>();
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/control/goal-models", {
          signal: controller.signal,
        });
        if (response.ok) {
          const snapshot = (await response.json()) as GoalModelSnapshot;
          setModels(
            snapshot.jobs.filter(
              (job) =>
                job.status === "completed" &&
                job.artifacts.includes("checkpoint.pt"),
            ),
          );
        }
      } catch {}
      if (!controller.signal.aborted) timer = setTimeout(poll, 10000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [online]);
  useEffect(() => {
    if (
      !online ||
      !["active", "paused", "resetting", "dead"].includes(agent.status)
    ) {
      setFrame(undefined);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch(
          `/api/control/runs/${encodeURIComponent(agent.runId)}/agents/${encodeURIComponent(agent.username)}/inputs`,
          { signal: controller.signal },
        );
        if (response.ok) setFrame(await response.json());
        else setFrame(undefined);
      } catch {
        if (!controller.signal.aborted) setFrame(undefined);
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [agent.runId, agent.username, agent.status, online]);
  const model = models.find((job) => job.id === selected) ?? models[0];
  const live = useMemo(
    () => (frame ? liveGoalInput(frame, agent) : undefined),
    [frame, agent],
  );
  const inputJson = live ? JSON.stringify(live.input) : "";
  useEffect(() => {
    setPrediction(undefined);
    setError("");
    if (!model || !inputJson) return;
    const controller = new AbortController();
    async function predict() {
      try {
        const response = await fetch(
          `/api/control/goal-models/${model!.id}/predict`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ example: JSON.parse(inputJson) }),
            signal: controller.signal,
          },
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Prediction failed");
        if (!controller.signal.aborted) setPrediction(result);
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      }
    }
    void predict();
    return () => controller.abort();
  }, [model?.id, inputJson]);
  return (
    <section className="panel agent-goal-panel">
      <div className="agent-goal-heading">
        <div>
          <h2>Live goal prediction</h2>
          <p>
            Phase 1A model · obtain an iron pickaxe · this agent's current
            inventory
          </p>
        </div>
        {models.length > 1 && (
          <label>
            Model{" "}
            <select
              value={model?.id ?? ""}
              onChange={(event) => setSelected(event.target.value)}
            >
              {models.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.id.slice(0, 8)} ·{" "}
                  {new Date(job.finishedAt ?? job.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!models.length && (
        <p>
          No completed Phase 1A model is available.{" "}
          <Link href="/?view=training&stage=phase1a">Train a goal model</Link>{" "}
          to see predictions.
        </p>
      )}
      {models.length > 0 && !live && (
        <p role="status">
          Waiting for the agent's inventory input. Enable the self.inventory
          channel for this run.
        </p>
      )}
      {live && (
        <div className="goal-prediction-grid">
          <div>
            <PlayerInventory value={live.display} onSelect={setSlot} />
            {slot !== undefined && (
              <p>
                Slot {slot}:{" "}
                {live.display.slots.find((stack) => stack.slot === slot)
                  ?.item ?? "empty"}
              </p>
            )}
            <p className="world-help">
              {live.contextSource}. Only observed nearby resources inform this
              prediction; unobserved resources are treated as unavailable.
            </p>
            {live.omitted > 0 && (
              <p className="world-help">
                {live.omitted} inventory stack{live.omitted === 1 ? "" : "s"}{" "}
                shown but outside the Phase 1A model's item vocabulary.
              </p>
            )}
            <details>
              <summary>Model input</summary>
              <pre className="dataset-raw-data">
                {JSON.stringify(live.input, null, 2)}
              </pre>
            </details>
          </div>
          <div>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            {model && !prediction && !error && (
              <p role="status">Predicting from live state…</p>
            )}
            {prediction && (
              <>
                <h3>
                  Prediction:{" "}
                  {prediction.goal ?? prediction.status.toUpperCase()}
                </h3>
                <p>
                  Blocked probability: {percent(prediction.blocked_probability)}
                </p>
                <p className="world-help">
                  {prediction.latency_ms.toFixed(2)} ms inference · ranked goals
                  use the rule-based validity mask.
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
                        <td>{percent(goal.probability)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!prediction.ranked_goals.length && (
                  <p>No valid progression goal for this observed state.</p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
