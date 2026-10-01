import { defaultInputs } from "@mlcraft/core";

/** Only collect the observations consumed by the motor policy. */
export function motorInputConfig() {
  const inputs = structuredClone(defaultInputs);
  for (const [id, channel] of Object.entries(inputs.channels))
    channel.enabled = id === "self.pose" || id === "self.physics" || id === "vision.geometry";
  inputs.channels["self.pose"].intervalMs = 0;
  inputs.channels["self.physics"].intervalMs = 0;
  inputs.channels["vision.geometry"].intervalMs = 250;
  inputs.limits.visionWidth = 8;
  inputs.limits.visionHeight = 6;
  inputs.limits.visionDistance = 16;
  return inputs;
}
