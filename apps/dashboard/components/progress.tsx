"use client";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Circle,
  CircleHelp,
  Download,
  Search,
} from "lucide-react";
import type { ProgressSnapshot, Run } from "@mlcraft/core";
import { MinecraftIcon } from "./minecraft-icon";
import { progressGroupIcons, progressIcons } from "./progress-icons";

const labels = {
  completion: "Completion",
  route: "Route dependent",
  preparation: "Preparation",
  postgame: "Postgame",
};
export function Progress({ runs, online }: { runs: Run[]; online: boolean }) {
  const [runId, setRunId] = useState("");
  const [data, setData] = useState<ProgressSnapshot>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [state, setState] = useState("all");
  const [survival, setSurvival] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setData(undefined);
    setError("");
    async function poll() {
      try {
        const res = await fetch(
          `/api/control/progress${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`,
          { signal: controller.signal },
        );
        if (!res.ok)
          throw new Error(
            "Progress data is unavailable. Check the control service.",
          );
        setData(await res.json());
        setError("");
      } catch (err) {
        if (!controller.signal.aborted) setError((err as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [runId]);
  const summaries = useMemo(
    () =>
      new Map(data?.summaries.map((summary) => [summary.milestoneId, summary])),
    [data],
  );
  const reached = (id: string) =>
    survival
      ? (summaries.get(id)?.survivalAgents ?? 0)
      : (summaries.get(id)?.agents ?? 0);
  const observed =
    data?.catalog.steps.filter((step) => reached(step.id) > 0).length ?? 0;
  const displayed =
    data?.catalog.steps.filter((step) => {
      const match =
        `${step.title} ${step.id} ${step.items} ${step.minimum} ${step.alternatives} ${step.instructions.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase());
      return (
        match &&
        (kind === "all" || step.requirement === kind) &&
        (state === "all" ||
          (state === "reached" ? reached(step.id) > 0 : reached(step.id) === 0))
      );
    }) ?? [];
  function download() {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `minecraft-progress-${runId || "all-runs"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="game-progress-page">
      <section className="panel progress-intro">
        <MinecraftIcon name="experience_bottle" size={40} />
        <div>
          <h2>From the first log to the End exit.</h2>
          <p>
            Java {data?.catalog.minecraftVersion ?? "1.18.1"}: defeat the Ender
            Dragon, then use the exit portal. Routes can skip tools, preparation
            and resource gathering. A reached checkpoint records an observed
            fact; it does not imply every earlier step happened.
          </p>
        </div>
        <button
          onClick={download}
          disabled={!data}
          className="progress-download"
        >
          <Download size={15} /> Download checklist & evidence
        </button>
      </section>
      {(!online || error) && (
        <div className="notice" role="status">
          {error || "Control service disconnected."}{" "}
          {data
            ? "Showing the last received history."
            : "Waiting for progress data."}
        </div>
      )}
      {data && !data.supportedVersion && (
        <div className="notice">
          Configured server version {data.configuredVersion} differs from this{" "}
          {data.catalog.minecraftVersion} catalog. Automatic tracking for this
          version is unsupported.
        </div>
      )}
      {data && (
        <>
          <div className="progress-summary-grid">
            <section className="panel progress-stat">
              <small>Milestones observed</small>
              <strong>
                {observed}
                <span> / {data.catalog.steps.length}</span>
              </strong>
              <p>
                Includes alternatives and optional goals; this is not a
                game-completion percentage.
              </p>
            </section>
            <section className="panel progress-stat">
              <small>Agents with tracking hooks</small>
              <strong>
                {data.tracking.supported}
                <span> / {data.tracking.agents}</span>
              </strong>
              <p>
                {data.tracking.unsupported
                  ? `${data.tracking.unsupported} backend/version combinations lack a tracking hook.`
                  : "Native tracking runs independently of policy input selection."}
              </p>
            </section>
            <section className="panel progress-stat">
              <small>History scope</small>
              <strong>{runId ? "This run" : "All runs"}</strong>
              <p>
                First evidence persists through generations, world resets and
                service restarts.
              </p>
            </section>
          </div>
          <section className="panel progress-filters">
            <label>
              Experiment/run
              <select value={runId} onChange={(e) => setRunId(e.target.value)}>
                <option value="">Any agent · all historical runs</option>
                {runId && !runs.some((run) => run.id === runId) && (
                  <option value={runId}>
                    {runId.slice(0, 8)} · historical run
                  </option>
                )}
                {runs
                  .filter((run) => run.spec.mode === "minecraft")
                  .map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.spec.stage} · {run.id.slice(0, 8)} · {run.status}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Step type
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="all">Every step</option>
                {Object.entries(labels).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select value={state} onChange={(e) => setState(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="reached">Reached</option>
                <option value="pending">Not confirmed yet</option>
              </select>
            </label>
            <label className="progress-search">
              Find a step/item
              <div>
                <Search size={15} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Eyes, blaze rods, portal…"
                />
              </div>
            </label>
            <label className="progress-mode-filter">
              <input
                type="checkbox"
                checked={survival}
                onChange={(e) => setSurvival(e.target.checked)}
              />{" "}
              Survival/adventure evidence only
            </label>
            <p>
              Setup and previously earned evidence are labeled. Survival mode
              alone does not certify an unassisted run. No progress was
              reconstructed for old inactive agents without recorded evidence.
            </p>
          </section>
          {data.catalog.groups.map((group) => {
            const steps = displayed.filter((step) => step.group === group.id);
            if (!steps.length) return null;
            return (
              <section key={group.id} className="panel progress-group">
                <header>
                  <h2>
                    <MinecraftIcon
                      name={progressGroupIcons[group.id] ?? "book"}
                      size={28}
                    />
                    {group.title}
                  </h2>
                  <span>
                    {steps.filter((step) => reached(step.id) > 0).length} /{" "}
                    {steps.length} shown reached
                  </span>
                </header>
                <div className="progress-step-list">
                  {steps.map((step) => {
                    const count = reached(step.id);
                    const summary = summaries.get(step.id);
                    const first = survival
                      ? summary?.firstSurvival
                      : summary?.first;
                    const manual =
                      step.rules.every((rule) =>
                        ["manual", "server-event"].includes(rule.kind),
                      ) && !data.attributionReady;
                    const status =
                      count > 0
                        ? "Reached"
                        : manual
                          ? "Awaiting server hook"
                          : "Not observed";
                    const Icon =
                      count > 0 ? CheckCircle2 : manual ? CircleHelp : Circle;
                    return (
                      <details
                        key={step.id}
                        className={`progress-step ${count ? "progress-reached" : ""}`}
                      >
                        <summary>
                          <MinecraftIcon
                            name={progressIcons[step.id] ?? "book"}
                            size={32}
                          />
                          <Icon
                            className="progress-step-icon"
                            size={20}
                            aria-hidden
                          />
                          <div className="progress-step-title">
                            <strong>{step.title}</strong>
                            <small>
                              {labels[step.requirement]} · {step.id}
                            </small>
                          </div>
                          <span
                            className={`progress-status ${count ? "is-reached" : ""}`}
                          >
                            {status}
                            {count > 0
                              ? ` · ${count} agent${count === 1 ? "" : "s"}`
                              : ""}
                          </span>
                        </summary>
                        <div className="progress-step-detail">
                          <ol>
                            {step.instructions.map((instruction, i) => (
                              <li key={i}>{instruction}</li>
                            ))}
                          </ol>
                          <dl>
                            <dt>Items</dt>
                            <dd>{step.items}</dd>
                            <dt>Conditional minimum</dt>
                            <dd>{step.minimum}</dd>
                            <dt>Alternatives and limits</dt>
                            <dd>{step.alternatives}</dd>
                          </dl>
                          {first && (
                            <div className="progress-evidence">
                              <h3>First recorded evidence</h3>
                              <p>
                                <strong>{first.username}</strong> · run{" "}
                                <button
                                  className="run-link"
                                  onClick={() => setRunId(first.runId)}
                                >
                                  {first.runId.slice(0, 8)}
                                </button>{" "}
                                · generation {first.episode || "setup"} ·{" "}
                                <time
                                  dateTime={new Date(first.at).toISOString()}
                                >
                                  {new Date(first.at).toLocaleString()}
                                </time>
                              </p>
                              <p>
                                {first.source} · {first.gameMode} ·{" "}
                                {first.origin}
                              </p>
                              <p>{first.detail}</p>
                            </div>
                          )}
                          <h3>Automatic evidence rules</h3>
                          <ul className="progress-rule-list">
                            {step.rules.map((rule, i) => (
                              <li key={i}>
                                {rule.kind === "manual"
                                  ? rule.reason
                                  : rule.kind === "server-event"
                                    ? `Read-only Paper attribution: ${rule.event}. ${data.attributionReady ? "Hook loaded." : "Build the viewer plugin and restart Minecraft to load the hook."}`
                                    : rule.kind === "inventory"
                                      ? `Inventory contains ${rule.count ?? 1} matching ${rule.items?.join(" / ") ?? `item ending ${rule.suffix}`}; no crafting/source inference.`
                                      : rule.kind === "advancement"
                                        ? `Completed ${rule.id} using the received requirements.`
                                        : rule.kind === "statistic"
                                          ? `${rule.category} statistic: ${rule.names.join(" / ")} ≥ ${rule.count ?? 1}.`
                                          : rule.kind === "block"
                                            ? `Nearby loaded ${rule.names.join(" / ")}${rule.properties ? ` with ${JSON.stringify(rule.properties)}` : ""}; no placement ownership inferred.`
                                            : rule.kind === "window"
                                              ? `Opened ${rule.type} menu.`
                                              : rule.kind === "dimension"
                                                ? `Observed dimension ${rule.name}.`
                                                : rule.kind === "credits"
                                                  ? "Received End win-game event."
                                                  : "Overworld return after recorded End win-game event."}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </details>
                    );
                  })}
                </div>
              </section>
            );
          })}
          {!displayed.length && (
            <section className="panel progress-intro">
              <p>No steps match these filters.</p>
            </section>
          )}
          <section className="panel progress-resources">
            <h2>Minimum resource ledger</h2>
            <p>
              These are conditional floors for the chosen route. Search losses,
              RNG, loot, supplied equipment and terrain change the actual
              budget.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Conditional minimum</th>
                    <th>Route and limits</th>
                  </tr>
                </thead>
                <tbody>
                  {data.catalog.resources.map((resource) => (
                    <tr key={resource.item}>
                      <td>{resource.item}</td>
                      <td>{resource.minimum}</td>
                      <td>
                        {resource.route}
                        <small>{resource.notes}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {!data && !error && (
        <section className="panel progress-intro" role="status">
          Loading the progression catalog and agent history…
        </section>
      )}
    </div>
  );
}
