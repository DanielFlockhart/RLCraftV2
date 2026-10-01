"use client";
import { X } from "lucide-react";
import type { AgentState } from "@mlcraft/core";

export function AgentMinimap({
  agents,
  onClose,
}: {
  agents: AgentState[];
  onClose: () => void;
}) {
  const located = agents.filter(
    (agent) =>
      agent.position &&
      ["active", "paused", "resetting"].includes(agent.status),
  );
  const xs = located.map((agent) => agent.position!.x);
  const zs = located.map((agent) => agent.position!.z);
  const centerX = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const centerZ = zs.length ? (Math.min(...zs) + Math.max(...zs)) / 2 : 0;
  const span = Math.max(
    64,
    xs.length ? Math.max(...xs) - Math.min(...xs) + 32 : 64,
    zs.length ? Math.max(...zs) - Math.min(...zs) + 32 : 64,
  );
  return (
    <div
      className="minimap-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="minimap-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Agent minimap"
      >
        <div className="minimap-heading">
          <div>
            <h2>Agent minimap</h2>
            <p>
              Top-down X/Z positions · {located.length} located agent
              {located.length === 1 ? "" : "s"}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close minimap">
            <X size={18} />
          </button>
        </div>
        <div
          className="minimap-plot"
          role="img"
          aria-label="Top-down plot of connected agent positions"
        >
          <span className="minimap-north">N · −Z</span>
          <span className="minimap-east">+X · E</span>
          <span
            className="minimap-origin"
            style={{
              left: `${50 + ((0 - centerX) / span) * 80}%`,
              top: `${50 + ((0 - centerZ) / span) * 80}%`,
            }}
          >
            +
          </span>
          {located.map((agent) => (
            <span
              key={agent.id}
              className="minimap-marker"
              style={{
                left: `${50 + ((agent.position!.x - centerX) / span) * 80}%`,
                top: `${50 + ((agent.position!.z - centerZ) / span) * 80}%`,
              }}
              title={`${agent.username}: X ${agent.position!.x.toFixed(1)}, Z ${agent.position!.z.toFixed(1)}`}
            >
              {agent.username}
            </span>
          ))}
          {!located.length && (
            <p className="minimap-empty">
              No connected agents have reported a position yet.
            </p>
          )}
        </div>
        <p className="muted">
          Coordinate view from agent telemetry. Terrain and world dimension are
          not available in the current snapshot.
        </p>
        <ul className="minimap-list">
          {located.map((agent) => (
            <li key={agent.id}>
              <strong>{agent.username}</strong>
              <span>
                X {agent.position!.x.toFixed(1)} · Y{" "}
                {agent.position!.y.toFixed(1)} · Z{" "}
                {agent.position!.z.toFixed(1)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
