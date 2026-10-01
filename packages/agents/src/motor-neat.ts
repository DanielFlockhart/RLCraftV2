import type {
  Action,
  ModelInspection,
  Policy,
  PolicyObservation,
  RunSpec,
  Trainer,
  Transition,
} from "@mlcraft/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MOTOR_TRIALS_PER_EVOLUTION,
  motorTrialPlan,
} from "../../core/src/motor.js";

const inputNames = [
  "target_dx",
  "target_dy",
  "target_dz",
  "velocity_x",
  "velocity_y",
  "velocity_z",
  "yaw",
  "pitch",
  "on_ground",
  "depth_left",
  "depth_ahead",
  "depth_right",
  "yaw_cos",
  "target_forward",
  "target_right",
  "target_horizontal_distance",
  "velocity_forward",
  "velocity_right",
  "depth_low_left",
  "depth_low_ahead",
  "depth_low_right",
  "depth_high_ahead",
  "depth_valid_ahead",
  "in_water",
  "collided_horizontally",
  "collided_vertically",
  "jump_ticks",
];
const outputNames = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "yaw_delta",
  "pitch_delta",
  "sneak",
];
const COMPATIBILITY_THRESHOLD = 0.6;
const TRANSFER_COMPATIBILITY_THRESHOLD = 0.12;
const TARGET_SPECIES_LOW = 3;
const TARGET_SPECIES_HIGH = 6;
const SPECIES_STAGNATION_GENERATIONS = 15;
const GLOBAL_STAGNATION_GENERATIONS = 20;
type Node = { id: number; depth: number };
type Connection = {
  innovation: number;
  from: number;
  to: number;
  weight: number;
  enabled: boolean;
};
type Genome = { nodes: Node[]; connections: Connection[]; fitness: number };
function upgradeCheckpoint(checkpoint: any) {
  if (JSON.stringify(checkpoint.inputs) === JSON.stringify(inputNames) &&
      JSON.stringify(checkpoint.outputs) === JSON.stringify(outputNames))
    return checkpoint;
  const priorInputs = checkpoint.inputs;
  const priorOutputs = checkpoint.outputs;
  if (!Array.isArray(priorInputs) || !Array.isArray(priorOutputs) ||
      ![12, 13].includes(priorInputs.length) ||
      JSON.stringify(priorInputs) !== JSON.stringify(inputNames.slice(0, priorInputs.length)) ||
      JSON.stringify(priorOutputs) !== JSON.stringify(outputNames.slice(0, -1)))
    return checkpoint;
  const oldInputs = priorInputs.length;
  const oldOutputs = priorOutputs.length;
  const oldHiddenStart = oldInputs + 1 + oldOutputs;
  const shift = inputNames.length - oldInputs + outputNames.length - oldOutputs;
  const mapId = (id: number) =>
    id < oldInputs ? id :
    id === oldInputs ? inputNames.length :
    id < oldHiddenStart ? inputNames.length + 1 + id - oldInputs - 1 :
    id + shift;
  const graph = (genome: Genome) => ({
    ...genome,
    nodes: [
      ...genome.nodes.map((node) => ({ ...node, id: mapId(node.id) })),
      ...inputNames.slice(oldInputs).map((_, offset) => ({ id: oldInputs + offset, depth: 0 })),
      { id: inputNames.length + 1 + oldOutputs, depth: 1 },
    ],
    connections: genome.connections.map((connection) => ({
      ...connection, from: mapId(connection.from), to: mapId(connection.to),
    })),
  });
  const saved = checkpoint.resumeState;
  return {
    ...checkpoint,
    inputs: inputNames,
    outputs: outputNames,
    ...(checkpoint.champion ? { champion: graph(checkpoint.champion) } : {}),
    ...(Array.isArray(checkpoint.population)
      ? { population: checkpoint.population.map(graph) } : {}),
    ...(Array.isArray(checkpoint.speciesLineages)
      ? { speciesLineages: checkpoint.speciesLineages.map((lineage: SpeciesLineage) => ({
          ...lineage, representative: graph(lineage.representative),
        })) } : {}),
    ...(saved ? { resumeState: {
      ...saved,
      nextNode: mapId(saved.nextNode),
      innovations: saved.innovations.map(([key, innovation]: [string, number]) => {
        const [from, to] = key.split(":").map(Number);
        return [`${mapId(from)}:${mapId(to)}`, innovation];
      }),
      splitNodes: saved.splitNodes.map(([innovation, id]: [number, number]) =>
        [innovation, mapId(id)]),
    } } : {}),
  };
}
type SpeciesLineage = {
  id: number;
  representative: Genome;
  bestFitness: number;
  lastImproved: number;
};
type SpeciesGroup = SpeciesLineage & { members: Genome[]; offspring: number };
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function motorFeatures(observation: PolicyObservation): number[] {
  const pose = observation.inputs.channels["self.pose"]?.data as
    Record<string, any> | undefined;
  const velocity = pose?.velocity ?? {};
  const physics = observation.inputs.channels["self.physics"]?.data as
    Record<string, any> | undefined;
  const geometry = observation.inputs.channels["vision.geometry"]?.data as
    Record<string, any> | undefined;
  const depth = Array.isArray(geometry?.depth) ? geometry.depth : [];
  const width = number(geometry?.width),
    height = number(geometry?.height);
  const sampleDepth = (column: number, row = 0.5) =>
    width > 0 && height > 0
      ? clamp(
          number(
            depth[
              Math.floor(row * (height - 1)) * width + Math.floor(column * (width - 1))
            ],
          ) / Math.max(1, number(geometry?.distance)),
          0,
          1,
        )
      : 0;
  const target = observation.motor ?? { targetDx: 0, targetDy: 0, targetDz: 0 };
  const yaw = number(pose?.yaw);
  const sinYaw = Math.sin(yaw), cosYaw = Math.cos(yaw);
  const targetForward = -target.targetDx * sinYaw - target.targetDz * cosYaw;
  const targetRight = target.targetDx * cosYaw - target.targetDz * sinYaw;
  const velocityForward = -number(velocity.x) * sinYaw - number(velocity.z) * cosYaw;
  const velocityRight = number(velocity.x) * cosYaw - number(velocity.z) * sinYaw;
  const center = Math.floor(0.5 * (height - 1)) * width + Math.floor(0.5 * (width - 1));
  return [
    clamp(target.targetDx / 24, -1, 1),
    clamp(target.targetDy / 8, -1, 1),
    clamp(target.targetDz / 24, -1, 1),
    clamp(number(velocity.x), -1, 1),
    clamp(number(velocity.y), -1, 1),
    clamp(number(velocity.z), -1, 1),
    sinYaw,
    clamp(number(pose?.pitch) / (Math.PI / 2), -1, 1),
    pose?.onGround ? 1 : 0,
    sampleDepth(0.25),
    sampleDepth(0.5),
    sampleDepth(0.75),
    cosYaw,
    clamp(targetForward / 24, -1, 1),
    clamp(targetRight / 24, -1, 1),
    clamp(Math.hypot(target.targetDx, target.targetDz) / 32, 0, 1),
    clamp(velocityForward, -1, 1),
    clamp(velocityRight, -1, 1),
    sampleDepth(0.25, 0.8),
    sampleDepth(0.5, 0.8),
    sampleDepth(0.75, 0.8),
    sampleDepth(0.5, 0.2),
    geometry?.valid?.[center] ? 1 : 0,
    physics?.isInWater ? 1 : 0,
    physics?.isCollidedHorizontally ? 1 : 0,
    physics?.isCollidedVertically ? 1 : 0,
    clamp(number(physics?.jumpTicks) / 20, 0, 1),
  ];
}

