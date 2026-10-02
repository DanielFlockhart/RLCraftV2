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
  combat?: {
    health: number;
    food: number;
    targets: number;
    targetDx: number;
    targetDy: number;
    targetDz: number;
    targetHealth: number;
    attackReady: number;
    sword: number;
    axe: number;
    armor: number;
    shield: number;
    targetType?: string;
    secondType?: string;
    secondDx?: number;
    secondDy?: number;
    secondDz?: number;
    targetVx?: number;
    targetVy?: number;
    targetVz?: number;
    targetOnFire?: number;
    targetRecentlyHurt?: number;
    creeperFuse?: number;
    creeperCharged?: number;
    creeperIgnited?: number;
    weapon?: string;
    ammo?: number;
    itemUseTicks?: number;
    weaponLoaded?: number;
    projectileCount?: number;
    projectileDx?: number;
    projectileDy?: number;
    projectileDz?: number;
    projectileVx?: number;
    projectileVy?: number;
    projectileVz?: number;
    selfOnFire?: number;
    poisoned?: number;
    slowed?: number;
    withered?: number;
    targetHealthKnown?: number;
    armorMaterial?: string;
    shieldRaised?: number;
  };
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
