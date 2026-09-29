import type { BackendContext } from "@rlcraft/agents/backends";
import { SimulatorEnvironment } from "../../packages/agents/src/backends/simulator.js";
/** Replace this implementation with a client adapter; policy and worker stay the same. */
export function createEnvironment(context: BackendContext) {
  return new SimulatorEnvironment(context.inputs);
}
