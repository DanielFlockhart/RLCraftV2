"use client";
import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Run } from "@mlcraft/core";
import { interactionSessions } from "../../../packages/core/src/interaction";

type WorldStatus = { ready: boolean; reason: string };
type Trial = { episode: number; successRate: number; meanDurationMs: number; heldOut: boolean; failures: Record<string, number> };
const active = new Set(["queued", "running", "paused", "pausing"]);
const jsonl = (body: string): Trial[] => body.split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line) as Trial]; } catch { return []; }
});

export function InteractionTraining({ runs, online, act, maxAgents }: {
  runs: Run[];
  online: boolean;
  act: (path: string, body?: unknown) => Promise<unknown>;
  maxAgents: number;
}) {
  const interactionRuns = runs.filter((run) => run.spec.stage === "interaction");
  const current = interactionRuns.find((run) => active.has(run.status));
  const otherMinecraftActive = runs.some((run) => run.spec.mode === "minecraft" && run.spec.stage !== "interaction" && active.has(run.status));
  const [world, setWorld] = useState<WorldStatus>();
  const [busy, setBusy] = useState(false);
  const [agents, setAgents] = useState(Math.min(8, maxAgents));
  const [episodes, setEpisodes] = useState(32);
  const [seed, setSeed] = useState(42);
  const [selectedId, setSelectedId] = useState("");
  const [trials, setTrials] = useState<Trial[]>([]);
  const selected = interactionRuns.find((run) => run.id === selectedId) ?? interactionRuns[0];
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/control/phase3c/world", { signal: controller.signal, cache: "no-store" });
        if (response.ok) setWorld(await response.json());
        if (selected) {
          const result = await fetch(`/api/control/runs/${selected.id}/artifacts/interaction-trials.jsonl`, { signal: controller.signal, cache: "no-store" });
          if (result.ok) setTrials(jsonl(await result.text()));
        }
      } catch {}
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [online, selected?.id]);
  async function perform(path: string, body: unknown = {}) {
    setBusy(true);
    try { await act(path, body); } finally { setBusy(false); }
  }
  return <div className="interaction-training">
    <section className="panel">
      <h3>Phase 3C · interaction skills</h3>
      <p>Targeting and mining use real player controls in isolated Minecraft cells. Each request returns success, a structured failure reason, state changes, duration, and action counts. The current baseline is deterministic; these runs measure reliability and do not train neural weights.</p>
      <button disabled={!online || busy || !!current || otherMinecraftActive || world?.ready} onClick={() => perform("phase3c/world")}>Prepare interaction world</button>
      <span role="status"> {world?.ready ? "Interaction world ready" : world?.reason ?? "Checking interaction world…"}</span>
      {otherMinecraftActive && <p role="status">Another Minecraft training run is active. Finish or stop it before switching worlds.</p>}
    </section>
    <section className="panel">
      <h3>Session settings</h3>
      <div className="input-limit-grid">
        <label><span>Agents</span><input type="number" min={1} max={maxAgents} value={agents} onChange={(event) => setAgents(Number(event.target.value))} /></label>
        <label><span>Trial episodes</span><input type="number" min={1} max={100000} value={episodes} onChange={(event) => setEpisodes(Number(event.target.value))} /></label>
        <label><span>Seed</span><input type="number" min={0} max={2147483647} value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
      </div>
      <p>For A1, M1, and M2, every fifth trial uses separate evaluation seeds. Results are recorded for each agent and trial.</p>
    </section>
    <div className="stage-grid">
      {interactionSessions.map((session) => <section className="stage-card" key={session.id}>
        <div className="stage-top"><span className="stage-number">{session.id}</span><span>{session.skill}</span></div>
        <h3>{session.name}</h3><p>{session.detail}</p>
        <button type="button" disabled={!online || busy || !!current || otherMinecraftActive || !world?.ready || !Number.isInteger(agents) || agents < 1 || agents > maxAgents || !Number.isInteger(episodes) || episodes < 1 || !Number.isInteger(seed) || seed < 0} onClick={() => perform("phase3c/sessions", { session: session.id, agents, episodes, seed })}>Start {session.id}</button>
      </section>)}
    </div>
    <section className="panel">
      <h3>Trial performance</h3>
      {interactionRuns.length > 0 && <select aria-label="Interaction run" value={selected?.id ?? ""} onChange={(event) => { setSelectedId(event.target.value); setTrials([]); }}>
        {interactionRuns.map((run) => <option key={run.id} value={run.id}>{run.spec.interaction} · {run.status} · {run.id.slice(0, 8)}</option>)}
      </select>}
      {selected && <p>{selected.spec.interaction} · {selected.status} · trial {selected.episode}/{selected.spec.episodes}{selected.error ? ` · ${selected.error}` : ""}</p>}
      {current && <div className="input-actions">
        {current.status === "running" && <button onClick={() => perform(`runs/${current.id}/pause`)}>Pause</button>}
        {current.status === "paused" && <button onClick={() => perform(`runs/${current.id}/resume`)}>Resume</button>}
        <button onClick={() => perform(`runs/${current.id}/cancel`)}>Cancel</button>
      </div>}
      {trials.length ? <>
        <div style={{ width: "100%", height: 250 }}><ResponsiveContainer><LineChart data={trials}>
          <CartesianGrid stroke="#344b3b" /><XAxis dataKey="episode" /><YAxis domain={[0, 1]} /><Tooltip />
          <Line type="monotone" dataKey="successRate" name="Success rate" stroke="#8ae3ac" dot={false} isAnimationActive={false} />
        </LineChart></ResponsiveContainer></div>
        <p>Latest: {Math.round(trials.at(-1)!.successRate * 100)}% success · {Math.round(trials.at(-1)!.meanDurationMs)} ms mean duration · {trials.at(-1)!.heldOut ? "held-out" : "training"} trial.</p>
        <p>Failures: {Object.entries(trials.at(-1)!.failures).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"}</p>
      </> : <p>Completed trial results will appear here.</p>}
    </section>
  </div>;
}
