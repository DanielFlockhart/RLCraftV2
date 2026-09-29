import { resolve } from "node:path";
import { controlConnection } from "../../../packages/runtime/src/settings";

// Both Next launchers run with apps/dashboard as their working directory.
// Secrets and storage are supplied at runtime, never traced into build output.
const root = resolve(/* turbopackIgnore: true */ process.cwd(), "../..");
export function dashboardControlConnection() {
  return controlConnection(process.env, root);
}
