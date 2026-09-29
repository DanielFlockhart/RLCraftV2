"use client";
import { useEffect, useState } from "react";
import {
  defaultInputs,
  type AgentInputConfig,
  type BackendSnapshot,
  type Mode,
} from "@rlcraft/core";

export function BackendSelector({
  mode,
  value,
  inputs,
  onChange,
}: {
  mode: Mode;
  value?: string;
  inputs?: AgentInputConfig;
  onChange(value: string): void;
}) {
  const [catalog, setCatalog] = useState<{
    defaultMinecraft: string;
    backends: BackendSnapshot[];
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/control/backends", { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error ?? "Backend catalog unavailable");
        setCatalog(result);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message);
      });
    return () => controller.abort();
  }, []);
  const selectedId =
    value ??
    (mode === "simulator"
      ? "simulator"
      : (catalog?.defaultMinecraft ?? "mineflayer"));
  const backend = catalog?.backends.find(
    (entry) => entry.descriptor.id === selectedId,
  );
  const descriptor = backend?.descriptor;
  const config = inputs ?? defaultInputs;
  const limited = Object.entries(config.channels)
    .filter(
      ([id, channel]) =>
        channel.enabled &&
        (!descriptor?.inputSupport[id] ||
          ["external", "unsupported"].includes(descriptor.inputSupport[id])),
    )
    .map(([id]) => id);
  return (
    <section className="setup-run input-editor backend-selector">
      <h3>Agent backend</h3>
      <label>
        Registered implementation
        <select
          value={selectedId}
          disabled={!catalog}
          onChange={(event) => onChange(event.target.value)}
        >
          {!catalog && (
            <option value={selectedId}>{selectedId} · loading registry</option>
          )}
          {catalog?.backends
            .filter((entry) => entry.descriptor.mode === mode)
            .map(({ descriptor }) => (
              <option key={descriptor.id} value={descriptor.id}>
                {descriptor.label} · {descriptor.version}
              </option>
            ))}
          {catalog && !backend && (
            <option value={selectedId} disabled>
              {selectedId} · unavailable
            </option>
          )}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {descriptor && (
        <>
          <p>{descriptor.description}</p>
          <p>
            Backend selection is saved with this run. Your policy reads the same
            selected input schema across implementations.
          </p>
          {limited.length > 0 && (
            <p className="backend-limit" role="status">
              {limited.length} selected channels need an external producer or
              are unsupported. These report unavailable until supplied.
            </p>
          )}
          <details>
            <summary>Input coverage and limitations</summary>
            <div className="backend-coverage">
              {Object.entries(descriptor.inputSupport).map(([id, support]) => (
                <div key={id}>
                  <code>{id}</code>
                  <span>{support}</span>
                </div>
              ))}
            </div>
            <ul>
              {descriptor.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </details>
        </>
      )}
      <p>
        Additional backends appear after installing an adapter profile and
        restarting control. Research candidates are not advertised as installed
        implementations.
      </p>
    </section>
  );
}
