"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Download, Minus, Plus, RefreshCw } from "lucide-react";
import {
  stages,
  type ModelInspection,
  type ModelSnapshot,
  type ModelValue,
  type Run,
  type StageId,
} from "@mlcraft/core";
import { MinecraftIcon, stageIcons } from "./minecraft-icon";

const count = (value?: number) =>
  value === undefined ? "Unknown" : value.toLocaleString();
const show = (value: ModelValue) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
function graphLayout(model?: ModelInspection) {
  const incoming = new Set(model?.edges.map((edge) => edge.to));
  const depth = new Map<string, number>();
  const roots = model?.nodes.filter((node) => !incoming.has(node.id)) ?? [];
  function visit(root: string) {
    const queue = [root];
    depth.set(root, 0);
    for (let index = 0; index < queue.length; index++)
      for (const edge of model?.edges ?? []) {
        if (edge.from === queue[index] && !depth.has(edge.to)) {
          depth.set(edge.to, depth.get(edge.from)! + 1);
          queue.push(edge.to);
        }
      }
  }
  roots.forEach((root) => visit(root.id));
  for (const node of model?.nodes ?? [])
    if (!depth.has(node.id)) visit(node.id);
  const rows = new Map<number, number>(),
    positions = new Map<string, { x: number; y: number }>();
  for (const node of model?.nodes ?? []) {
    const column = depth.get(node.id)!,
      row = rows.get(column) ?? 0;
    positions.set(node.id, { x: 30 + column * 340, y: 30 + row * 170 });
    rows.set(column, row + 1);
  }
  return {
    positions,
    width: Math.max(1040, (Math.max(0, ...rows.keys()) + 1) * 340 + 30),
    height: Math.max(360, Math.max(0, ...rows.values()) * 170 + 30),
  };
}
function Fields({ values }: { values: Record<string, ModelValue> }) {
  return Object.keys(values).length ? (
    <dl className="model-fields">
      {Object.entries(values).map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <pre>{show(value)}</pre>
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="model-empty">No values exposed by this component.</p>
  );
}
export function Architecture({
  runs,
  online,
}: {
  runs: Run[];
  online: boolean;
}) {
  const [source, setSource] = useState("configured");
  const [stage, setStage] = useState<StageId>("movement");
  const [snapshot, setSnapshot] = useState<ModelSnapshot>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [variantIndex, setVariantIndex] = useState(0);
  const [nodeId, setNodeId] = useState("");
  const [zoom, setZoom] = useState(1);
  const [search, setSearch] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<
    { x: number; y: number; left: number; top: number } | undefined
  >(undefined);
  const marker = `model-arrow-${useId().replaceAll(":", "")}`;
  const selectedRun = runs.find((run) => run.id === source);
  const terminal =
    selectedRun &&
    !["running", "paused", "pausing", "queued"].includes(selectedRun.status);
  useEffect(() => {
    setSnapshot(undefined);
    setError("");
    setVariantIndex(0);
    setNodeId("");
    if (!online) return;
    const controller = new AbortController();
    let stopped = false,
      timer: ReturnType<typeof setTimeout>,
      force = refresh > 0;
    async function poll() {
      try {
        const route =
          source === "configured" ? `stage/${stage}` : `run/${source}`;
        const response = await fetch(
          `/api/control/models/${route}${force ? "?fresh=1" : ""}`,
          { signal: controller.signal },
        );
        force = false;
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error ?? "Model inspection failed");
        if (!stopped) {
          setSnapshot(value);
          setError("");
        }
      } catch (failure) {
        if (!stopped) {
          setSnapshot(undefined);
          setError((failure as Error).message);
        }
      }
      if (!stopped)
        timer = setTimeout(poll, source === "configured" ? 5000 : 2000);
    }
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [source, stage, online, refresh]);
  const variant = snapshot?.variants[variantIndex] ?? snapshot?.variants[0];
  const model = variant?.inspection;
  const node =
    model?.nodes.find((item) => item.id === nodeId) ?? model?.nodes[0];
  const { width, height, positions } = useMemo(
    () => graphLayout(model),
    [model],
  );
  const stale =
    snapshot?.source === "runtime" &&
    !terminal &&
    Date.now() - snapshot.sampledAt > 10000;
  function download() {
    if (!snapshot) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${snapshot.stage}-models.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="model-page">
      <div className="panel model-toolbar">
        <label>
          Model source
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="configured">
              Current registry · configured models
            </option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.spec.stage} · {run.id.slice(0, 8)} · {run.status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Training stage
          <select
            value={
              source === "configured"
                ? stage
                : (selectedRun?.spec.stage ?? stage)
            }
            disabled={source !== "configured"}
            onChange={(event) => setStage(event.target.value as StageId)}
          >
            {stages.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!online}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={15} />
          Refresh inspection
        </button>
        <button disabled={!snapshot} onClick={download}>
          <Download size={15} />
          Export JSON
        </button>
      </div>
      {!online ? (
        <div className="panel model-notice">
          Connect the control service to inspect models.
        </div>
      ) : error ? (
        <div role="status" className="panel model-notice">
          {error}
        </div>
      ) : !snapshot ? (
        <div className="panel model-notice">
          Inspecting instantiated model components…
        </div>
      ) : (
        <>
          <div className="panel model-summary">
            <MinecraftIcon name={stageIcons[snapshot.stage]} size={36} />
            <div>
              <h2>
                {stages.find((item) => item.id === snapshot.stage)?.name} models
              </h2>
              <p>
                {snapshot.source === "configured"
                  ? "Factory preview · no training started"
                  : `${terminal ? "Saved run snapshot" : "Runtime snapshot"} · generation ${snapshot.episode} · step ${snapshot.tick}`}
              </p>
              <small>
                Inspected {new Date(snapshot.sampledAt).toLocaleString()}
                {snapshot.codeVersion
                  ? ` · source ${snapshot.codeVersion.slice(0, 12)}`
                  : ""}
              </small>
            </div>
            <span className="model-status">
              {stale
                ? "Awaiting fresh runtime sample"
                : terminal
                  ? "Historical"
                  : snapshot.source === "runtime"
                    ? "Live · samples every 2s"
                    : "Source changes checked every 5s"}
            </span>
          </div>
          {snapshot.source === "configured" && (
            <p className="model-caption">
              Preview reads current registry factories. Models created lazily
              during reset or restored from checkpoints are shown in the run’s
              runtime view. Code edits affect new previews; existing runs retain
              their instantiated models.
            </p>
          )}
          {!snapshot.variants.length ? (
            <div className="panel model-notice">
              This component runs the environment without executing a policy or
              trainer. No active AI models to inspect.
            </div>
          ) : (
            <>
              <div
                className="model-variants"
                role="group"
                aria-label="Model variants"
              >
                {snapshot.variants.map((item, index) => (
                  <button
                    key={`${item.role}:${item.fingerprint}`}
                    aria-pressed={variant === item}
                    onClick={() => {
                      setVariantIndex(index);
                      setNodeId("");
                    }}
                  >
                    {item.role} · {item.inspection.implementation}
                    {item.agents.length
                      ? ` · ${item.agents.length} agent${item.agents.length === 1 ? "" : "s"}`
                      : " · shared trainer"}
                  </button>
                ))}
              </div>
              {model && (
                <>
                  <div className="model-stats">
                    <div className="panel">
                      <small>Implementation</small>
                      <strong>{model.implementation}</strong>
                      <span>{model.framework}</span>
                    </div>
                    <div className="panel">
                      <small>Total parameters</small>
                      <strong>{count(model.parameters)}</strong>
                      <span>From the model inspector</span>
                    </div>
                    <div className="panel">
                      <small>Trainable parameters</small>
                      <strong>{count(model.trainableParameters)}</strong>
                      <span>{model.nodes.length} inspected modules</span>
                    </div>
                    <div className="panel">
                      <small>Inspection status</small>
                      <strong>{model.status}</strong>
                      <span>
                        Fingerprint {variant!.fingerprint.slice(0, 12)}
                      </span>
                    </div>
                  </div>
                  {model.reason && (
                    <div role="status" className="panel model-notice">
                      {model.reason}
                    </div>
                  )}
                  <div className="model-layout">
                    <div className="panel model-diagram">
                      <div className="model-diagram-tools">
                        <h2>Architecture</h2>
                        <input
                          aria-label="Find a model module"
                          placeholder="Find a module…"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                        <button
                          aria-label="Zoom out"
                          onClick={() =>
                            setZoom((value) => Math.max(0.3, value - 0.1))
                          }
                        >
                          <Minus size={15} />
                        </button>
                        <span>{Math.round(zoom * 100)}%</span>
                        <button
                          aria-label="Zoom in"
                          onClick={() =>
                            setZoom((value) => Math.min(2, value + 0.1))
                          }
                        >
                          <Plus size={15} />
                        </button>
                        <button
                          onClick={() => {
                            setZoom(
                              viewport.current
                                ? Math.min(
                                    1,
                                    (viewport.current.clientWidth - 24) / width,
                                  )
                                : 1,
                            );
                            viewport.current?.scrollTo(0, 0);
                          }}
                        >
                          Fit
                        </button>
                      </div>
                      <p className="model-caption">
                        Select a module for details. Drag the canvas to pan.
                        Edges show inspector-provided relationships; “contains”
                        means module hierarchy.
                      </p>
                      <div
                        ref={viewport}
                        className="model-canvas"
                        onPointerDown={(event) => {
                          if (
                            (event.target as Element).closest('[role="button"]')
                          )
                            return;
                          drag.current = {
                            x: event.clientX,
                            y: event.clientY,
                            left: event.currentTarget.scrollLeft,
                            top: event.currentTarget.scrollTop,
                          };
                          event.currentTarget.setPointerCapture(
                            event.pointerId,
                          );
                        }}
                        onPointerMove={(event) => {
                          if (!drag.current) return;
                          event.currentTarget.scrollLeft =
                            drag.current.left - event.clientX + drag.current.x;
                          event.currentTarget.scrollTop =
                            drag.current.top - event.clientY + drag.current.y;
                        }}
                        onPointerUp={() => {
                          drag.current = undefined;
                        }}
                        onPointerCancel={() => {
                          drag.current = undefined;
                        }}
                      >
                        {!model.nodes.length ? (
                          <p className="model-empty">
                            No graph available. Connect this implementation’s
                            runtime inspector.
                          </p>
                        ) : (
                          <svg
                            width={width * zoom}
                            height={height * zoom}
                            viewBox={`0 0 ${width} ${height}`}
                            role="group"
                            aria-label={`${model.implementation} model graph`}
                          >
                            <defs>
                              <marker
                                id={marker}
                                viewBox="0 0 10 10"
                                refX="9"
                                refY="5"
                                markerWidth="6"
                                markerHeight="6"
                                orient="auto-start-reverse"
                              >
                                <path
                                  d="M 0 0 L 10 5 L 0 10 z"
                                  fill="currentColor"
                                />
                              </marker>
                            </defs>
                            {model.edges.map((edge, index) => {
                              const from = positions.get(edge.from)!,
                                to = positions.get(edge.to)!;
                              const x1 = from.x + 270,
                                y1 = from.y + 50,
                                x2 = to.x,
                                y2 = to.y + 50;
                              return (
                                <g key={index} className="model-edge">
                                  <path
                                    d={`M${x1},${y1} C${x1 + 35},${y1} ${x2 - 35},${y2} ${x2},${y2}`}
                                    markerEnd={`url(#${marker})`}
                                  />
                                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5}>
                                    {edge.label?.slice(0, 12)}
                                    <title>{edge.label}</title>
                                  </text>
                                </g>
                              );
                            })}
                            {model.nodes.map((item, index) => {
                              const p = positions.get(item.id)!;
                              const matches =
                                !search ||
                                `${item.label} ${item.kind}`
                                  .toLowerCase()
                                  .includes(search.toLowerCase());
                              return (
                                <g
                                  key={item.id}
                                  role="button"
                                  tabIndex={0}
                                  aria-label={`Inspect ${item.label}, ${item.kind}`}
                                  aria-pressed={node?.id === item.id}
                                  className={`model-node ${node?.id === item.id ? "selected" : ""} ${matches ? "" : "muted"}`}
                                  transform={`translate(${p.x},${p.y})`}
                                  onClick={() => setNodeId(item.id)}
                                  onKeyDown={(event) => {
                                    if (
                                      event.key === "Enter" ||
                                      event.key === " "
                                    ) {
                                      event.preventDefault();
                                      setNodeId(item.id);
                                    }
                                  }}
                                >
                                  <title>
                                    {item.label} · {item.kind}
                                  </title>
                                  <rect width="270" height="100" rx="8" />
                                  <text
                                    x="16"
                                    y="28"
                                    className="model-node-name"
                                  >
                                    {item.label.slice(0, 32)}
                                  </text>
                                  <text x="16" y="51">
                                    {item.kind.slice(0, 38)}
                                  </text>
                                  <text x="16" y="78">
                                    {count(item.parameters)} parameters
                                  </text>
                                </g>
                              );
                            })}
                          </svg>
                        )}
                      </div>
                    </div>
                    <aside className="panel model-details">
                      <h2>{node?.label ?? "Module details"}</h2>
                      {node && (
                        <>
                          <p className="model-caption">
                            {node.kind} · {node.id}
                          </p>
                          <Fields
                            values={{
                              ...(node.parameters !== undefined
                                ? { parameters: node.parameters }
                                : {}),
                              ...(node.trainableParameters !== undefined
                                ? {
                                    trainableParameters:
                                      node.trainableParameters,
                                  }
                                : {}),
                              ...(node.inputShape !== undefined
                                ? { inputShape: node.inputShape }
                                : {}),
                              ...(node.outputShape !== undefined
                                ? { outputShape: node.outputShape }
                                : {}),
                            }}
                          />
                          <h3>Module configuration</h3>
                          <Fields values={node.config ?? {}} />
                        </>
                      )}
                    </aside>
                  </div>
                  <div className="panel model-details">
                    <h2>Hyperparameters</h2>
                    <p className="model-caption">
                      Values reported by the instantiated component’s inspector.
                      Sampling cadence, generation lengths and run seeds remain
                      in the training controls.
                    </p>
                    <Fields values={model.hyperparameters} />
                    {!!variant?.agents.length && (
                      <>
                        <h3>
                          Agents with this model structure and configuration
                        </h3>
                        <p className="model-agent-names">
                          {variant.agents.join(", ")}
                        </p>
                        <p className="model-caption">
                          Matching metadata groups agents; their weights may
                          differ. Weight values are never exported in these
                          snapshots.
                        </p>
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
