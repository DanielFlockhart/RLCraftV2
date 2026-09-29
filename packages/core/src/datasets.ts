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
