"use client";
import { useEffect, useState } from "react";
import type { CombatFullRun, CombatFullRunStage, Run } from "@mlcraft/core";
import { combatSessions } from "../../../packages/core/src/combat";

type Conditions = Pick<
  CombatFullRunStage,
  "episodes" | "ticksPerEpisode"
>;
export function CombatFullRunPanel({
  runs,
  online,
  act,
  agents,
  seed,
  tickMs,
}: {
  runs: Run[];
  online: boolean;
  act: (path: string, body?: unknown) => Promise<unknown>;
  agents: number;
  seed: number;
  tickMs: number;
}) {
  const [plans, setPlans] = useState<CombatFullRun[]>([]);
  const [availableSessions, setAvailableSessions] = useState(0);
  const [conditions, setConditions] = useState<Conditions[]>(
    combatSessions.map(() => ({
      episodes: 64,
      ticksPerEpisode: 120,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [extraEpisodes, setExtraEpisodes] = useState(64);
  useEffect(() => {
    if (!online) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const [response, sessionsResponse] = await Promise.all([
          fetch("/api/control/phase3d/full-runs", {
            cache: "no-store",
            signal: controller.signal,
          }),
          fetch("/api/control/phase3d/sessions", {
            cache: "no-store",
            signal: controller.signal,
          }),
        ]);
        if (response.ok) setPlans(await response.json());
        if (sessionsResponse.ok)
          setAvailableSessions((await sessionsResponse.json()).length);
      } catch {}
      if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [online]);
  const active = plans.find((plan) =>
    ["running", "paused"].includes(plan.status),
  );
  const blockingRun = runs.find(
    (run) =>
      run.spec.mode === "minecraft" &&
      ["running", "paused", "pausing", "queued"].includes(run.status),
  );
  const otherMinecraftActive = !!blockingRun;
  const selected = active ?? plans[0];
  const missingSessions = selected
    ? combatSessions.slice(selected.stages.length)
    : [];
  const live =
    selected && selected.stageIndex < selected.stages.length
      ? runs.find(
          (run) =>
            run.id === selected.stages[selected.stageIndex].runIds.at(-1),
        )
      : undefined;
  function update(index: number, field: keyof Conditions, value: number) {
    setConditions((current) =>
      current.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );
  }
  async function perform(path: string, body: unknown) {
    setBusy(true);
    try {
      await act(path, body);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel combat-full-run">
      <h3>Full Run · C0–C{combatSessions.length - 1}</h3>
      <p>
        Train each combat session in order. The complete NEAT population
        transfers to the next session after its trial episodes finish. Win
        rates are shown for review and do not block progression.
      </p>
      {otherMinecraftActive && !active && (
        <p role="status">
          {blockingRun?.spec.motorTerrain
            ? "Natural terrain training is running. Use Stop natural training on the Motor Skills (3A) page before starting a Combat Full Run."
            : `A Minecraft ${blockingRun?.spec.stage ?? "training"} run is active. Finish or stop it before starting a Combat Full Run.`}
        </p>
      )}
      {selected && (
        <p role="status">
          {selected.status} ·{" "}
          {selected.stageIndex >= selected.stages.length
            ? "All stages complete"
            : `Stage ${selected.stages[selected.stageIndex].session}`}
          {live
            ? ` · run ${live.id.slice(0, 8)} ${live.status} · trial ${live.episode}`
            : ""}
          {selected.error ? ` · ${selected.error}` : ""}
        </p>
      )}
      {selected &&
        ["running", "paused", "failed"].includes(selected.status) && (
          <div className="input-actions">
            {selected.status === "running" ? (
              <button
                disabled={busy}
                onClick={() =>
                  perform(`phase3d/full-runs/${selected.id}/pause`, {})
                }
              >
                Pause Full Run
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  perform(`phase3d/full-runs/${selected.id}/resume`, {})
                }
              >
                Resume Full Run
              </button>
            )}
            {selected.status !== "failed" && (
              <button
                disabled={busy}
                onClick={() =>
                  perform(`phase3d/full-runs/${selected.id}/cancel`, {})
                }
              >
                Cancel Full Run
              </button>
            )}
          </div>
        )}
      {selected?.status === "paused" && live && ["cancelled", "failed", "interrupted"].includes(live.status) && (
        <div className="input-actions">
          <label>
            <span>Extra trials for {selected.stages[selected.stageIndex].session}</span>
            <input type="number" min={1} max={10000} value={extraEpisodes} onChange={(event) => setExtraEpisodes(Number(event.target.value))} />
          </label>
          <button type="button" disabled={busy || !Number.isInteger(extraEpisodes) || extraEpisodes < 1 || extraEpisodes > 10000}
            onClick={() => perform(`phase3d/full-runs/${selected.id}/extend-current`, { additionalEpisodes: extraEpisodes })}>
            Add trials to current stage
          </button>
          <small>Current stage target: {selected.stages[selected.stageIndex].episodes} trial episodes.</small>
        </div>
      )}
      {!!missingSessions.length &&
        selected &&
        ["running", "paused", "completed"].includes(selected.status) && (
          <div>
            <p role="status">
              This run contains C0–C{selected.stages.length - 1}. Add C
              {selected.stages.length}–C{combatSessions.length - 1}
              to continue training the same population.
            </p>
            <button
              type="button"
              disabled={busy || availableSessions < combatSessions.length}
              onClick={() =>
                perform(`phase3d/full-runs/${selected.id}/extend`, {
                  stages: missingSessions.map((session, offset) => ({
                    session: session.id,
                    agents: selected.stages[0].agents,
                    seed: selected.stages[0].seed,
                    tickMs: selected.stages[0].tickMs,
                    ...conditions[selected.stages.length + offset],
                  })),
                })
              }
            >
              Add C{selected.stages.length}–C{combatSessions.length - 1} to this
              Full Run
            </button>
            {availableSessions < combatSessions.length && (
              <small>
                The updated control service will load these stages after the
                current run ends and services restart.
              </small>
            )}
          </div>
        )}
      <div className="stage-grid">
        {combatSessions.map((session, index) => (
          <div className="stage-card combat-full-run-card" key={session.id}>
            <div className="stage-top">
              <span className="stage-number">{session.id}</span>
              <span>
                {selected?.stages[index]?.lastWinRate === undefined
                  ? ""
                  : `${Math.round(selected.stages[index].lastWinRate! * 100)}% wins`}
              </span>
            </div>
            <h4>{session.name}</h4>
            <div className="combat-condition-fields">
              <label>
                <span>Trial episodes</span>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={conditions[index].episodes}
                  onChange={(event) =>
                    update(index, "episodes", Number(event.target.value))
                  }
                />
              </label>
              <label>
                <span>Steps per trial</span>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={conditions[index].ticksPerEpisode}
                  onChange={(event) =>
                    update(index, "ticksPerEpisode", Number(event.target.value))
                  }
                />
              </label>
            </div>
            {!!selected?.stages[index]?.runIds.length && (
              <div className="combat-stage-runs">
                {selected.stages[index].runIds.map((id) => (
                  <small key={id}>Run {id.slice(0, 8)}</small>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={
          !online ||
          busy ||
          !!active ||
          otherMinecraftActive ||
          conditions.some(
            (row) =>
              !Number.isInteger(row.episodes) ||
              row.episodes < 1 ||
              !Number.isInteger(row.ticksPerEpisode) ||
              row.ticksPerEpisode < 1,
          )
        }
        onClick={() =>
          perform("phase3d/full-runs", {
            stages: combatSessions.map((session, index) => ({
              session: session.id,
              agents,
              seed,
              tickMs,
              ...conditions[index],
            })),
          })
        }
      >
        Start Full Run
      </button>
    </div>
  );
}
