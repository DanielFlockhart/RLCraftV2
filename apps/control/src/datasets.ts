import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  lstatSync,
  createReadStream,
} from "node:fs";
import { z } from "zod";
import type {
  DatasetGenerator,
  DatasetJob,
  DatasetSnapshot,
  DatasetExamples,
  GoalSelectionExample,
} from "@rlcraft/core";

// Only trusted, repository-owned scripts are executable. Add future generators here.
export const datasetRegistry: (DatasetGenerator & { script: string })[] = [
  {
    id: "phase1a",
    name: "Phase 1A · Goal selection",
    version: "2.2.0",
    description:
      "Goal selection with a required edge-case matrix, family-balanced sampling, item slots, blocked-state labels and per-split coverage reports.",
    script: "scripts/datasets/phase1a.py",
    supportsExpansion: true,
    artifacts: [
      "train.jsonl",
      "validation.jsonl",
      "test.jsonl",
      "ood_test.jsonl",
      "metadata.json",
    ],
    parameters: [
      {
        key: "seed",
        label: "Random seed",
        flag: "--seed",
        default: 42,
        min: 0,
        max: 2147483647,
        integer: true,
      },
      {
        key: "trainSize",
        label: "Training rows",
        flag: "--train-size",
        default: 100000,
        min: 0,
        max: 2000000,
        integer: true,
      },
      {
        key: "validationSize",
        label: "Validation rows",
        flag: "--validation-size",
        default: 10000,
        min: 0,
        max: 2000000,
        integer: true,
      },
      {
        key: "testSize",
        label: "Test rows",
        flag: "--test-size",
        default: 10000,
        min: 0,
        max: 2000000,
        integer: true,
      },
      {
        key: "oodSize",
        label: "OOD test rows",
        flag: "--ood-size",
        default: 5000,
        min: 0,
        max: 2000000,
        integer: true,
      },
      {
        key: "boundaryFraction",
        label: "Boundary fraction within random samples",
        flag: "--boundary-fraction",
        default: 0.3,
        min: 0,
        max: 1,
        integer: false,
      },
      {
        key: "edgeFraction",
        label: "Additional edge-case sampling fraction",
        flag: "--edge-fraction",
        default: 0.6,
        min: 0,
        max: 1,
        integer: false,
      },
      {
        key: "temperature",
        label: "Teacher temperature",
        flag: "--temperature",
        default: 5,
        min: 0.1,
        max: 100,
        integer: false,
      },
      {
        key: "maxGenerationMultiplier",
        label: "Maximum attempts per new row",
        flag: "--max-generation-multiplier",
        default: 50,
        min: 1,
        max: 1000,
        integer: true,
      },
    ],
  },
];
export const datasetRequestSchema = z
  .object({
    generatorId: z.string().min(1),
    parameters: z.record(z.string(), z.number()).default({}),
    parentId: z.uuid().optional(),
  })
  .strict();
