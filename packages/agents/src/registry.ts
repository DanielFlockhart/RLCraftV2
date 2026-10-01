import type { Policy, Trainer, StageId, RunSpec } from "@mlcraft/core";
import { PlaceholderPolicy, PlaceholderTrainer } from "./policy.js";
import { MotorNeat, MotorPolicy, MotorTrainer } from "./motor-neat.js";
export interface TrainingPlugin {
  createPolicy(agentId: string, spec: RunSpec): Policy;
  createTrainer(spec: RunSpec): Trainer;
}
const placeholder: TrainingPlugin = {
  createPolicy: () => new PlaceholderPolicy(),
  createTrainer: () => new PlaceholderTrainer(),
};
let motorPopulation: MotorNeat | undefined;
const motor: TrainingPlugin = {
  createTrainer: (spec) => {
    motorPopulation = new MotorNeat(spec);
    return new MotorTrainer(motorPopulation);
  },
  createPolicy: (agentId) => {
    if (!motorPopulation) throw new Error("Motor trainer must initialize before policies");
    return new MotorPolicy(motorPopulation, Number(agentId.slice(agentId.lastIndexOf("_") + 1)));
  },
};
/** Replace individual entries with your stage-specific AI factories.
 * The control service, dashboard and run lifecycle need no changes.
 */
export const trainingPlugins: Record<StageId, TrainingPlugin> = {
  movement: placeholder,
  motor,
  wood_collection: placeholder,
  block_collection: placeholder,
  survival: placeholder,
  pvp: placeholder,
};
