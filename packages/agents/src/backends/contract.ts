import type {
  AgentInputConfig,
  AgentSetup,
  ArenaPoint,
  BackendDescriptor,
  Environment,
  Mode,
} from "@mlcraft/core";

/** Policy code receives core PolicyObservation, never a backend-specific client. */
export interface BackendContext {
  mode: Mode;
  runId: string;
  username: string;
  connection: {
    host: string;
    port: number;
    version: string;
    auth: "offline" | "microsoft";
  };
  inputs: AgentInputConfig;
  render?: import("@mlcraft/core").RenderSettings;
  assetDirectory: string;
  managed: {
    applySetup(setup: AgentSetup): Promise<void>;
    moveToArena(): Promise<void>;
  };
}
export interface BackendAdapter {
  descriptor: BackendDescriptor;
  createEnvironment(
    context: BackendContext,
  ): Environment | Promise<Environment>;
}
export interface StdioBackendConfig {
  command: string;
  args: string[];
  cwd: string;
  /** Only explicitly supplied values are added to a small inherited OS environment. */
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
}
