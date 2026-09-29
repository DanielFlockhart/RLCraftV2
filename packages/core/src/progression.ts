export type ProgressRule =
  | { kind: "inventory"; items?: string[]; suffix?: string; count?: number }
  | { kind: "advancement"; id: string }
  | {
      kind: "statistic";
      category: "mined" | "crafted" | "used" | "picked_up" | "killed";
      names: string[];
      count?: number;
    }
  | { kind: "dimension"; name: string }
  | { kind: "block"; names: string[]; properties?: Record<string, string> }
  | { kind: "window"; type: string }
  | { kind: "credits" }
  | { kind: "end-return" }
  | {
      kind: "server-event";
      event: "blaze-seen" | "crystal" | "destroy-crystals" | "fight-dragon";
    }
  | { kind: "manual"; reason: string };
export interface ProgressStep {
  id: string;
  group: string;
  title: string;
  requirement: "completion" | "route" | "preparation" | "postgame";
  instructions: string[];
  items: string;
  minimum: string;
  alternatives: string;
  rules: ProgressRule[];
}
export interface ProgressEvidence {
  milestoneId: string;
  at: number;
  source:
    | "inventory"
    | "advancement"
    | "statistic"
    | "dimension"
    | "block"
    | "window"
    | "credits"
    | "end-return"
    | "server-event";
  detail: string;
  gameMode: string;
  origin: "existing" | "setup" | "live";
}
export interface ProgressRecord extends ProgressEvidence {
  runId: string;
  agentId: string;
  username: string;
  episode: number;
  minecraftVersion: string;
}
export interface ProgressAgent {
  runId: string;
  agentId: string;
  username: string;
  backend: string;
  minecraftVersion: string;
  supported: boolean;
  reason?: string;
  startedAt: number;
}
export interface ProgressSummary {
  milestoneId: string;
  agents: number;
  survivalAgents: number;
  first?: ProgressRecord;
  firstSurvival?: ProgressRecord;
}
export interface ProgressSnapshot {
  catalog: {
    schemaVersion: number;
    minecraftVersion: string;
    goal: string;
    scope: string;
    groups: { id: string; title: string }[];
    steps: ProgressStep[];
    resources: {
      item: string;
      minimum: string;
      route: string;
      notes: string;
    }[];
  };
  configuredVersion: string;
  supportedVersion: boolean;
  attributionReady: boolean;
  scope: "all-runs" | "run";
  runId?: string;
  summaries: ProgressSummary[];
  tracking: { agents: number; supported: number; unsupported: number };
}
