"use client";
import { useEffect, useState } from "react";
import {
  effectiveStepMs,
  type Run,
  type RunSpec,
  type PlaybackCommand,
} from "@mlcraft/core";

const speeds = [0.25, 0.5, 1, 2, 4, 8];
function Pace({ spec, speed }: { spec: RunSpec; speed: number }) {
  const interval = effectiveStepMs(spec, speed);
  return (
    <p className="world-help">
      Requested {speed}× · effective {(spec.tickMs / interval).toFixed(2)}× ·{" "}
      {interval.toFixed(1)}ms minimum per agent step.{" "}
      {spec.mode === "minecraft"
        ? "Minecraft continues at its normal world tick rate. Sampling is capped at one step per 50ms."
        : "Component work adds to the interval; measured throughput depends on available resources."}
    </p>
  );
}
export function PlaybackSetup({
  value,
  onChange,
}: {
  value: RunSpec;
  onChange: (spec: RunSpec) => void;
}) {
  const timed =
    value.component !== "environment" && value.generationSeconds !== undefined;
  return (
    <section className="setup-run playback-panel">
      <h3>Training pace and generation length</h3>
      <div className="form-grid">
        <label>
          Agent sampling speed
          <select
            value={value.speed ?? 1}
            onChange={(e) =>
              onChange({ ...value, speed: Number(e.target.value) })
            }
          >
            {speeds.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <label>
          Generation limit
          <select
            disabled={value.component === "environment"}
            value={timed ? "seconds" : "steps"}
            onChange={(e) =>
              onChange({
                ...value,
                generationSeconds:
                  e.target.value === "seconds" ? 10 : undefined,
              })
            }
          >
            <option value="steps">Completed steps</option>
            <option value="seconds">Active training seconds</option>
          </select>
        </label>
        {timed ? (
          <label>
            Seconds per generation
            <input
              type="number"
              required
              min={0.1}
              max={86400}
              step={0.1}
              value={value.generationSeconds}
              onChange={(e) =>
                onChange({
                  ...value,
                  generationSeconds: Number(e.target.value),
                })
              }
            />
          </label>
        ) : (
          <label>
            Steps per generation
            <input
              type="number"
              required
              min={1}
              max={100000}
              disabled={value.component === "environment"}
              value={
                value.component === "environment" ? 1 : value.ticksPerEpisode
              }
              onChange={(e) =>
                onChange({ ...value, ticksPerEpisode: Number(e.target.value) })
              }
            />
          </label>
        )}
      </div>
      <label className="playback-check">
        <input
          type="checkbox"
          checked={value.startPaused ?? false}
          onChange={(e) =>
            onChange({ ...value, startPaused: e.target.checked })
          }
        />
        Start paused after environment preparation
      </label>
      <Pace spec={value} speed={value.speed ?? 1} />
      <p className="world-help">
        Active-time limits exclude preparation and pauses. A complete step may
        finish slightly beyond the time limit. Generations currently mean
        training episodes.
      </p>
    </section>
  );
}

export function PlaybackControls({
  run,
  act,
  busy,
  online,
}: {
  run: Run;
  act: (path: string, body?: unknown) => Promise<unknown>;
  busy: boolean;
  online: boolean;
}) {
  const p = run.playback;
  const [speed, setSpeed] = useState(p?.speed ?? run.spec.speed ?? 1);
  const [unit, setUnit] = useState<"steps" | "seconds">(
    p?.generationSeconds !== undefined ? "seconds" : "steps",
  );
  const [length, setLength] = useState(
    p?.generationSeconds ?? p?.ticksPerGeneration ?? run.spec.ticksPerEpisode,
  );
  const [increment, setIncrement] = useState(1);
  const [steps, setSteps] = useState(1);
  useEffect(() => {
    setSpeed(p?.speed ?? run.spec.speed ?? 1);
    setUnit(p?.generationSeconds !== undefined ? "seconds" : "steps");
    setLength(
      p?.generationSeconds ?? p?.ticksPerGeneration ?? run.spec.ticksPerEpisode,
    );
  }, [
    run.id,
    p?.speed,
    p?.generationSeconds,
    p?.ticksPerGeneration,
    run.spec.speed,
    run.spec.ticksPerEpisode,
  ]);
  const disabled =
    busy || !online || !["queued", "running", "paused"].includes(run.status);
  const send = (command: PlaybackCommand) =>
    act(`runs/${run.id}/playback`, command);
  const paused = run.status === "paused" && !p?.manual;
  return (
    <section className="playback-panel">
      <h3>Generation and playback controls</h3>
      <Pace spec={run.spec} speed={p?.speed ?? run.spec.speed ?? 1} />
      <p className="world-help">
        Generation {run.episode}/{run.spec.episodes} · step{" "}
        {run.timing?.tick ?? 0}/
        {p?.ticksPerGeneration ?? run.spec.ticksPerEpisode} · active training{" "}
        {((run.timing?.trainingElapsedMs ?? 0) / 1000).toFixed(1)}s
        {p?.generationSeconds !== undefined ? ` / ${p.generationSeconds}s` : ""}
        {p?.manual ? ` · manual advance: ${p.manual.kind}` : ""}
      </p>
      <div className="playback-row">
        <label>
          Sampling speed
          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {speeds.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={disabled}
          onClick={() => void send({ action: "speed", speed })}
        >
          Apply speed
        </button>
        {run.status === "running" && (
          <button
            disabled={busy || !online}
            onClick={() => void act(`runs/${run.id}/pause`)}
          >
            Pause
          </button>
        )}
        {run.status === "paused" && (
          <button
            disabled={busy || !online}
            onClick={() => void act(`runs/${run.id}/resume`)}
          >
            Resume continuously
          </button>
        )}
      </div>
      {run.spec.component !== "environment" && (
        <>
          <div className="playback-row">
            <label>
              Limit unit
              <select
                value={unit}
                onChange={(e) => {
                  const u = e.target.value as typeof unit;
                  setUnit(u);
                  setLength(u === "seconds" ? 10 : 100);
                }}
              >
                <option value="steps">Steps</option>
                <option value="seconds">Active seconds</option>
              </select>
            </label>
            <label>
              Generation length
              <input
                type="number"
                min={unit === "steps" ? 1 : 0.1}
                max={unit === "steps" ? 100000 : 86400}
                step={unit === "steps" ? 1 : 0.1}
                value={length}
                onChange={(e) => setLength(Number(e.target.value))}
              />
            </label>
            <button
              disabled={disabled || !Number.isFinite(length) || length <= 0}
              onClick={() =>
                void send({ action: "length", unit, value: length })
              }
            >
              Apply length
            </button>
          </div>
          <p className="world-help">
            Applies to the current and following generations. Lowering the limit
            below completed work ends this generation at the next step boundary.
          </p>
          <div className="playback-row">
            <label>
              Time increment (seconds)
              <input
                type="number"
                min={0.1}
                max={86400}
                step={0.1}
                value={increment}
                onChange={(e) => setIncrement(Number(e.target.value))}
              />
            </label>
            <button
              disabled={disabled || !(increment > 0)}
              onClick={() =>
                void send({ action: "extend", seconds: increment })
              }
            >
              Extend length +{increment}s
            </button>
            <button
              disabled={disabled || !paused || !(increment > 0)}
              onClick={() =>
                void send({
                  action: "advance",
                  unit: "seconds",
                  value: increment,
                })
              }
            >
              Advance {increment}s, then pause
            </button>
          </div>
          <p className="world-help">
            Extending a step limit converts seconds using the base step
            interval. Manual time advancement uses measured active training
            time; it can cross generation boundaries.
          </p>
        </>
      )}
      <div className="playback-row">
        <label>
          Step increment
          <input
            type="number"
            min={1}
            max={100000}
            step={1}
            value={steps}
            onChange={(e) => setSteps(Number(e.target.value))}
          />
        </label>
        <button
          disabled={disabled || !paused || !(steps > 0)}
          onClick={() =>
            void send({ action: "advance", unit: "steps", value: steps })
          }
        >
          Advance {steps} steps
        </button>
        <button
          disabled={disabled || !paused}
          onClick={() =>
            void send({ action: "advance", unit: "generation", value: 1 })
          }
        >
          Run to generation boundary
        </button>
        <button
          disabled={
            disabled ||
            !run.episode ||
            !["training", "preparing"].includes(run.timing?.phase ?? "")
          }
          onClick={() => void send({ action: "end-generation" })}
        >
          End generation now
        </button>
      </div>
      <p className="world-help">
        Manual advancement requires a paused run and returns to pause
        automatically. Ending a generation records a partial result and pauses
        before the next generation. Pausing agent training leaves Minecraft
        physics running.
      </p>
      <a href={`/api/control/runs/${run.id}/artifacts/controls.jsonl`}>
        Download playback changes
      </a>
    </section>
  );
}
