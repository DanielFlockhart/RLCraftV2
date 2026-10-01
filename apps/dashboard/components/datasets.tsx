"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { DatasetSnapshot, DatasetJob } from "@mlcraft/core";

export function Datasets({ online }: { online: boolean }) {
  const [data, setData] = useState<DatasetSnapshot>();
  const [generatorId, setGeneratorId] = useState("phase1a");
  const [parameters, setParameters] = useState<Record<string, number>>({});
  const [parentId, setParentId] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await fetch("/api/control/datasets", {
          signal: controller.signal,
        });
        if (!res.ok)
          throw new Error(
            (await res.json()).error ?? "Dataset jobs unavailable",
          );
        setData(await res.json());
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
  const generator = data?.generators.find((item) => item.id === generatorId);
  const running = data?.jobs.some((job) => job.status === "running") ?? false;
  const focus = data?.jobs.find((job) => job.id === selected) ?? data?.jobs[0];
  const parent = data?.jobs.find((job) => job.id === parentId);
  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/control/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Dataset request failed");
      setSelected(result.id);
      const refresh = await fetch("/api/control/datasets");
      if (refresh.ok) setData(await refresh.json());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function configure(job: DatasetJob, expand: boolean) {
    setGeneratorId(job.generatorId);
    setParameters({
      ...job.parameters,
      ...(expand ? { seed: (job.parameters.seed + 1) % 2147483648 } : {}),
    });
    setParentId(expand ? job.id : "");
    setSelected(job.id);
    setError("");
  }
  return (
    <div className="datasets-page">
      {(error || pollError) && (
        <div className="notice error" role="alert">
          {error || pollError}
        </div>
      )}
      <section className="panel dataset-panel">
        <h2>Generate training datasets</h2>
        <p className="world-help">
          Each job creates a new version with recorded parameters and generator
          source hash. Python runs on the control service host.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act("datasets", {
              generatorId,
              parameters,
              ...(parentId ? { parentId } : {}),
            });
          }}
        >
          <div className="form-grid">
            <label>
              Generator
              <select
                value={generatorId}
                onChange={(event) => {
                  setGeneratorId(event.target.value);
                  setParameters({});
                  setParentId("");
                }}
              >
                {data?.generators.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Dataset to expand
              <select
                value={parentId}
                disabled={!generator?.supportsExpansion}
                onChange={(event) => {
                  const job = data?.jobs.find(
                    (item) => item.id === event.target.value,
                  );
                  if (job) configure(job, true);
                  else setParentId("");
                }}
              >
                <option value="">Create a new dataset</option>
                {data?.jobs
                  .filter(
                    (job) =>
                      job.status === "completed" &&
                      job.generatorVersion === generator?.version &&
                      job.generatorId === generatorId,
                  )
                  .map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.id.slice(0, 8)} ·{" "}
                      {new Date(job.createdAt).toLocaleString()}
                    </option>
                  ))}
              </select>
            </label>
            {generator?.parameters.map((p) => (
              <label key={p.key}>
                {p.label}
                <input
                  type="number"
                  required
                  min={p.min}
                  max={p.max}
                  step={p.integer ? 1 : "any"}
                  value={parameters[p.key] ?? p.default}
                  disabled={!!parent && p.key === "temperature"}
                  onChange={(event) =>
                    setParameters({
                      ...parameters,
                      [p.key]: Number(event.target.value),
                    })
                  }
                />
              </label>
            ))}
          </div>
          <p className="world-help">{generator?.description}</p>
          <p className="world-help">
            {parent
              ? "Row counts add new examples to each existing split. Existing rows stay in their original splits; duplicate states are skipped. Use a new seed for expansion."
              : "Row counts set each split's size. Request up to 2,000,000 total new rows; zero disables a split."}
          </p>
          <div className="dataset-actions">
            <button
              className="primary"
              type="submit"
              disabled={!online || busy || running || !generator}
            >
              {parent ? "Expand dataset" : "Generate dataset"}
            </button>
            <button
              type="button"
              disabled={!generator || busy}
              onClick={() => {
                setParameters({});
                setParentId("");
              }}
            >
              Reset parameters
            </button>
          </div>
        </form>
      </section>
      <section className="panel dataset-panel">
        <h2>Dataset history</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Dataset / created</th>
                <th>Generator</th>
                <th>Status</th>
                <th>Progress</th>
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
                      onClick={() => setSelected(job.id)}
                    >
                      {job.id.slice(0, 8)}
                    </button>
                    <small>{new Date(job.createdAt).toLocaleString()}</small>
                    {job.parentId && (
                      <small>Expanded from {job.parentId.slice(0, 8)}</small>
                    )}
                  </td>
                  <td>
                    {data.generators.find((item) => item.id === job.generatorId)
                      ?.name ?? job.generatorId}
                  </td>
                  <td>
                    <span className={`badge ${job.status}`}>{job.status}</span>
                  </td>
                  <td>
                    {job.progress
                      ? `${job.progress.split}: ${job.progress.rows.toLocaleString()} / ${job.progress.total.toLocaleString()}`
                      : "—"}
                  </td>
                  <td>
                    <div className="dataset-actions">
                      {job.status === "running" ? (
                        <button
                          disabled={!online || busy}
                          onClick={() => void act(`datasets/${job.id}/cancel`)}
                        >
                          Cancel
                        </button>
                      ) : (
                        <>
                          <button
                            disabled={!online || busy || running}
                            onClick={() => void act(`datasets/${job.id}/rerun`)}
                          >
                            Rerun
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => configure(job, false)}
                          >
                            Use parameters
                          </button>
                          {job.status === "completed" && (
                            <>
                              <Link
                                className="run-link"
                                href={`/datasets/${job.id}`}
                              >
                                Inspect examples
                              </Link>
                              <button
                                disabled={
                                  busy ||
                                  job.generatorVersion !==
                                    data.generators.find(
                                      (item) => item.id === job.generatorId,
                                    )?.version
                                }
                                onClick={() => configure(job, true)}
                              >
                                Expand
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data?.jobs.length === 0 && (
          <p className="world-help">
            No datasets yet. Choose parameters above to generate the first
            version.
          </p>
        )}
      </section>
      {focus && (
        <section className="panel dataset-panel">
          <h2>Dataset {focus.id.slice(0, 8)}</h2>
          {focus.error && (
            <p role="alert" className="notice error">
              {focus.error}
            </p>
          )}
          <div className="dataset-actions">
            {focus.status === "completed" && (
              <Link className="run-link" href={`/datasets/${focus.id}`}>
                Inspect examples →
              </Link>
            )}
            {focus.artifacts.map((file) => (
              <a
                key={file}
                className="run-link"
                href={`/api/control/datasets/${focus.id}/artifacts/${file}`}
                download
              >
                {file}
              </a>
            ))}
          </div>
          <details>
            <summary>Recorded parameters and source version</summary>
            <pre className="dataset-log">
              {JSON.stringify(
                {
                  generator: focus.generatorId,
                  version: focus.generatorVersion,
                  sourceHash: focus.sourceHash,
                  parameters: focus.parameters,
                  parentId: focus.parentId,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <h3>Generator log</h3>
          <pre className="dataset-log" aria-live="polite">
            {focus.logs.join("\n") || "Waiting for generator output…"}
          </pre>
        </section>
      )}
    </div>
  );
}
