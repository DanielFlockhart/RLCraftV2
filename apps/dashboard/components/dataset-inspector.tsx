"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Shuffle, Copy, Check } from "lucide-react";
import type { DatasetExamples, DatasetSplit } from "@mlcraft/core";
import {
  PlayerInventory,
  itemName,
  inventorySlotPosition,
} from "./player-inventory";

const splits: DatasetSplit[] = ["train", "validation", "test", "ood_test"];
export function DatasetInspector({ id }: { id: string }) {
  const [split, setSplit] = useState<DatasetSplit>("train");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<DatasetExamples>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [jump, setJump] = useState("1");
  const [slot, setSlot] = useState<number>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(undefined);
    setSlot(undefined);
    setCopied(false);
    setJump(String(offset + 1));
    void (async () => {
      try {
        const res = await fetch(
          `/api/control/datasets/${encodeURIComponent(id)}/examples?split=${split}&offset=${offset}&limit=1`,
          { signal: controller.signal },
        );
        const result = await res.json();
        if (!res.ok)
          throw new Error(result.error ?? "Could not load this example");
        if (!controller.signal.aborted) setData(result);
      } catch (err) {
        if (!controller.signal.aborted) setError((err as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [id, split, offset]);
  const example = data?.examples[0]?.data;
  const stack = example?.inventory.slots.find((item) => item.slot === slot);
  const raw = example ? JSON.stringify(example, null, 2) : "";
  const goalName = (goal: string) => goal.toLowerCase().replaceAll("_", " ");
  const targetProbability = example?.target.goal
    ? example.target.probabilities[example.target.goal]
    : 0;
  return (
    <main className="dataset-inspector-page">
      <Link href="/?view=datasets" className="agent-back-link">
        <ArrowLeft size={16} /> Back to datasets
      </Link>
      <div className="dataset-inspector-heading">
        <div>
          <div className="eyebrow">PHASE 1A / DATA EXAMPLES</div>
          <h1>Inside the inventory.</h1>
          <p>
            Dataset {id.slice(0, 8)} ·{" "}
            {data?.job.generatorVersion
              ? `Generator ${data.job.generatorVersion}`
              : "Goal selection"}
          </p>
        </div>
        <span className="badge">Inventory schema 2</span>
      </div>
      <section className="panel dataset-inspector-controls">
        <label>
          Split
          <select
            aria-label="Split"
            value={split}
            onChange={(event) => {
              setSplit(event.target.value as DatasetSplit);
              setOffset(0);
            }}
          >
            {splits.map((value) => (
              <option key={value} value={value}>
                {value === "ood_test"
                  ? "OOD test"
                  : value[0].toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const row = Number(jump);
            if (Number.isInteger(row) && row > 0 && row <= (data?.total ?? 0))
              setOffset(row - 1);
          }}
        >
          <label>
            Example
            <input
              type="number"
              min="1"
              max={data?.total || 1}
              step="1"
              required
              value={jump}
              onChange={(event) => setJump(event.target.value)}
            />
          </label>
          <button disabled={loading || !data?.total}>Go</button>
        </form>
        <span className="world-help">
          {data?.total
            ? `${offset + 1} of ${data.total.toLocaleString()} examples`
            : loading
              ? "Loading…"
              : "No examples"}
        </span>
        <div className="dataset-actions">
          <button
            aria-label="Previous example"
            disabled={loading || offset === 0}
            onClick={() => setOffset(offset - 1)}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            aria-label="Next example"
            disabled={loading || !data || offset + 1 >= data.total}
            onClick={() => setOffset(offset + 1)}
          >
            <ArrowRight size={16} />
          </button>
          <button
            disabled={loading || (data?.total ?? 0) < 2}
            onClick={() => {
              const total = data!.total;
              const random = Math.floor(Math.random() * (total - 1));
              setOffset(random >= offset ? random + 1 : random);
            }}
          >
            <Shuffle size={15} /> Random example
          </button>
        </div>
      </section>
      {data?.coverage && (
        <section className="panel dataset-panel dataset-coverage">
          <div className="dataset-card-heading">
            <h2>Defined edge-case coverage</h2>
            <span
              className={`badge ${data.coverage.complete ? "completed" : "paused"}`}
            >
              {data.coverage.covered_cases} / {data.coverage.required_cases}{" "}
              cases
            </span>
          </div>
          <p className="world-help">
            {data.coverage.complete
              ? "This split covers every case in the defined Phase 1A matrix."
              : "Some defined cases are missing. Increase this split's size or expand the dataset to complete the matrix."}{" "}
            {data.coverage.blocked_rows.toLocaleString()} examples have no
            currently valid goal.
          </p>
          <label className="dataset-case-select">
            Inspect a coverage case
            <select
              aria-label="Coverage case"
              value={example?.diagnostics.coverage_case ?? ""}
              onChange={(event) => {
                const entry = data.coverage?.cases.find(
                  (item) => item.id === event.target.value,
                );
                if (
                  entry?.first_index !== null &&
                  entry?.first_index !== undefined
                )
                  setOffset(entry.first_index);
              }}
            >
              <option value="">Choose a defined case</option>
              {[
                ...new Set(data.coverage.cases.map((entry) => entry.family)),
              ].map((family) => (
                <optgroup key={family} label={family.replaceAll("_", " ")}>
                  {data
                    .coverage!.cases.filter((entry) => entry.family === family)
                    .map((entry) => (
                      <option
                        key={entry.id}
                        value={entry.id}
                        disabled={entry.first_index === null}
                      >
                        {entry.description} · {entry.count} examples
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          <details>
            <summary>Sampling spread and missing cases</summary>
            <div className="dataset-context">
              {Object.entries(data.coverage.families).map(([family, count]) => (
                <div key={family}>
                  <span>{family.replaceAll("_", " ")}</span>
                  <strong>{count.toLocaleString()}</strong>
                </div>
              ))}
            </div>
            {data.coverage.missing_cases.length > 0 && (
              <p className="world-help">
                {data.coverage.missing_cases.length} missing cases are disabled
                in the selector above.
              </p>
            )}
          </details>
        </section>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <p className="world-help" role="status">
          Loading inventory and source data…
        </p>
      )}
      {!loading && !error && !example && (
        <section className="panel dataset-panel">
          <h2>This split is empty</h2>
          <p className="world-help">
            Choose another split or expand this dataset with examples for{" "}
            {split}.
          </p>
        </section>
      )}
      {example && (
        <div className="dataset-example-grid">
          <section className="panel dataset-visual-panel">
            <div className="dataset-card-heading">
              <h2>Player inventory</h2>
              <span className="badge">Java 1.18.1</span>
            </div>
            <div className="inventory-screen">
              <PlayerInventory value={example.inventory} onSelect={setSlot} />
            </div>
            {slot !== undefined && (
              <div className="inventory-slot-detail" aria-live="polite">
                <strong>
                  {inventorySlotPosition(slot).label} · slot {slot}
                </strong>
                <span>
                  {stack ? `${itemName(stack.item)} × ${stack.count}` : "Empty"}
                </span>
                <code>
                  {JSON.stringify(stack ?? { slot, item: null, count: 0 })}
                </code>
              </div>
            )}
            <div className="dataset-target">
              <div className="eyebrow">TEACHER'S NEXT GOAL</div>
              <h3>
                {example.target.goal === null
                  ? "Blocked: no valid goal"
                  : goalName(example.target.goal)}
              </h3>
              <p>
                {(targetProbability * 100).toFixed(1)}% probability ·
                progression stage {example.diagnostics.progression_stage}
              </p>
              {example.target.goal === null && (
                <p>
                  No currently valid action. This example is retained with a
                  blocked label.
                </p>
              )}
              {example.diagnostics.sampling_family && (
                <p>
                  Sampling family:{" "}
                  {example.diagnostics.sampling_family.replaceAll("_", " ")}
                </p>
              )}
            </div>
            <div className="dataset-context">
              {Object.entries(example.context).map(([key, value]) => (
                <div key={key}>
                  <span>{key.replaceAll("_", " ")}</span>
                  <strong>
                    {typeof value === "boolean"
                      ? value
                        ? "Yes"
                        : "No"
                      : value}
                  </strong>
                </div>
              ))}
            </div>
            <details className="dataset-probabilities">
              <summary>Goal probabilities and validity</summary>
              {Object.entries(example.target.probabilities).map(
                ([goal, probability]) => (
                  <div key={goal}>
                    <span>{goalName(goal)}</span>
                    <progress max="1" value={probability} />
                    <span>{(probability * 100).toFixed(1)}%</span>
                    <small>
                      {goal === "COMPLETE"
                        ? "Terminal"
                        : example.target.valid_goals[goal]
                          ? "Valid"
                          : "Unavailable"}
                    </small>
                  </div>
                ),
              )}
            </details>
          </section>
          <section className="panel dataset-raw-panel">
            <div className="dataset-card-heading">
              <div>
                <h2>Pure data</h2>
                <p className="world-help">
                  The complete stored JSONL record · example {offset + 1}
                </p>
              </div>
              <button
                disabled={copied}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(raw)
                    .then(() => setCopied(true))
                    .catch(() =>
                      setError(
                        "Could not copy. Select the raw JSON to copy it manually.",
                      ),
                    );
                }}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? "Copied" : "Copy JSON"}
              </button>
            </div>
            <pre className="dataset-raw-data" tabIndex={0}>
              {raw}
            </pre>
          </section>
        </div>
      )}
    </main>
  );
}