export class MotorNeat {
  private state: number;
  private innovations = new Map<string, number>();
  private splitNodes = new Map<number, number>();
  private nextInnovation = 1;
  private nextNode = inputNames.length + outputNames.length + 1;
  private genomes: Genome[] = [];
  private assigned = new Map<number, number>();
  private trialRewards = new Map<number, number>();
  private evaluated = new Map<number, Set<number>>();
  private episode = 0;
  private generation = 0;
  private species = 1;
  private evolutionVersion: 1 | 2 = 2;
  private compatibilityThreshold = COMPATIBILITY_THRESHOLD;
  private generationBestFitness = 0;
  private nextSpeciesId = 1;
  private lastGlobalImproved = 0;
  private lineages: SpeciesLineage[] = [];
  private history: Array<{
    generation: number;
    bestFitness: number;
    generationBestFitness: number;
    species: Array<{
      id: number;
      size: number;
      bestFitness: number;
      offspring: number;
      stagnant: boolean;
    }>;
  }> = [];
  private champion?: Genome;
  constructor(
    private spec: RunSpec,
    private artifactRoot = process.env.ARTIFACT_DIR,
  ) {
    this.state = spec.seed >>> 0;
    if (!spec.motorResume)
      for (let i = 0; i < Math.max(8, spec.agents); i++)
        this.genomes.push(this.initial());
    if (spec.motorResume) {
      const root = this.artifactRoot;
      if (!root) throw new Error("Motor checkpoint directory is unavailable");
      const checkpoint = upgradeCheckpoint(JSON.parse(
        readFileSync(resolve(root, spec.motorResume, "checkpoint.json"), "utf8"),
      ));
      const saved = checkpoint.resumeState;
      if (!saved) {
        this.restoreLegacyPopulation(checkpoint);
        return;
      }
      if (
        checkpoint.kind !== "neat-rl" || saved?.version !== 1 ||
        checkpoint.session !== spec.motor || checkpoint.seed !== spec.seed ||
        checkpoint.agents !== spec.agents ||
        checkpoint.population?.length !== Math.max(8, spec.agents) ||
        JSON.stringify(checkpoint.inputs) !== JSON.stringify(inputNames) ||
        JSON.stringify(checkpoint.outputs) !== JSON.stringify(outputNames) ||
        !Number.isSafeInteger(checkpoint.episode) || checkpoint.episode < 0 ||
        !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 0 ||
        !Number.isSafeInteger(checkpoint.species) || checkpoint.species < 1 ||
        !Number.isFinite(checkpoint.generationBestFitness) ||
        !Number.isSafeInteger(saved.randomState) || saved.randomState < 0 ||
        !Number.isSafeInteger(saved.nextInnovation) || saved.nextInnovation < 1 ||
        !Number.isSafeInteger(saved.nextNode) || saved.nextNode < 1 ||
        !Number.isSafeInteger(saved.nextSpeciesId) || saved.nextSpeciesId < 1 ||
        !Number.isSafeInteger(saved.lastGlobalImproved) ||
        (saved.evolutionVersion !== undefined && saved.evolutionVersion !== 1 && saved.evolutionVersion !== 2) ||
        (saved.evolutionVersion === 2 &&
          (!Number.isFinite(saved.compatibilityThreshold) ||
           saved.compatibilityThreshold < 0.03 || saved.compatibilityThreshold > 1.2)) ||
        typeof saved.hasChampion !== "boolean" ||
        !Array.isArray(saved.innovations) || !Array.isArray(saved.splitNodes) ||
        !Array.isArray(saved.evaluated) || !Array.isArray(checkpoint.speciesLineages) ||
        !Array.isArray(checkpoint.speciesHistory) ||
        checkpoint.population.some((genome: Genome) =>
          !Array.isArray(genome.nodes) || !Array.isArray(genome.connections) ||
          !Number.isFinite(genome.fitness))
      ) throw new Error("Motor checkpoint cannot restore the complete NEAT state");
      this.state = saved.randomState;
      this.evolutionVersion = saved.evolutionVersion === 2 ? 2 : 1;
      this.compatibilityThreshold = this.evolutionVersion === 2 &&
        Number.isFinite(saved.compatibilityThreshold)
        ? saved.compatibilityThreshold : COMPATIBILITY_THRESHOLD;
      this.innovations = new Map(saved.innovations);
      this.splitNodes = new Map(saved.splitNodes);
      this.nextInnovation = saved.nextInnovation;
      this.nextNode = saved.nextNode;
      this.genomes = structuredClone(checkpoint.population);
      this.evaluated = new Map(saved.evaluated.map(
        ([index, scenarios]: [number, number[]]) => [index, new Set(scenarios)],
      ));
      this.episode = checkpoint.episode;
      this.generation = checkpoint.generation;
      this.species = checkpoint.species;
      this.generationBestFitness = checkpoint.generationBestFitness;
      this.nextSpeciesId = saved.nextSpeciesId;
      this.lastGlobalImproved = saved.lastGlobalImproved;
      this.lineages = structuredClone(checkpoint.speciesLineages);
      this.history = structuredClone(checkpoint.speciesHistory);
      this.champion = saved.hasChampion && checkpoint.champion
        ? structuredClone(checkpoint.champion) : undefined;
      return;
    }
    if (spec.motorSource) {
      const root = this.artifactRoot;
      if (!root) throw new Error("Motor checkpoint directory is unavailable");
      const checkpoint = upgradeCheckpoint(JSON.parse(
        readFileSync(
          resolve(root, spec.motorSource, "checkpoint.json"),
          "utf8",
        ),
      ));
      const legacyInputs =
        JSON.stringify(checkpoint.inputs) ===
        JSON.stringify(inputNames.slice(0, -1));
      if (
        checkpoint.kind !== "neat-rl" ||
        !Array.isArray(checkpoint.champion?.nodes) ||
        !Array.isArray(checkpoint.champion?.connections) ||
        (!legacyInputs &&
          JSON.stringify(checkpoint.inputs) !== JSON.stringify(inputNames)) ||
        JSON.stringify(checkpoint.outputs) !== JSON.stringify(outputNames)
      )
        throw new Error("Motor source checkpoint is incompatible");
      const original = checkpoint.champion as Genome;
      const remap = (id: number) =>
        legacyInputs && id >= inputNames.length - 1 ? id + 1 : id;
      const source: Genome = legacyInputs
        ? {
            fitness: original.fitness,
            nodes: [
              ...original.nodes.map((node) => ({
                ...node,
                id: remap(node.id),
              })),
              { id: inputNames.length - 1, depth: 0 },
            ],
            connections: original.connections.map((connection) => ({
              ...connection,
              from: remap(connection.from),
              to: remap(connection.to),
            })),
          }
        : original;
      this.innovations.clear();
      this.nextInnovation = 1;
      for (const connection of source.connections) {
        this.innovations.set(
          `${connection.from}:${connection.to}`,
          connection.innovation,
        );
        this.nextInnovation = Math.max(
          this.nextInnovation,
          connection.innovation + 1,
        );
      }
      this.nextNode = Math.max(
        this.nextNode,
        ...source.nodes.map((node) => node.id + 1),
      );
      if (spec.component !== "evaluation")
        this.compatibilityThreshold = TRANSFER_COMPATIBILITY_THRESHOLD;
      this.genomes = Array.from({ length: this.genomes.length }, (_, index) => {
        if (spec.component !== "evaluation" &&
            index >= Math.ceil(this.genomes.length * 0.75))
          return this.initial();
        const genome = this.copy(source);
        if (index && spec.component !== "evaluation") this.mutate(genome);
        return genome;
      });
      if (spec.component === "evaluation")
        this.champion = { ...this.copy(source), fitness: source.fitness };
    }
  }
  private restoreLegacyPopulation(checkpoint: any) {
    this.evolutionVersion = 1;
    this.compatibilityThreshold = COMPATIBILITY_THRESHOLD;
    const legacyInputs = JSON.stringify(checkpoint.inputs) ===
      JSON.stringify(inputNames.slice(0, -1));
    if (checkpoint.kind !== "neat-rl" || checkpoint.session !== this.spec.motor ||
        checkpoint.seed !== this.spec.seed ||
        (!legacyInputs && JSON.stringify(checkpoint.inputs) !== JSON.stringify(inputNames)) ||
        JSON.stringify(checkpoint.outputs) !== JSON.stringify(outputNames) ||
        !Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 0 ||
        !Array.isArray(checkpoint.population) ||
        checkpoint.population.length !== Math.max(8, this.spec.agents) ||
        checkpoint.population.some((genome: Genome) =>
          !Array.isArray(genome.nodes) || !Array.isArray(genome.connections)) ||
        !Array.isArray(checkpoint.speciesLineages) ||
        !Array.isArray(checkpoint.speciesHistory))
      throw new Error("Legacy checkpoint has no compatible full population");
    const remap = (id: number) => legacyInputs && id >= inputNames.length - 1
      ? id + 1 : id;
    const convert = (genome: Genome): Genome => ({
      fitness: 0,
      nodes: [
        ...genome.nodes.map((node) => ({ ...node, id: remap(node.id) })),
        ...(legacyInputs ? [{ id: inputNames.length - 1, depth: 0 }] : []),
      ],
      connections: genome.connections.map((connection) => ({
        ...connection,
        from: remap(connection.from),
        to: remap(connection.to),
      })),
    });
    this.genomes = checkpoint.population.map(convert);
    this.champion = checkpoint.generation > 0 && checkpoint.champion
      ? { ...convert(checkpoint.champion), fitness: checkpoint.champion.fitness }
      : undefined;
    this.lineages = checkpoint.speciesLineages.map((lineage: SpeciesLineage) => ({
      ...lineage,
      representative: convert(lineage.representative),
    }));
    this.history = structuredClone(checkpoint.speciesHistory);
    this.generation = checkpoint.generation;
    this.episode = this.generation * motorTrialPlan(1, this.spec.agents).episodesPerEvolution;
    this.species = Math.max(1, this.lineages.length);
    this.generationBestFitness = Number(checkpoint.generationBestFitness) || 0;
    this.nextSpeciesId = Math.max(
      1,
      ...this.lineages.map((lineage) => lineage.id + 1),
      ...this.history.flatMap((entry) => entry.species.map((species) => species.id + 1)),
    );
    this.lastGlobalImproved = this.champion ? this.generation : 0;
    this.state = (this.spec.seed ^ Math.imul(this.generation + 1, 0x9e3779b9)) >>> 0;
    const graphs = [
      ...this.genomes,
      ...this.lineages.map((lineage) => lineage.representative),
      ...(this.champion ? [this.champion] : []),
    ];
    for (const genome of graphs) {
      for (const node of genome.nodes)
        this.nextNode = Math.max(this.nextNode, node.id + 1);
      for (const connection of genome.connections) {
        this.nextInnovation = Math.max(this.nextInnovation, connection.innovation + 1);
        this.innovations.set(`${connection.from}:${connection.to}`, connection.innovation);
      }
    }
    // Legacy checkpoints omitted the split registry. Recover splits still
    // represented in a genome; extinct splits receive new innovations later.
    for (const genome of graphs)
      for (const connection of genome.connections.filter((edge) => !edge.enabled)) {
        const split = genome.nodes.find((node) =>
          node.id >= inputNames.length + 1 + outputNames.length &&
          genome.connections.some((edge) => edge.from === connection.from && edge.to === node.id) &&
          genome.connections.some((edge) => edge.from === node.id && edge.to === connection.to));
        if (split) this.splitNodes.set(connection.innovation, split.id);
      }
  }
  private random() {
    return (
      (this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0) /
      4294967296
    );
  }
  private innovation(from: number, to: number) {
    const key = `${from}:${to}`;
    if (!this.innovations.has(key))
      this.innovations.set(key, this.nextInnovation++);
    return this.innovations.get(key)!;
  }
  private initial(): Genome {
    const nodes: Node[] = inputNames.map((_, id) => ({ id, depth: 0 }));
    nodes.push({ id: inputNames.length, depth: 0 });
    outputNames.forEach((_, index) =>
      nodes.push({ id: inputNames.length + 1 + index, depth: 1 }),
    );
    const connections: Connection[] = [];
    for (let from = 0; from <= inputNames.length; from++)
      for (let output = 0; output < outputNames.length; output++) {
        if (from !== inputNames.length && this.random() >= 0.25) continue;
        connections.push({
          innovation: this.innovation(from, inputNames.length + 1 + output),
          from,
          to: inputNames.length + 1 + output,
          weight: (this.random() * 2 - 1) * 0.5,
          enabled: true,
        });
      }
    return { nodes, connections, fitness: 0 };
  }
  private copy(genome: Genome): Genome {
    return {
      nodes: genome.nodes.map((node) => ({ ...node })),
      connections: genome.connections.map((connection) => ({ ...connection })),
      fitness: 0,
    };
  }
  assign(index: number) {
    const trial = motorTrialPlan(this.episode + 1, this.spec.agents);
    const candidate = trial.batch * this.spec.agents + index;
    if (candidate < this.genomes.length) this.assigned.set(index, candidate);
    else this.assigned.delete(index);
  }
  act(index: number, observation: PolicyObservation): Action {
    const candidate = this.assigned.get(index);
    if (candidate === undefined) return {};
    const genome = this.genomes[candidate];
    const values = new Map<number, number>();
    motorFeatures(observation).forEach((value, id) => values.set(id, value));
    values.set(inputNames.length, 1);
    for (const node of [...genome.nodes]
      .filter((node) => node.depth > 0)
      .sort((a, b) => a.depth - b.depth)) {
      let sum = 0;
      for (const connection of genome.connections)
        if (connection.enabled && connection.to === node.id)
          sum += (values.get(connection.from) ?? 0) * connection.weight;
      values.set(node.id, Math.tanh(sum));
    }
    const output = outputNames.map(
      (_, index) => values.get(inputNames.length + 1 + index) ?? 0,
    );
    const sneak = output[8] > 0.5 && output[8] > output[5];
    const controls = {
      forward: output[0] > 0,
      back: output[1] > 0 && output[0] <= 0,
      left: output[2] > 0 && output[3] <= 0,
      right: output[3] > 0 && output[2] <= 0,
      jump: output[4] > 0,
      sprint: output[5] > 0 && !sneak,
      sneak,
    };
    const pose = observation.inputs.channels["self.pose"]?.data as
      Record<string, unknown> | undefined;
    return {
      controls,
      look: {
        yaw: number(pose?.yaw) + output[6] * 0.25,
        pitch: clamp(
          number(pose?.pitch) + output[7] * 0.12,
          -Math.PI / 2,
          Math.PI / 2,
        ),
      },
    };
  }
  observe(index: number, reward: number) {
    const candidate = this.assigned.get(index);
    if (candidate !== undefined)
      this.trialRewards.set(
        candidate,
        (this.trialRewards.get(candidate) ?? 0) + reward,
      );
  }
  private distance(a: Genome, b: Genome) {
    const one = new Map(
      a.connections.map((connection) => [
        connection.innovation,
        connection.weight,
      ]),
    );
    const two = new Map(
      b.connections.map((connection) => [
        connection.innovation,
        connection.weight,
      ]),
    );
    const shared = [...one.keys()].filter((key) => two.has(key));
    const disjoint =
      new Set([...one.keys(), ...two.keys()]).size - shared.length;
    const weight = shared.length
      ? shared.reduce(
          (sum, key) => sum + Math.abs(one.get(key)! - two.get(key)!),
          0,
        ) / shared.length
      : 0;
    return disjoint / Math.max(1, Math.max(one.size, two.size)) + 0.4 * weight;
  }
  private mutate(genome: Genome) {
    for (const connection of genome.connections)
      if (this.random() < 0.8)
        connection.weight = clamp(
          connection.weight + (this.random() * 2 - 1) * 0.6,
          -4,
          4,
        );
    if (this.random() < 0.2) {
      const sources = genome.nodes.filter((node) => node.depth < 1);
      const from = sources[Math.floor(this.random() * sources.length)];
      const targets = genome.nodes.filter((node) => node.depth > from.depth);
      const to = targets[Math.floor(this.random() * targets.length)];
      if (
        to &&
        !genome.connections.some(
          (connection) =>
            connection.from === from.id && connection.to === to.id,
        )
      )
        genome.connections.push({
          innovation: this.innovation(from.id, to.id),
          from: from.id,
          to: to.id,
          weight: this.random() * 2 - 1,
          enabled: true,
        });
    }
    if (this.random() < 0.1) {
      const available = genome.connections.filter(
        (connection) => connection.enabled,
      );
      const split = available[Math.floor(this.random() * available.length)];
      if (split) {
        const from = genome.nodes.find((node) => node.id === split.from)!;
        const to = genome.nodes.find((node) => node.id === split.to)!;
        let id = this.splitNodes.get(split.innovation);
        if (id === undefined) {
          id = this.nextNode++;
          this.splitNodes.set(split.innovation, id);
        }
        split.enabled = false;
        genome.nodes.push({ id, depth: (from.depth + to.depth) / 2 });
        genome.connections.push({
          innovation: this.innovation(from.id, id),
          from: from.id,
          to: id,
          weight: 1,
          enabled: true,
        });
        genome.connections.push({
          innovation: this.innovation(id, to.id),
          from: id,
          to: to.id,
          weight: split.weight,
          enabled: true,
        });
      }
    }
  }
  private crossover(first: Genome, second: Genome): Genome {
    const stronger = first.fitness >= second.fitness ? first : second;
    const weaker = stronger === first ? second : first;
    const other = new Map(
      weaker.connections.map((connection) => [
        connection.innovation,
        connection,
      ]),
    );
    const child = this.copy(stronger);
    child.connections = stronger.connections.map((connection) => ({
      ...(other.has(connection.innovation) && this.random() < 0.5
        ? other.get(connection.innovation)!
        : connection),
    }));
    return child;
  }
  private evolve() {
    const ranked = [...this.genomes].sort((a, b) => b.fitness - a.fitness);
    const completedGeneration = this.generation + 1;
    this.generationBestFitness = ranked[0].fitness;
    let elite = this.genomes[0];
    if (!this.champion || ranked[0].fitness > this.champion.fitness) {
      this.champion = { ...this.copy(ranked[0]), fitness: ranked[0].fitness };
      this.lastGlobalImproved = completedGeneration;
      elite = ranked[0];
    }
    const groups: SpeciesGroup[] = [];
    for (const genome of ranked) {
      const previous = this.lineages.find(
        (lineage) =>
          this.distance(lineage.representative, genome) <
          this.compatibilityThreshold,
      );
      const group = previous
        ? groups.find((entry) => entry.id === previous.id)
        : groups.find(
            (entry) =>
              !this.lineages.some((lineage) => lineage.id === entry.id) &&
              this.distance(entry.representative, genome) <
                this.compatibilityThreshold,
          );
      if (group) group.members.push(genome);
      else {
        const lineage = previous ?? {
          id: this.nextSpeciesId++,
          representative: this.copy(genome),
          bestFitness: -Infinity,
          lastImproved: completedGeneration,
        };
        groups.push({ ...lineage, members: [genome], offspring: 0 });
      }
    }
    for (const group of groups) {
      group.representative = this.copy(group.members[0]);
      if (group.members[0].fitness > group.bestFitness) {
        group.bestFitness = group.members[0].fitness;
        group.lastImproved = completedGeneration;
      }
    }
    if (this.evolutionVersion === 2) {
      if (groups.length < TARGET_SPECIES_LOW)
        this.compatibilityThreshold = Math.max(0.03, this.compatibilityThreshold * 0.75);
      else if (groups.length > TARGET_SPECIES_HIGH)
        this.compatibilityThreshold = Math.min(1.2, this.compatibilityThreshold * 1.2);
    }
    const championGroup = groups.find((group) =>
      group.members.includes(elite),
    )!;
    let eligible = groups.filter(
      (group) =>
        group === championGroup ||
        completedGeneration - group.lastImproved <
          SPECIES_STAGNATION_GENERATIONS,
    );
    if (
      completedGeneration - this.lastGlobalImproved >=
      GLOBAL_STAGNATION_GENERATIONS
    )
      eligible = [
        championGroup,
        ...[...groups]
          .filter((group) => group !== championGroup)
          .sort((a, b) => b.bestFitness - a.bestFitness)
          .slice(0, this.evolutionVersion === 2 ? 3 : 1),
      ];
    const minimum = Math.min(
      ...eligible.flatMap((group) =>
        group.members.map((member) => member.fitness),
      ),
    );
    const weights = eligible.map(
      (group) =>
        group.members.reduce(
          (sum, member) => sum + Math.max(0, member.fitness - minimum) + 0.001,
          0,
        ) / group.members.length,
    );
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const remaining = this.genomes.length - 1; // Preserve the global champion.
    const immigrantSlots = this.evolutionVersion === 2
      ? Math.max(1, Math.floor(this.genomes.length * 0.1)) : 0;
    const breedingSlots = remaining - immigrantSlots;
    const protectedGroups = this.evolutionVersion === 2
      ? [championGroup, ...eligible.filter((group) => group !== championGroup)
          .sort((a, b) => b.bestFitness - a.bestFitness || a.id - b.id)]
          .slice(0, Math.min(4, Math.floor(breedingSlots / 2)))
      : [];
    const reserved = protectedGroups.length * 2;
    const quotas = weights.map((weight) =>
      ((breedingSlots - reserved) * weight) / totalWeight);
    eligible.forEach((group, index) => {
      group.offspring = (protectedGroups.includes(group) ? 2 : 0) + Math.floor(quotas[index]);
    });
    const spare =
      breedingSlots - eligible.reduce((sum, group) => sum + group.offspring, 0);
    const remainders = eligible
      .map((group, index) => ({ group, fraction: quotas[index] % 1 }))
      .sort((a, b) => b.fraction - a.fraction || a.group.id - b.group.id);
    for (let index = 0; index < spare; index++)
      remainders[index].group.offspring++;
    this.history.push({
      generation: completedGeneration,
      bestFitness: this.champion!.fitness,
      generationBestFitness: ranked[0].fitness,
      species: groups.map((group) => ({
        id: group.id,
        size: group.members.length,
        bestFitness: group.members[0].fitness,
        offspring: group.offspring + (group === championGroup ? 1 : 0),
        stagnant: !eligible.includes(group),
      })),
    });
    if (this.history.length > 256) this.history.shift();
    const next = [this.copy(this.champion!)];
    for (const group of eligible) {
      let slots = group.offspring;
      if (group.members.length > 5 && slots > 1 && group !== championGroup) {
        next.push(this.copy(group.members[0]));
        slots--;
      }
      const pool = group.members.slice(
        0,
        Math.max(1, Math.ceil(group.members.length / 2)),
      );
      for (let index = 0; index < slots; index++) {
        const a = pool[Math.floor(this.random() * pool.length)];
        const b = pool[Math.floor(this.random() * pool.length)];
        const child = this.crossover(a, b);
        this.mutate(child);
        next.push(child);
      }
    }
    for (let index = 0; index < immigrantSlots; index++)
      next.push(this.initial());
    this.genomes = next;
    this.lineages = eligible
      .filter((group) => group.offspring > 0 || group === championGroup)
      .map(({ id, representative, bestFitness, lastImproved }) => ({
        id,
        representative,
        bestFitness,
        lastImproved,
      }));
    this.species = this.lineages.length;
    this.evaluated.clear();
    this.generation++;
  }
  endEpisode() {
    if (this.spec.component === "evaluation") {
      this.assigned.clear();
      this.trialRewards.clear();
      this.episode++;
      return false;
    }
    const trial = motorTrialPlan(this.episode + 1, this.spec.agents);
    for (const candidate of this.assigned.values()) {
      this.genomes[candidate].fitness +=
        (this.trialRewards.get(candidate) ?? 0) / MOTOR_TRIALS_PER_EVOLUTION;
      const scenarios = this.evaluated.get(candidate) ?? new Set<number>();
      scenarios.add(trial.scenario);
      this.evaluated.set(candidate, scenarios);
    }
    this.assigned.clear();
    this.trialRewards.clear();
    this.episode++;
    if (
      this.evaluated.size < this.genomes.length ||
      [...this.evaluated.values()].some(
        (scenarios) => scenarios.size < MOTOR_TRIALS_PER_EVOLUTION,
      )
    )
      return false;
    this.evolve();
    return true;
  }
  report() {
    return {
      generation: this.generation,
      species: this.species,
      bestFitness: this.champion?.fitness ?? 0,
      evaluated: [...this.evaluated.values()].filter(
        (scenarios) => scenarios.size === MOTOR_TRIALS_PER_EVOLUTION,
      ).length,
      trialEvaluations: [...this.evaluated.values()].reduce(
        (sum, scenarios) => sum + scenarios.size,
        0,
      ),
      generationBestFitness: this.generationBestFitness,
      compatibilityThreshold: this.compatibilityThreshold,
      evolutionVersion: this.evolutionVersion,
      trialsPerGenome: MOTOR_TRIALS_PER_EVOLUTION,
      episodesPerEvolution: motorTrialPlan(1, this.spec.agents)
        .episodesPerEvolution,
      population: this.genomes.length,
    };
  }
  checkpoint() {
    return {
      kind: "neat-rl",
      session: this.spec.motor,
      sourceRunId: this.spec.motorSource,
      resumeRunId: this.spec.motorResume,
      agents: this.spec.agents,
      episode: this.episode,
      inputs: inputNames,
      outputs: outputNames,
      ...this.report(),
      champion: this.champion ?? this.genomes[0],
      population: this.genomes,
      speciesHistory: this.history,
      speciesLineages: this.lineages,
      resumeState: {
        version: 1,
        evolutionVersion: this.evolutionVersion,
        compatibilityThreshold: this.compatibilityThreshold,
        randomState: this.state,
        innovations: [...this.innovations],
        splitNodes: [...this.splitNodes],
        nextInnovation: this.nextInnovation,
        nextNode: this.nextNode,
        evaluated: [...this.evaluated].map(([index, scenarios]) => [index, [...scenarios]]),
        nextSpeciesId: this.nextSpeciesId,
        lastGlobalImproved: this.lastGlobalImproved,
        hasChampion: !!this.champion,
      },
    };
  }
  inspect(role: "policy" | "trainer", agentIndex?: number): ModelInspection {
    const candidate =
      role === "policy" && agentIndex !== undefined
        ? this.assigned.get(agentIndex)
        : undefined;
    const genome =
      candidate !== undefined
        ? this.genomes[candidate]
        : (this.champion ?? this.genomes[0]);
    const nodeId = (id: number) => `node-${id}`;
    const nodes = genome.nodes.map((node) => ({
      id: nodeId(node.id),
      label:
        node.id < inputNames.length
          ? node.id === 6
            ? "yaw_sin"
            : inputNames[node.id]
          : node.id === inputNames.length
            ? "bias"
            : node.id < inputNames.length + 1 + outputNames.length
              ? outputNames[node.id - inputNames.length - 1]
              : `hidden ${node.id}`,
      kind:
        node.depth === 0
          ? node.id === inputNames.length
            ? "bias"
            : "input"
          : node.depth === 1
            ? "output"
            : "hidden",
      config: { depth: node.depth },
    }));
    return {
      implementation:
        role === "policy" ? "MotorNeatPolicy" : "MotorNeatEvolution",
      framework: "TypeScript",
      status: "ready",
      parameters: genome.connections.length,
      trainableParameters: genome.connections.filter(
        (connection) => connection.enabled,
      ).length,
      hyperparameters: {
        algorithm: "NEAT evolutionary reinforcement learning",
        session: this.spec.motor ?? "M0",
        population: this.genomes.length,
        generation: this.generation,
        species: this.species,
        ...(candidate !== undefined && this.spec.component !== "evaluation"
          ? { genomeIndex: candidate }
          : {}),
        ...(role === "policy" && candidate === undefined
          ? {
              assignment:
                "No active trial; showing champion or first population genome",
            }
          : {}),
        partialFitness: genome.fitness,
        evaluationOnly: this.spec.component === "evaluation",
        trialsPerGenome: MOTOR_TRIALS_PER_EVOLUTION,
        episodesPerEvolution: motorTrialPlan(1, this.spec.agents)
          .episodesPerEvolution,
        compatibilityThreshold: this.compatibilityThreshold,
        evolutionVersion: this.evolutionVersion,
        immigrantGenomesPerEvolution: this.evolutionVersion === 2
          ? Math.max(1, Math.floor(this.genomes.length * 0.1)) : 0,
        speciesStagnationGenerations: SPECIES_STAGNATION_GENERATIONS,
        bestFitness: this.champion?.fitness ?? 0,
      },
      nodes,
      edges: genome.connections.map((connection) => ({
        from: nodeId(connection.from),
        to: nodeId(connection.to),
        label: `${connection.enabled ? "enabled" : "disabled"} · weight ${connection.weight.toFixed(3)} · innovation ${connection.innovation}`,
      })),
    };
  }
}

