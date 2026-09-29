"use client";
import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { AgentFeed } from "./fabric";
import {
  defaultInputs,
  inputCatalog,
  type AgentInputConfig,
  type AgentInputFrame,
  type AgentState,
} from "@rlcraft/core";
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function InputEditor({
  value,
  onChange,
}: {
  value?: AgentInputConfig;
  onChange: (value: AgentInputConfig) => void;
}) {
  const config: AgentInputConfig = value ?? defaultInputs;
  const [filter, setFilter] = useState(""),
    [json, setJson] = useState(""),
    [error, setError] = useState("");
  function preset(mode: string) {
    const next: AgentInputConfig = structuredClone(defaultInputs);
    for (const descriptor of inputCatalog.channels)
      next.channels[descriptor.id].enabled =
        mode === "minimal"
          ? [
              "self.pose",
              "self.vitals",
              "self.inventory",
              "self.controls",
            ].includes(descriptor.id)
          : mode === "all"
            ? !["vision.rgb", "audio.capture"].includes(descriptor.id)
            : descriptor.defaultEnabled;
    onChange(next);
  }
  function change(
    id: string,
    patch: Partial<AgentInputConfig["channels"][string]>,
  ) {
    onChange({
      ...config,
      channels: {
        ...config.channels,
        [id]: { ...config.channels[id], ...patch },
      },
    });
  }
  function applyJson() {
    try {
      const next = JSON.parse(json);
      if (!next.channels || !next.limits || typeof next.record !== "boolean")
        throw new Error("Configuration needs channels, limits and record");
      for (const [id, c] of Object.entries(next.channels) as [string, any][]) {
        if (
          !inputCatalog.channels.some((d) => d.id === id) ||
          typeof c.enabled !== "boolean" ||
          !Number.isFinite(c.intervalMs) ||
          (c.fields !== undefined && !Array.isArray(c.fields))
        )
          throw new Error(`Invalid channel ${id}`);
      }
      for (const key of Object.keys(defaultInputs.limits))
        if (!Number.isFinite(next.limits[key]))
          throw new Error(`Invalid limit ${key}`);
      onChange(next);
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <section className="setup-run input-editor">
      <h3>Agent inputs · player connection only</h3>
      <p>
        Enabled channels and field selections are the only observations supplied
        to the policy and trainer. Reward bookkeeping stays separate.
      </p>
      <div className="input-actions">
        <button type="button" onClick={() => preset("balanced")}>
          Balanced
        </button>
        <button type="button" onClick={() => preset("all")}>
          All native + protocol
        </button>
        <button type="button" onClick={() => preset("minimal")}>
          Minimal
        </button>
        <button
          type="button"
          onClick={() => download(config, "agent-inputs.json")}
        >
          <Download size={14} />
          Export profile
        </button>
        <a href="/api/control/inputs/catalog.json">Download full catalog</a>
      </div>
      <input
        aria-label="Search agent inputs"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Find an input: vision, audio, health…"
      />
      <div className="input-channels">
        {inputCatalog.channels
          .filter((d) =>
            `${d.id} ${d.label} ${d.fields.join(" ")}`
              .toLowerCase()
              .includes(filter.toLowerCase()),
          )
          .map((descriptor) => {
            const channel = config.channels[descriptor.id] ?? {
              enabled: false,
              intervalMs: descriptor.defaultIntervalMs,
            };
            return (
              <div key={descriptor.id} className="input-channel">
                <label className="input-switch">
                  <input
                    type="checkbox"
                    checked={channel.enabled}
                    onChange={(event) =>
                      change(descriptor.id, { enabled: event.target.checked })
                    }
                  />
                  <span>
                    <strong>{descriptor.label}</strong>
                    <small>
                      {descriptor.id} · {descriptor.source}
                    </small>
                  </span>
                </label>
                <details>
                  <summary>Fields and sampling</summary>
                  <p>
                    {descriptor.description ||
                      "Real data from this agent connection."}
                  </p>
                  <label>
                    Minimum interval (ms)
                    <input
                      type="number"
                      min={0}
                      max={60000}
                      value={channel.intervalMs}
                      onChange={(event) =>
                        change(descriptor.id, {
                          intervalMs: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <div className="input-field-options">
                    {descriptor.fields.map((field) => (
                      <label key={field}>
                        <input
                          type="checkbox"
                          checked={
                            !channel.fields || channel.fields.includes(field)
                          }
                          onChange={(event) => {
                            const fields = channel.fields ?? descriptor.fields;
                            change(descriptor.id, {
                              fields: event.target.checked
                                ? [...fields, field]
                                : fields.filter((item) => item !== field),
                            });
                          }}
                        />
                        {field}
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => change(descriptor.id, { fields: undefined })}
                  >
                    All fields
                  </button>
                </details>
              </div>
            );
          })}
      </div>
      <details className="input-limits">
        <summary>Capture limits and recording</summary>
        <p>
          High-resolution vision, large buffers and full packet capture add
          CPU/memory cost per agent. Event losses and unavailable inputs are
          reported explicitly.
        </p>
        <div className="input-limit-grid">
          {Object.entries(config.limits).map(([key, v]) => (
            <label key={key}>
              {key}
              <input
                type="number"
                min={0}
                value={v}
                onChange={(event) =>
                  onChange({
                    ...config,
                    limits: {
                      ...config.limits,
                      [key]: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
        <label className="input-switch">
          <input
            type="checkbox"
            checked={config.record}
            onChange={(event) =>
              onChange({ ...config, record: event.target.checked })
            }
          />
          Record policy input observations to inputs.jsonl
        </label>
      </details>
      <details className="input-limits">
        <summary>Edit profile JSON</summary>
        <button
          type="button"
          onClick={() => setJson(JSON.stringify(config, null, 2))}
        >
          Load current profile
        </button>
        <textarea
          aria-label="Agent input configuration JSON"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          rows={12}
        />
        <button type="button" onClick={applyJson}>
          Apply JSON
        </button>
        {error && <p role="alert">{error}</p>}
      </details>
      <div className="notice">
        Native vision provides depth and semantic geometry. Server-sound PCM
        uses vanilla audio assets; prepare them from the Inputs page. Exact RGB
        is available through the prepared Fabric client backend and its live
        camera. Mineflayer RGB and complete client audio require an external
        capture producer. Missing captures remain unavailable.
      </div>
    </section>
  );
}
function Vision({ frame }: { frame: AgentInputFrame }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = frame.channels["vision.geometry"]?.data as any;
  useEffect(() => {
    if (!data?.depth || !canvas.current) return;
    const context = canvas.current.getContext("2d");
    if (!context) return;
    const image = context.createImageData(data.width, data.height);
    for (let i = 0; i < data.depth.length; i++) {
      const value = data.valid[i]
        ? Math.round(
            255 *
              (1 -
                Math.min(1, (data.depth[i] ?? data.distance) / data.distance)),
          )
        : 0;
      image.data[i * 4] = value;
      image.data[i * 4 + 1] = value;
      image.data[i * 4 + 2] = data.valid[i] ? value : 90;
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [data]);
  return data?.depth ? (
    <div className="input-vision">
      <canvas ref={canvas} width={data.width} height={data.height} />
      <p>
        Depth projection · {data.width} × {data.height} · {data.fov}° · purple
        pixels indicate unknown terrain. This is not a vanilla RGB frame.
      </p>
    </div>
  ) : null;
}
export function LiveInputs({
  agents,
  online,
  act,
  selectedAgentId,
  embedded = false,
}: {
  agents: AgentState[];
  online: boolean;
  act?: (path: string, body?: unknown) => Promise<unknown>;
  selectedAgentId?: string;
  embedded?: boolean;
}) {
  const connected = agents.filter((agent) =>
    ["active", "paused", "dead", "resetting"].includes(agent.status),
  );
  const [selected, setSelected] = useState(""),
    [frame, setFrame] = useState<AgentInputFrame>(),
    [error, setError] = useState(""),
    [preparation, setPreparation] = useState<any>();
  const agent = connected.find((a) => a.id === selected) ?? connected[0];
  useEffect(() => {
    if (selectedAgentId) setSelected(selectedAgentId);
  }, [selectedAgentId]);
  useEffect(() => {
    if (!online || !agent) {
      setFrame(undefined);
      return;
    }
    const controller = new AbortController();
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    setFrame(undefined);
    setError("");
    async function poll() {
      try {
        const response = await fetch(
          `/api/control/runs/${agent!.runId}/agents/${agent!.username}/inputs`,
          { signal: controller.signal },
        );
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        if (!stopped) {
          setFrame(value);
          setError("");
        }
      } catch (error) {
        if (!stopped) {
          setFrame(undefined);
          setError((error as Error).message);
        }
      }
      if (!stopped) timer = setTimeout(poll, 500);
    }
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [agent?.id, agent?.status, online]);
  useEffect(() => {
    if (!online || embedded) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/control/inputs");
        if (response.ok && !stopped)
          setPreparation((await response.json()).preparation);
      } catch {}
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [online, embedded]);
  return (
    <section className="input-live">
      <div className="panel input-toolbar">
        {!embedded && (
          <label>
            Connected agent
            <select
              value={agent?.id ?? ""}
              onChange={(event) => setSelected(event.target.value)}
            >
              {connected.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.username} · {a.status}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          disabled={!frame}
          onClick={() => download(frame, "agent-observation.json")}
        >
          Export current inputs
        </button>
        <a href="/api/control/inputs/catalog.json">Full JSON catalog</a>
        {!embedded && (
          <button
            disabled={!online || !act || preparation?.status === "running"}
            onClick={async () => {
              await act?.("inputs/prepare", {});
            }}
          >
            Prepare vanilla audio assets
          </button>
        )}
        {!embedded && (
          <span>
            {preparation?.status}
            {preparation?.error ? ` · ${preparation.error}` : ""}
          </span>
        )}
      </div>
      {!embedded && agent && (
        <AgentFeed key={agent.id} agent={agent} online={online} />
      )}
      {!agent ? (
        <div className="panel input-note">
          {embedded
            ? "This agent is disconnected. Live inputs require an active connection."
            : "Start a training run to inspect its connected agents. Configure channels in ‘New training run’."}
        </div>
      ) : error ? (
        <div className="panel input-note" role="status">
          {error}
        </div>
      ) : frame ? (
        <>
          <div className="panel input-note">
            Frame {frame.sequence} · training step {frame.tick} ·{" "}
            {new Date(frame.at).toLocaleTimeString()} · lost events{" "}
            {frame.diagnostics.droppedEvents} · dropped bytes{" "}
            {frame.diagnostics.droppedBytes.toLocaleString()}
          </div>
          <Vision frame={frame} />
          <div className="input-live-grid">
            {Object.entries(frame.channels).map(([id, sample]) => (
              <details className="panel input-sample" key={id}>
                <summary>
                  <strong>
                    {inputCatalog.channels.find((d) => d.id === id)?.label ??
                      id}
                  </strong>
                  <span>{sample.status}</span>
                </summary>
                <p>
                  {id} · {sample.source} · sampled{" "}
                  {new Date(sample.sampledAt).toLocaleTimeString()} ·{" "}
                  {sample.durationMs?.toFixed(1)}ms
                </p>
                {sample.reason ? (
                  <p>{sample.reason}</p>
                ) : (
                  <pre>
                    {JSON.stringify(
                      id === "vision.rgb" && (sample.data as any)?.frame
                        ? {
                            frame: {
                              ...(sample.data as any).frame,
                              data: "RGB bytes omitted from preview; export current inputs to inspect.",
                            },
                          }
                        : sample.data,
                      null,
                      2,
                    )}
                  </pre>
                )}
              </details>
            ))}
          </div>
        </>
      ) : (
        <div className="panel input-note">Waiting for agent inputs…</div>
      )}
    </section>
  );
}
