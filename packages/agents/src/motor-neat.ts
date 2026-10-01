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
];
type Node = { id: number; depth: number };
type Connection = {
  innovation: number;
  from: number;
  to: number;
  weight: number;
  enabled: boolean;
};
type Genome = { nodes: Node[]; connections: Connection[]; fitness: number };
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function features(observation: PolicyObservation): number[] {
  const pose = observation.inputs.channels["self.pose"]?.data as
    Record<string, any> | undefined;
  const velocity = pose?.velocity ?? {};
  const geometry = observation.inputs.channels["vision.geometry"]?.data as
    Record<string, any> | undefined;
  const depth = Array.isArray(geometry?.depth) ? geometry.depth : [];
  const width = number(geometry?.width),
    height = number(geometry?.height);
  const sampleDepth = (column: number) =>
    width > 0 && height > 0
      ? clamp(
          number(
            depth[
              Math.floor(height / 2) * width + Math.floor(column * (width - 1))
            ],
          ) / 8,
          0,
          1,
        )
      : 0;
  const target = observation.motor ?? { targetDx: 0, targetDy: 0, targetDz: 0 };
  return [
    clamp(target.targetDx / 24, -1, 1),
    clamp(target.targetDy / 8, -1, 1),
    clamp(target.targetDz / 24, -1, 1),
    clamp(number(velocity.x), -1, 1),
    clamp(number(velocity.y), -1, 1),
    clamp(number(velocity.z), -1, 1),
    Math.sin(number(pose?.yaw)),
    clamp(number(pose?.pitch) / (Math.PI / 2), -1, 1),
    pose?.onGround ? 1 : 0,
    sampleDepth(0.25),
    sampleDepth(0.5),
    sampleDepth(0.75),
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
  private evaluated = new Set<number>();
  private episode = 0;
  private generation = 0;
  private species = 1;
  private champion?: Genome;
  constructor(private spec: RunSpec) {
    this.state = spec.seed >>> 0;
    for (let i = 0; i < Math.max(8, spec.agents); i++)
      this.genomes.push(this.initial());
    if (spec.motorSource) {
      const root = process.env.ARTIFACT_DIR;
      if (!root) throw new Error("Motor checkpoint directory is unavailable");
      const checkpoint = JSON.parse(
        readFileSync(
          resolve(root, spec.motorSource, "checkpoint.json"),
          "utf8",
        ),
      );
      if (
        checkpoint.kind !== "neat-rl" ||
        !Array.isArray(checkpoint.champion?.nodes) ||
        !Array.isArray(checkpoint.champion?.connections) ||
        JSON.stringify(checkpoint.inputs) !== JSON.stringify(inputNames) ||
        JSON.stringify(checkpoint.outputs) !== JSON.stringify(outputNames)
      )
        throw new Error("Motor source checkpoint is incompatible");
      const source = checkpoint.champion as Genome;
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
      this.genomes = Array.from({ length: this.genomes.length }, (_, index) => {
        const genome = this.copy(source);
        if (index) this.mutate(genome);
        return genome;
      });
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
      for (let output = 0; output < outputNames.length; output++)
        connections.push({
          innovation: this.innovation(from, inputNames.length + 1 + output),
          from,
          to: inputNames.length + 1 + output,
          weight: (this.random() * 2 - 1) * 0.5,
          enabled: true,
        });
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
    const candidate =
      (this.episode * this.spec.agents + index) % this.genomes.length;
    this.assigned.set(index, candidate);
  }
  act(index: number, observation: PolicyObservation): Action {
    const genome =
      this.genomes[this.assigned.get(index) ?? index % this.genomes.length];
    const values = new Map<number, number>();
    features(observation).forEach((value, id) => values.set(id, value));
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
    const controls = {
      forward: output[0] > 0,
      back: output[1] > 0 && output[0] <= 0,
      left: output[2] > 0 && output[3] <= 0,
      right: output[3] > 0 && output[2] <= 0,
      jump: output[4] > 0,
      sprint: output[5] > 0,
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
    if (candidate !== undefined) this.genomes[candidate].fitness += reward;
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
  endEpisode() {
    for (const candidate of this.assigned.values())
      this.evaluated.add(candidate);
    this.assigned.clear();
    this.episode++;
    if (this.evaluated.size < this.genomes.length) return false;
    const ranked = [...this.genomes].sort((a, b) => b.fitness - a.fitness);
    if (!this.champion || ranked[0].fitness > this.champion.fitness)
      this.champion = { ...this.copy(ranked[0]), fitness: ranked[0].fitness };
    const groups: Genome[][] = [];
    for (const genome of ranked) {
      const group = groups.find(
        (group) => this.distance(group[0], genome) < 0.6,
      );
      if (group) group.push(genome);
      else groups.push([genome]);
    }
    this.species = groups.length;
    const next: Genome[] = groups.map((group) => this.copy(group[0]));
    while (next.length < this.genomes.length) {
      const group = groups[Math.floor(this.random() * groups.length)];
      const pool = group.slice(0, Math.max(1, Math.ceil(group.length / 2)));
      const a = pool[Math.floor(this.random() * pool.length)];
      const b = pool[Math.floor(this.random() * pool.length)];
      const child = this.crossover(a, b);
      this.mutate(child);
      next.push(child);
    }
    this.genomes = next.slice(0, this.genomes.length);
    this.evaluated.clear();
    this.generation++;
    return true;
  }
  report() {
    return {
      generation: this.generation,
      species: this.species,
      bestFitness: this.champion?.fitness ?? 0,
      evaluated: this.evaluated.size,
      population: this.genomes.length,
    };
  }
  checkpoint() {
    return {
      kind: "neat-rl",
      session: this.spec.motor,
      sourceRunId: this.spec.motorSource,
      inputs: inputNames,
      outputs: outputNames,
      ...this.report(),
      champion: this.champion ?? this.genomes[0],
      population: this.genomes,
    };
  }
  inspect(role: "policy" | "trainer"): ModelInspection {
    const genome = this.champion ?? this.genomes[0];
    return {
      implementation:
        role === "policy" ? "MotorNeatPolicy" : "MotorNeatEvolution",
      framework: "TypeScript",
      status: "ready",
      parameters: genome.connections.filter((connection) => connection.enabled)
        .length,
      trainableParameters: genome.connections.filter(
        (connection) => connection.enabled,
      ).length,
      hyperparameters: {
        algorithm: "NEAT evolutionary reinforcement learning",
        session: this.spec.motor ?? "M0",
        population: this.genomes.length,
        generation: this.generation,
        species: this.species,
      },
      nodes: [
        {
          id: "inputs",
          label: inputNames.join(", "),
          kind: "input",
          inputShape: [inputNames.length],
        },
        {
          id: "genome",
          label: `Evolved graph · ${genome.nodes.length} nodes`,
          kind: "NEAT graph",
          parameters: genome.connections.length,
        },
        {
          id: "outputs",
          label: outputNames.join(", "),
          kind: "action",
          outputShape: [outputNames.length],
        },
      ],
      edges: [
        { from: "inputs", to: "genome" },
        { from: "genome", to: "outputs" },
      ],
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
    return this.population.inspect("policy");
  }
  async close() {}
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
