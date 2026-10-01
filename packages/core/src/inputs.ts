export type InputValue =
  | null
  | boolean
  | number
  | string
  | InputValue[]
  | { [key: string]: InputValue };
export interface InputChannelConfig {
  enabled: boolean;
  intervalMs: number;
  fields?: string[];
}
export interface AgentInputConfig {
  channels: Record<string, InputChannelConfig>;
  limits: {
    eventCount: number;
    eventBytes: number;
    packetBytes: number;
    eventWindowMs: number;
    blockRadius: number;
    entities: number;
    visionWidth: number;
    visionHeight: number;
    visionDistance: number;
    visionFov: number;
    audioSampleRate: number;
    audioWindowMs: number;
  };
  record: boolean;
}
export interface InputSample {
  status: "ready" | "unavailable" | "error";
  sampledAt: number;
  source: string;
  data?: InputValue;
  reason?: string;
  durationMs?: number;
}
export interface AgentInputFrame {
  schemaVersion: 1;
  at: number;
  tick: number;
  sequence: number;
  channels: Record<string, InputSample>;
  diagnostics: {
    droppedEvents: number;
    droppedBytes: number;
    eventBytes: number;
    unloadedBlocks?: number;
  };
}
export interface PolicyObservation {
  tick: number;
  inputs: AgentInputFrame;
  motor?: { targetDx: number; targetDy: number; targetDz: number };
}
export interface CaptureFrame {
  kind: "rgb" | "pcm";
  sequence: number;
  capturedAt: number;
  encoding: "rgb8" | "f32le";
  data: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}
