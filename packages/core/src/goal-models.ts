export interface GoalTrainingParameters {
  epochs: number;
  batchSize: number;
  width: number;
  layers: number;
  learningRate: number;
  dropout: number;
  hardWeight: number;
  patience: number;
  seed: number;
  threads: number;
  device: "cpu" | "cuda";
}
export interface GoalEpochMetric {
  epoch: number;
  train_loss: number;
  validation_loss: number;
  validation_top1: number | null;
  validation_top3: number | null;
  validation_blocked_accuracy: number;
  elapsed_seconds: number;
}
export interface GoalSplitEvaluation {
  rows: number;
  actionable_rows?: number;
  blocked_rows?: number;
  loss: number | null;
  top1: number | null;
  top3: number | null;
  raw_top1: number | null;
  raw_invalid_rate: number | null;
  masked_invalid_rate: number | null;
  blocked_accuracy: number | null;
  blocked_precision: number | null;
  blocked_recall: number | null;
  per_goal?: Record<string, { rows: number; accuracy: number | null }>;
  per_family?: Record<
    string,
    {
      rows: number;
      goal_accuracy: number | null;
      selection_accuracy: number | null;
    }
  >;
  defined_case_selection_accuracy?: number | null;
  confusion_matrix?: number[][];
  confusion_labels?: string[];
}
export interface GoalEvaluation {
  best_epoch: number;
  epochs_completed: number;
  parameter_count: number;
  training_seconds: number;
  baseline_validation: GoalSplitEvaluation;
  splits: Record<string, GoalSplitEvaluation>;
  input_overlap: Record<string, number>;
  slot_order_invariant: boolean;
  latency: {
    device: string;
    samples: number;
    median_ms: number;
    p95_ms: number;
    includes: string;
  };
}
export interface GoalModelJob {
  id: string;
  /** Training roadmap stage that owns this model. */
  stageId?: string;
  datasetId: string;
  parentId?: string;
  trainingMode?: "from_scratch" | "fine_tune" | "continue";
  modelVersion: string;
  sourceHash: string;
  parameters: GoalTrainingParameters;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  finishedAt?: number;
  phase?: string;
  error?: string;
  logs: string[];
  metrics: GoalEpochMetric[];
  evaluation?: GoalEvaluation;
  artifacts: string[];
}
export interface GoalModelSnapshot {
  defaults: GoalTrainingParameters;
  jobs: GoalModelJob[];
}
export interface GoalPrediction {
  model_version: string;
  objective: string;
  goal: string | null;
  goal_id: number | null;
  status: "actionable" | "complete" | "blocked";
  blocked_probability: number;
  probabilities: Record<string, number>;
  raw_probabilities: Record<string, number>;
  valid_goals: Record<string, boolean>;
  ranked_goals: { goal: string; goal_id: number; probability: number }[];
  latency_ms: number;
}
