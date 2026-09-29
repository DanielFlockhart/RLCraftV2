import { resolve } from "node:path";
import { loadBackendRegistry } from "../../../packages/agents/src/backends/registry.js";
import { config, root } from "./config.js";
// One registry snapshot per control/worker process. Changes apply after restart.
export const backendRegistry = loadBackendRegistry(
  config.AGENT_BACKENDS_FILE
    ? resolve(root, config.AGENT_BACKENDS_FILE)
    : undefined,
  config.MC_AGENT_BACKEND,
);
// Initialization errors are surfaced on startup/selection, without an unhandled rejection.
void backendRegistry.catch(() => {});
