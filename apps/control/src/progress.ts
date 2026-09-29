import { z } from "zod";
import type {
  ProgressSnapshot,
  ProgressRecord,
  ProgressAgent,
} from "@rlcraft/core";
import json from "../../../packages/core/src/progression-catalog.json" with { type: "json" };
import type { Store } from "./store.js";
export const progressionCatalog = json as ProgressSnapshot["catalog"];
const ids = new Set(progressionCatalog.steps.map((step) => step.id));
const identity = {
  runId: z.uuid(),
  agentId: z.string().max(100),
  username: z.string().regex(/^rl_[a-f0-9]{6}_\d{1,3}$/),
  minecraftVersion: z.string().min(1).max(50),
};
export const progressRecordSchema = z
  .object({
    ...identity,
    milestoneId: z.string().refine((id) => ids.has(id), "Unknown milestone"),
    at: z.number().int().positive(),
    episode: z.number().int().min(0).max(100000),
    source: z.enum([
      "inventory",
      "advancement",
      "statistic",
      "dimension",
      "block",
      "window",
      "credits",
      "end-return",
      "server-event",
    ]),
    detail: z.string().min(1).max(1000),
    gameMode: z.enum(["survival", "adventure", "creative", "spectator"]),
    origin: z.enum(["existing", "setup", "live"]),
  })
  .strict();
export const progressAgentSchema = z
  .object({
    ...identity,
    backend: z.string().min(1).max(100),
    supported: z.boolean(),
    reason: z.string().max(1000).optional(),
    startedAt: z.number().int().positive(),
  })
  .strict();
export function ownsProgress(
  runId: string,
  count: number,
  record: ProgressRecord | ProgressAgent,
) {
  const index = Number(record.username.split("_").at(-1));
  return (
    record.runId === runId &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < count &&
    record.agentId === `${runId}:${index}` &&
    record.username === `rl_${runId.slice(0, 6)}_${index}`
  );
}
export function receiveServerProgress(store: Store, line: string) {
  const match = line.match(
    /^\[\d{2}:\d{2}:\d{2}(?:\] \[Server thread\/INFO| INFO)\]: \[RLCraftViewerGuard\] RLCRAFT_PROGRESS (rl_[a-f0-9]{6}_\d{1,3}) (blaze-seen|crystal|destroy-crystals|fight-dragon) (survival|adventure|creative|spectator)$/,
  );
  if (!match) return false;
  const agents = store.progressOwners(match[1]);
  if (agents.length !== 1) return false;
  const agent = agents[0];
  const run = store.getRun(agent.runId);
  if (!run || run.spec.mode !== "minecraft") return false;
  return store.saveProgress({
    runId: run.id,
    agentId: agent.id,
    username: agent.username,
    episode: run.episode,
    minecraftVersion: "1.18.1",
    at: Date.now(),
    milestoneId: match[2],
    source: "server-event",
    gameMode: match[3],
    origin: ["connecting", "resetting"].includes(agent.status)
      ? "setup"
      : "live",
    detail: `Read-only Paper attribution: ${match[2]}; registered agent ${agent.username}.`,
  });
}
