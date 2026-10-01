import { trainingPlugins, inspectModels } from "@mlcraft/agents";
import { stages, type StageId, type ModelSnapshot, type RunSpec } from "@mlcraft/core";

// Fresh process imports the current registry; no environments, bots, or training are started.
const stage = process.argv[2] as StageId;
if (!stages.some((item) => item.id === stage)) throw new Error("Unknown stage");
const plugin = trainingPlugins[stage];
const spec: RunSpec = { stage, ...(stage === "motor" ? { motor: "M0" as const } : {}), mode: "simulator", component: "pipeline", agents: 1, episodes: 1, ticksPerEpisode: 1, tickMs: 100, seed: 42 };
const trainer = plugin.createTrainer(spec);
const policy = plugin.createPolicy("rl_preview_0", spec);
try {
  const snapshot: ModelSnapshot = {
    source: "configured",
    stage,
    episode: 0,
    tick: 0,
    sampledAt: Date.now(),
    variants: await inspectModels(
      stage,
      [{ username: "architecture-preview", policy }],
      trainer,
    ),
  };
  process.send?.(snapshot);
} finally {
  await policy.close();
  process.disconnect?.();
}
