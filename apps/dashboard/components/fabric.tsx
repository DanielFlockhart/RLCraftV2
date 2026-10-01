"use client";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_RENDER_SETTINGS,
  type AgentState,
  type CaptureFrame,
  type RenderSettings,
} from "@mlcraft/core";
import { MinecraftIcon } from "./minecraft-icon";

export function FabricSettings({
  value,
  onChange,
  act,
}: {
  value?: RenderSettings;
  onChange: (settings: RenderSettings) => void;
  act: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const settings = value ?? DEFAULT_RENDER_SETTINGS;
  const [status, setStatus] = useState<{
    ready: boolean;
    reason: string;
    preparation: { status: string; error?: string };
    maxClients: number;
    activeClients: number;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/control/clients", {
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (!stopped) setStatus(result);
      } catch (error) {
        if (!stopped) setError((error as Error).message);
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  return (
    <section className="setup-run input-editor fabric-settings">
      <h3>
        <MinecraftIcon name="compass" size={20} /> Real Minecraft camera
      </h3>
      <p>
        Each agent runs its own Minecraft 1.18.1 client. Its first-person image
        includes the game’s textures, lighting, particles, held items and
        selected HUD. A display and OpenGL driver are required.
      </p>
      <div className="input-actions">
        <button
          type="button"
          disabled={
            status?.preparation.status === "running" || !!status?.activeClients
          }
          onClick={async () => {
            try {
              setError("");
              await act("clients/prepare", {});
            } catch (error) {
              setError((error as Error).message);
            }
          }}
        >
          {status?.preparation.status === "running"
            ? "Preparing clients…"
            : "Prepare / update Fabric clients"}
        </button>
        <span role="status">
          {status?.ready
            ? "Client runtime ready"
            : "Client runtime needs preparation"}{" "}
          · {status?.activeClients ?? 0}/{status?.maxClients ?? "…"} renderer
          slots in use
        </span>
      </div>
      {(error || status?.preparation.error) && (
        <p role="alert">{error || status?.preparation.error}</p>
      )}
      <div className="input-limit-grid">
        {(
          [
            ["width", "Image width", 64, 512],
            ["height", "Image height", 64, 512],
            ["fps", "Capture frames / second", 1, 30],
            ["viewDistance", "View distance (chunks)", 2, 16],
          ] as const
        ).map(([key, label, min, max]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              value={settings[key]}
              onChange={(event) =>
                onChange({ ...settings, [key]: Number(event.target.value) })
              }
            />
          </label>
        ))}
      </div>
      <label className="input-switch">
        <input
          type="checkbox"
          checked={settings.showHud}
          onChange={(event) =>
            onChange({ ...settings, showHud: event.target.checked })
          }
        />{" "}
        Include player HUD
      </label>
      <label className="input-switch">
        <input
          type="checkbox"
          checked={settings.visibleWindow}
          onChange={(event) =>
            onChange({ ...settings, visibleWindow: event.target.checked })
          }
        />{" "}
        Show each game window locally
      </label>
      <p>
        The dashboard camera remains available when RGB policy inputs are
        disabled. Rendered agents have their own capacity limit; begin with one
        client. Capture rate does not change Minecraft tick speed.
      </p>
    </section>
  );
}

export function AgentFeed({
  agent,
  online,
}: {
  agent: AgentState;
  online: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<CaptureFrame>();
  const [reason, setReason] = useState("Waiting for the agent’s camera…");
  const [enabled, setEnabled] = useState(true),
    [rate, setRate] = useState(5),
    [now, setNow] = useState(Date.now());
  const [soundMuted, setSoundMuted] = useState<boolean>();
  const [soundBusy, setSoundBusy] = useState(false);
  const [soundError, setSoundError] = useState("");
  const soundPath = `/api/control/runs/${agent.runId}/agents/${agent.username}/sound`;
  useEffect(() => {
    setSoundMuted(undefined);
    setSoundError("");
    if (!online) return;
    const controller = new AbortController();
    void fetch(soundPath, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Sound state unavailable");
        setSoundMuted(result.muted);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setSoundError((error as Error).message);
      });
    return () => controller.abort();
  }, [soundPath, online]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setFrame(undefined);
    if (!online || !enabled) {
      setReason(
        !online ? "Control service disconnected." : "Feed viewing paused.",
      );
      return;
    }
    const controller = new AbortController();
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    setReason("Waiting for the agent’s camera…");
    async function poll() {
      const started = performance.now();
      try {
        const response = await fetch(
          `/api/control/runs/${agent.runId}/agents/${agent.username}/feed`,
          { signal: controller.signal, cache: "no-store" },
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error ?? "Agent feed unavailable");
        if (!stopped) {
          if (result.status === "ready") {
            setFrame(result.frame);
            setReason("");
          } else {
            setFrame(undefined);
            setReason(result.reason);
          }
        }
      } catch (error) {
        if (!stopped) {
          setFrame(undefined);
          setReason((error as Error).message);
        }
      }
      if (!stopped)
        timer = setTimeout(
          poll,
          Math.max(0, 1000 / rate - (performance.now() - started)),
        );
    }
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [agent.id, agent.runId, agent.username, online, enabled, rate]);
  const fresh = !!frame && now - frame.capturedAt <= 2000;
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    if (!fresh || !frame) {
      context.clearRect(0, 0, canvas.current!.width, canvas.current!.height);
      return;
    }
    try {
      const bytes = atob(frame.data),
        width = frame.width!,
        height = frame.height!;
      if (
        frame.kind !== "rgb" ||
        frame.encoding !== "rgb8" ||
        width < 1 ||
        height < 1 ||
        width > 512 ||
        height > 512 ||
        bytes.length !== width * height * 3
      )
        throw new Error("Invalid RGB frame");
      const image = context.createImageData(width, height);
      for (let i = 0; i < width * height; i++) {
        image.data[i * 4] = bytes.charCodeAt(i * 3);
        image.data[i * 4 + 1] = bytes.charCodeAt(i * 3 + 1);
        image.data[i * 4 + 2] = bytes.charCodeAt(i * 3 + 2);
        image.data[i * 4 + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    } catch (error) {
      setFrame(undefined);
      setReason((error as Error).message);
    }
  }, [frame, fresh]);
  return (
    <section
      className="panel agent-feed"
      aria-label={`Live camera for ${agent.username}`}
    >
      <header>
        <div>
          <h3>{agent.username} · first-person feed</h3>
          <p>Actual game framebuffer from this agent’s own client.</p>
        </div>
        <span className={`feed-status ${fresh ? "is-live" : ""}`} role="status">
          {fresh ? "Live" : enabled ? "Unavailable" : "Viewing paused"}
        </span>
      </header>
      <div className="feed-screen">
        <canvas
          ref={canvas}
          width={frame?.width ?? 256}
          height={frame?.height ?? 192}
          aria-label="Agent RGB camera"
          hidden={!fresh}
        />
        {!fresh && (
          <p role="status">
            {frame
              ? "The last image is stale. Waiting for a fresh frame…"
              : reason}
          </p>
        )}
      </div>
      <footer>
        <button type="button" onClick={() => setEnabled(!enabled)}>
          {enabled ? "Pause feed viewing" : "Resume feed viewing"}
        </button>
        <button
          type="button"
          disabled={soundMuted === undefined || soundBusy || !online}
          aria-pressed={soundMuted ?? false}
          onClick={async () => {
            setSoundBusy(true);
            setSoundError("");
            try {
              const response = await fetch(soundPath, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ muted: !soundMuted }),
              });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error ?? "Sound control failed");
              setSoundMuted(result.muted);
            } catch (error) {
              setSoundError((error as Error).message);
            } finally {
              setSoundBusy(false);
            }
          }}
        >
          {soundMuted === undefined ? "Loading sound…" : soundMuted ? "Unmute agent" : "Mute agent"}
        </button>
        <label>
          Viewer refresh
          <select
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
          >
            <option value={1}>1 / second</option>
            <option value={5}>5 / second</option>
            <option value={10}>10 / second</option>
          </select>
        </label>
        <span>
          {fresh && frame
            ? `${frame.width} × ${frame.height} · frame ${frame.sequence} · ${Math.max(0, now - frame.capturedAt)} ms old`
            : "Training controls are independent of feed viewing."}
        </span>
      </footer>
      {soundError && <p role="alert">{soundError}</p>}
    </section>
  );
}
