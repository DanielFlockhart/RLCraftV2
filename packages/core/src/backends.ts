import type { Mode } from "./index.js";

export type InputSupport =
  "native" | "approximate" | "external" | "unsupported";
export interface BackendDescriptor {
  id: string;
  label: string;
  description: string;
  version: string;
  mode: Mode;
  /** Exact versions, or ["*"] for version-independent simulators. */
  minecraftVersions: string[];
  inputSupport: Record<string, InputSupport>;
  actions: ("controls" | "look" | "dig" | "attack" | "block" | "use")[];
  lifecycle: {
    reset: boolean;
    respawn: boolean;
    teleport: boolean;
    capture: boolean;
  };
  limitations: string[];
}
export interface BackendSnapshot {
  descriptor: BackendDescriptor;
  /** Descriptor + transport/module configuration fingerprint. No credentials. */
  revision: string;
}