const idSchema = z.uuid();
export const datasetExamplesQuery = z
  .object({
    split: z.enum(["train", "validation", "test", "ood_test"]).default("train"),
    offset: z.coerce.number().int().min(0).max(100000000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export class DatasetManager {
  private jobs = new Map<string, DatasetJob>();
  private active?: {
    job: DatasetJob;
    child: ChildProcess;
    done: Promise<void>;
  };
  private closing = false;
  constructor(
    private directory: string,
    private root: string,
    private python: string,
  ) {
    mkdirSync(directory, { recursive: true });
    for (const id of readdirSync(directory)) {
      if (!idSchema.safeParse(id).success) continue;
      const path = join(directory, id, "job.json");
      if (!existsSync(path)) continue;
      const job = JSON.parse(readFileSync(path, "utf8")) as DatasetJob;
      if (job.id !== id) throw new Error(`Invalid dataset job record: ${id}`);
      if (job.status === "running") {
        job.status = "failed";
        job.error =
          "Control service stopped before this job finished. Rerun to create a new version.";
        job.finishedAt = Date.now();
        this.save(job);
      }
      this.jobs.set(id, job);
    }
  }
  snapshot(): DatasetSnapshot {
    return {
      generators: datasetRegistry.map(
        ({ script: _script, ...descriptor }) => descriptor,
      ),
      jobs: [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt),
    };
  }
  private save(job: DatasetJob) {
    const target = join(this.directory, job.id, "job.json");
    writeFileSync(`${target}.tmp`, JSON.stringify(job, null, 2));
    renameSync(`${target}.tmp`, target);
  }
  get(id: string) {
    idSchema.parse(id);
    const job = this.jobs.get(id);
    if (!job) throw new Error("Dataset job not found");
    return job;
  }
  private generator(id: string) {
    const generator = datasetRegistry.find((entry) => entry.id === id);
    if (!generator) throw new Error("Unknown dataset generator");
    return generator;
  }
  start(request: unknown): DatasetJob {
    if (this.closing) throw new Error("Control service is shutting down");
    if (this.active)
      throw new Error(
        "A dataset job is already running. Wait or cancel it first.",
      );
    const spec = datasetRequestSchema.parse(request);
    const generator = this.generator(spec.generatorId);
    const shape = Object.fromEntries(
      generator.parameters.map((p) => {
        let value = z.number().min(p.min).max(p.max);
        if (p.integer) value = value.int();
        return [p.key, value.default(p.default)];
      }),
    );
    const parameters = z
      .object(shape)
      .strict()
      .parse(spec.parameters) as Record<string, number>;
    if (generator.id === "phase1a") {
      const total =
        parameters.trainSize +
        parameters.validationSize +
        parameters.testSize +
        parameters.oodSize;
      if (total < 1 || total > 2000000)
        throw new Error("Request 1..2,000,000 total new rows");
    }
    const script = resolve(this.root, generator.script);
    const sourceHash = createHash("sha256")
      .update(readFileSync(script))
      .digest("hex");
    let parent: DatasetJob | undefined;
    if (spec.parentId) {
      parent = this.get(spec.parentId);
      if (
        !generator.supportsExpansion ||
        parent.status !== "completed" ||
        parent.generatorId !== generator.id
      )
        throw new Error(
          "Select a completed dataset from the same generator to expand",
        );
      if (
        parent.sourceHash !== sourceHash ||
        parent.generatorVersion !== generator.version
      )
        throw new Error(
          "Generator code changed. Generate a new dataset instead of mixing teacher versions.",
        );
      if (
        generator.id === "phase1a" &&
        parameters.temperature !== parent.parameters.temperature
      )
        throw new Error("Expansion must use the parent's teacher temperature");
    }
    const job: DatasetJob = {
      id: randomUUID(),
      generatorId: generator.id,
      generatorVersion: generator.version,
      sourceHash,
      parameters,
      ...(parent ? { parentId: parent.id } : {}),
      status: "running",
      createdAt: Date.now(),
      logs: [],
      artifacts: [],
    };
    const jobDir = join(this.directory, job.id);
    mkdirSync(jobDir);
    this.save(job);
    this.jobs.set(job.id, job);
    const args = [
      "-u",
      script,
      "--output-dir",
      join(jobDir, "output"),
      ...generator.parameters.flatMap((p) => [
        p.flag,
        String(parameters[p.key]),
      ]),
      ...(parent
        ? ["--parent-dir", join(this.directory, parent.id, "output")]
        : []),
    ];
    const child = spawn(this.python, args, {
      cwd: this.root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let finish!: () => void;
    const done = new Promise<void>((r) => {
      finish = r;
    });
    this.active = { child, job, done };
    const log = (line: string) => {
      job.logs.push(line.slice(0, 2000));
      if (job.logs.length > 100) job.logs.shift();
      try {
        const progress = z
          .object({
            split: z.string(),
            rows: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
          })
          .parse(JSON.parse(line));
        job.progress = progress;
      } catch {
        /* Ordinary stdout/stderr is still shown in job logs. */
      }
      this.save(job);
    };
    createInterface({ input: child.stdout! }).on("line", log);
    createInterface({ input: child.stderr! }).on("line", log);
    child.once("error", (error) => {
      job.error = `Could not start generator with ${this.python}: ${error.message}. Configure PYTHON_PATH for Python 3.10 or newer.`;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (job.status === "running") {
        try {
          if (code !== 0 || job.error)
            throw new Error(
              job.error ?? `Generator exited ${code}; see its logs.`,
            );
          for (const file of generator.artifacts) {
            const info = lstatSync(join(jobDir, "output", file));
            if (!info.isFile() || info.isSymbolicLink())
              throw new Error(`Missing regular output file: ${file}`);
          }
          job.status = "completed";
          job.artifacts = [...generator.artifacts];
        } catch (error) {
          job.status = "failed";
          job.error = (error as Error).message;
        }
      }
      job.finishedAt = Date.now();
      this.save(job);
      this.active = undefined;
      finish();
    });
    const timeout = setTimeout(() => {
      job.error = "Generator exceeded the one-hour time limit";
      child.kill("SIGKILL");
    }, 3600000);
    return job;
  }
  rerun(id: string) {
    const job = this.get(id);
    return this.start({
      generatorId: job.generatorId,
      parameters: job.parameters,
      ...(job.parentId ? { parentId: job.parentId } : {}),
    });
  }
  cancel(id: string) {
    const job = this.get(id);
    if (this.active?.job.id !== id || job.status !== "running")
      throw new Error("Dataset job is not running");
    job.status = "cancelled";
    this.save(job);
    this.active.child.kill("SIGKILL");
    return job;
  }
  artifact(id: string, file: string) {
    const job = this.get(id);
    if (
      job.status !== "completed" ||
      !job.artifacts.includes(file) ||
      !(
        this.generator(job.generatorId).artifacts.includes(file) ||
        (job.generatorId === "phase1a" &&
          ["train.csv", "validation.csv", "test.csv", "ood_test.csv"].includes(
            file,
          ))
      )
    )
      throw new Error("Dataset artifact is unavailable");
    const path = join(this.directory, id, "output", file);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Invalid dataset artifact");
    return path;
  }
  async examples(id: string, query: unknown): Promise<DatasetExamples> {
    const { split, offset, limit } = datasetExamplesQuery.parse(query);
    const job = this.get(id);
    if (
      job.generatorId !== "phase1a" ||
      !job.artifacts.includes(`${split}.jsonl`)
    )
      throw new Error(
        "This dataset uses the older aggregate format. Generate a new Phase 1A dataset to inspect item stacks and slots.",
      );
    const path = this.artifact(id, `${split}.jsonl`);
    const indexPath = join(this.directory, id, "output", `${split}.index.json`);
    const info = lstatSync(indexPath);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Invalid dataset example index");
    const index = z
      .object({
        stride: z.number().int().min(1).max(4096),
        rows: z.number().int().nonnegative(),
        offsets: z.array(z.number().int().nonnegative()),
      })
      .parse(JSON.parse(readFileSync(indexPath, "utf8")));
    const { logs: _logs, ...descriptor } = job;
    const result: DatasetExamples = {
      job: descriptor,
      split,
      offset,
      total: index.rows,
      examples: [],
    };
    const metadata = JSON.parse(
      readFileSync(this.artifact(id, "metadata.json"), "utf8"),
    );
    if (metadata.coverage?.[split]) result.coverage = metadata.coverage[split];
    if (offset >= index.rows) return result;
    const block = Math.floor(offset / index.stride);
    if (index.offsets[block] === undefined)
      throw new Error("Dataset example index is incomplete");
    const stream = createReadStream(path, {
      start: index.offsets[block],
      encoding: "utf8",
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let row = block * index.stride;
    try {
      for await (const line of lines) {
        if (row >= offset) {
          const data = JSON.parse(line) as GoalSelectionExample;
          if (data.schema_version !== 2)
            throw new Error("Unsupported inventory example schema");
          result.examples.push({ index: row, data });
          if (result.examples.length >= limit) break;
        }
        row++;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return result;
  }
  async close() {
    this.closing = true;
    if (!this.active) return;
    const { job, done } = this.active;
    if (job.status === "running") this.cancel(job.id);
    await done;
  }
}