export class MotorPolicy implements Policy {
  constructor(
    private population: MotorNeat,
    private index: number,
  ) {}
  async reset(_seed: number) {
    this.population.assign(this.index);
  }
  async act(observation: PolicyObservation) {
    return this.population.act(this.index, observation);
  }
  inspectModel() {
    return this.population.inspect("policy", this.index);
  }
  async close() {}
}
/** Load a frozen champion for a downstream skill caller. Call reset before act. */
export function loadMotorSkill(
  sourceRunId: string,
  artifactRoot: string,
  session: RunSpec["motor"] = "M0",
): MotorPolicy {
  if (!/^[a-f0-9-]{36}$/.test(sourceRunId))
    throw new Error("Invalid motor skill source run ID");
  const population = new MotorNeat(
    {
      stage: "motor",
      motor: session,
      motorSource: sourceRunId,
      mode: "minecraft",
      component: "evaluation",
      agents: 1,
      episodes: 1,
      ticksPerEpisode: 1,
      tickMs: 100,
      seed: 42,
    },
    artifactRoot,
  );
  return new MotorPolicy(population, 0);
}
export class MotorTrainer implements Trainer {
  constructor(private population: MotorNeat) {}
  async observe(agentId: string, transition: Transition) {
    const index = Number(agentId.slice(agentId.lastIndexOf(":") + 1));
    this.population.observe(index, transition.reward);
  }
  async endEpisode(_episode: number) {
    this.population.endEpisode();
    return this.population.report();
  }
  async checkpoint() {
    return this.population.checkpoint();
  }
  inspectModel() {
    return this.population.inspect("trainer");
  }
}
