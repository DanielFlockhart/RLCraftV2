import { motorInputConfig } from "./motor-inputs.js";

export function combatInputConfig() {
  const inputs = motorInputConfig();
  for (const id of [
    "self.vitals",
    "self.inventory",
    "entities.visible",
  ] as const)
    inputs.channels[id].enabled = true;
  inputs.channels["self.vitals"].intervalMs = 0;
  inputs.channels["self.inventory"].intervalMs = 250;
  inputs.channels["entities.visible"].intervalMs = 100;
  inputs.limits.entities = 8;
  return inputs;
}
