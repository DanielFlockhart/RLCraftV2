import { trainingPlugins, inspectModels } from "@rlcraft/agents";
import { stages, type StageId, type ModelSnapshot } from "@rlcraft/core";

// Fresh process imports the current registry; no environments, bots, or training are started.
const stage = process.argv[2] as StageId;
if (!stages.some((item) => item.id === stage)) throw new Error("Unknown stage");
const plugin = trainingPlugins[stage];
const policy = plugin.createPolicy("architecture-preview");
const trainer = plugin.createTrainer();
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
