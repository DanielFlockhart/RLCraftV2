import type { AgentState, Run } from "@mlcraft/core";
import { effectiveStepMs } from "@mlcraft/core";
import { arenaSpawn } from "../../../packages/core/src/arenas.js";
import { motorTarget } from "../../../packages/core/src/motor.js";

/** Viewer-only projection: no Minecraft commands or agent state changes. */
export function viewerHudRuns(
  runs: Run[],
  now = Date.now(),
  agentsForRun: (runId: string) => AgentState[] = () => [],
) {
  const live = new Set(["running", "paused", "pausing", "queued"]);
  const priority = (r: Run) =>
    ["running", "pausing"].includes(r.status)
      ? 0
      : r.status === "paused"
        ? 1
        : r.status === "queued"
          ? 2
          : 3;
  return runs
    .filter((r) => r.spec.mode === "minecraft")
    .sort(
      (a, b) =>
        priority(a) - priority(b) || b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, 16)
    .map((run) => {
      const t = run.timing;
      const terminal = !live.has(run.status);
      // Recovery marks orphans interrupted at restart; offline time is never runtime.
      const end =
        run.status === "interrupted"
          ? (t?.sampledAt ?? now)
          : terminal
            ? Math.min(now, Date.parse(run.updatedAt))
            : now;
      const delta = t ? Math.max(0, end - t.sampledAt) : 0;
      const speed = run.playback?.speed ?? run.spec.speed ?? 1;
      const ticks =
        run.playback?.ticksPerGeneration ??
        t?.ticks ??
        run.spec.ticksPerEpisode;
      const seconds = run.playback
        ? run.playback.generationSeconds
        : run.spec.generationSeconds;
      const motorMarkers =
        run.spec.stage === "motor" &&
        run.spec.motor &&
        run.spec.arena &&
        run.episode > 0 &&
        ["running", "paused", "pausing"].includes(run.status)
          ? Array.from({ length: run.spec.agents }, (_, index) => ({
              index,
              spawn: arenaSpawn(run.spec.arena!, index),
              target: motorTarget(
                run.spec.arena!,
                run.spec.motor!,
                index,
                run.episode,
                run.spec.seed,
                run.spec.agents,
              ),
            }))
          : run.spec.motorTerrain &&
              ["running", "paused", "pausing"].includes(run.status)
            ? agentsForRun(run.id).flatMap((agent) =>
                agent.motorSpawn && agent.motorTarget
                  ? [{
                      index: Number(agent.id.slice(agent.id.lastIndexOf(":") + 1)),
                      spawn: agent.motorSpawn,
                      target: agent.motorTarget,
                    }]
                  : [],
              )
            : [];
      return {
        id: run.id,
        stage: run.spec.stage,
        motor: run.spec.motor ?? "",
        motorMarkers,
        component: run.spec.component,
        status: run.status,
        agents: run.spec.agents,
        episode: run.episode,
        episodes: run.spec.episodes,
        progress: run.progress,
        tick: t?.tick ?? 0,
        ticks: run.spec.component === "environment" ? 1 : ticks,
        speed,
        effectiveSpeed: run.spec.tickMs / effectiveStepMs(run.spec, speed),
        generationSeconds: seconds ?? -1,
        trainingMs:
          (t?.trainingElapsedMs ?? 0) +
          (t?.advancing && t.phase === "training" && run.status !== "paused"
            ? delta
            : 0),
        phase: t?.phase ?? "preparing",
        timingAvailable: !!t,
        totalMs: t ? t.totalElapsedMs + delta : 0,
        generationMs: t
          ? t.generationElapsedMs +
            (t.advancing && run.status !== "paused" ? delta : 0)
          : 0,
        lastGenerationMs: t?.lastGenerationMs ?? -1,
        targetGenerationMs:
          seconds !== undefined
            ? seconds * 1000
            : (run.spec.component === "environment" ? 1 : ticks) *
              effectiveStepMs(run.spec, speed),
        world: run.world?.levelName ?? "External world",
      };
    });
}
