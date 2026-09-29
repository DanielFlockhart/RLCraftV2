export interface DatasetParameter {
  key: string;
  label: string;
  flag: string;
  default: number;
  min: number;
  max: number;
  integer: boolean;
}
export interface DatasetGenerator {
  id: string;
  name: string;
  description: string;
  version: string;
  parameters: DatasetParameter[];
  artifacts: string[];
  supportsExpansion: boolean;
}
export interface DatasetJob {
  id: string;
  generatorId: string;
  generatorVersion: string;
  sourceHash: string;
  parameters: Record<string, number>;
  parentId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  finishedAt?: number;
  error?: string;
  progress?: { split: string; rows: number; total: number };
  logs: string[];
  artifacts: string[];
}
export interface DatasetSnapshot {
  generators: DatasetGenerator[];
  jobs: DatasetJob[];
}
export type DatasetSplit = "train" | "validation" | "test" | "ood_test";
export interface InventoryStack {
  slot: number;
  item: string;
  count: number;
}
export interface GoalSelectionExample {
  schema_version: 2;
  inventory: {
    size: 41;
    selected_hotbar_slot: number;
    slots: InventoryStack[];
  };
  context: Record<string, number | boolean>;
  target: {
    goal_id: number | null;
    goal: string | null;
    label_status?: "actionable" | "complete" | "blocked";
    valid_goals: Record<string, boolean>;
    probabilities: Record<string, number>;
  };
  diagnostics: {
    progression_stage: number;
    sampling_family?: string;
    inventory_layout?: string;
    coverage_case?: string;
  };
}
export interface DatasetCoverage {
  required_cases: number;
  covered_cases: number;
  complete: boolean;
  missing_cases: string[];
  families: Record<string, number>;
  blocked_rows: number;
  cases: {
    id: string;
    family: string;
    description: string;
    count: number;
    first_index: number | null;
  }[];
}
export interface DatasetExamples {
  job: Omit<DatasetJob, "logs">;
  split: DatasetSplit;
  offset: number;
  total: number;
  examples: { index: number; data: GoalSelectionExample }[];
  coverage?: DatasetCoverage;
}
