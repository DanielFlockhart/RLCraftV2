import type { Policy, Trainer, StageId } from "@rlcraft/core";
import { PlaceholderPolicy, PlaceholderTrainer } from "./policy.js";
export interface TrainingPlugin {
  createPolicy(agentId: string): Policy;
  createTrainer(): Trainer;
}
const placeholder: TrainingPlugin = {
  createPolicy: () => new PlaceholderPolicy(),
  createTrainer: () => new PlaceholderTrainer(),
};
/** Replace individual entries with your stage-specific AI factories.
 * The control service, dashboard and run lifecycle need no changes.
 */
export const trainingPlugins: Record<StageId, TrainingPlugin> = {
  movement: placeholder,
  wood_collection: placeholder,
  block_collection: placeholder,
  survival: placeholder,
  pvp: placeholder,
};
