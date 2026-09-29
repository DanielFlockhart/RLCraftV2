import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { z } from "zod";
import type {
  GoalModelJob,
  GoalModelSnapshot,
  GoalPrediction,
  GoalEpochMetric,
} from "@rlcraft/core";
import { DatasetManager } from "./datasets.js";

export const goalTrainingParameters = z
  .object({
    epochs: z.number().int().min(1).max(1000).default(30),
    batchSize: z.number().int().min(8).max(8192).default(256),
    width: z.number().int().min(16).max(1024).default(128),
    layers: z.number().int().min(1).max(8).default(3),
    learningRate: z.number().min(0.000001).max(0.1).default(0.001),
    dropout: z.number().min(0).max(0.8).default(0.1),
    hardWeight: z.number().min(0).max(1).default(0.5),
    patience: z.number().int().min(1).max(100).default(5),
    seed: z.number().int().min(0).max(2147483647).default(42),
    threads: z.number().int().min(1).max(16).default(2),
    device: z.enum(["cpu", "cuda"]).default("cpu"),
  })
  .strict();
const requestSchema = z
  .object({
    datasetId: z.uuid(),
    parameters: goalTrainingParameters.partial().default({}),
    parentId: z.uuid().optional(),
    trainingMode: z.enum(["fine_tune", "continue"]).optional(),
  })
  .strict();
const idSchema = z.uuid();
const artifacts = [
  "checkpoint.pt",
  "config.json",
  "evaluation.json",
  "history.jsonl",
  "teacher.py",
  "dataset.json",
];
const predictionSchema = z
  .object({
    example: z.object({
      inventory: z.object({
        size: z.literal(41),
        selected_hotbar_slot: z.number().int().min(0).max(8),
        slots: z
          .array(
            z.object({
              item: z.string().max(128),
              count: z.number().int().min(1).max(64),
              slot: z.number().int().min(0).max(40),
            }),
          )
          .max(41),
      }),
      context: z.record(
        z.string(),
        z.union([z.boolean(), z.number().finite()]),
      ),
    }),
  })
  .strict();

export class GoalModelManager {
  private jobs = new Map<string, GoalModelJob>();
  private active?: {
    job: GoalModelJob;
    child: ChildProcess;
    done: Promise<void>;
  };
  private closing = false;
  private worker?: ChildProcess;
  private pending = new Map<
    string,
    {
      resolve: (result: GoalPrediction) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private directory: string,
    private root: string,
    private python: string,
    private datasets: DatasetManager,
  ) {
    mkdirSync(directory, { recursive: true });
    for (const id of readdirSync(directory)) {
      if (
        !idSchema.safeParse(id).success ||
        !existsSync(join(directory, id, "job.json"))
      )
        continue;
      const job = JSON.parse(
        readFileSync(join(directory, id, "job.json"), "utf8"),
      ) as GoalModelJob;
      if (job.id !== id) throw new Error(`Invalid goal model record: ${id}`);
      if (job.status === "running") {
        job.status = "failed";
        job.error =
          "Control service stopped before training finished. Rerun to train a new model.";
        job.finishedAt = Date.now();
        this.save(job);
      }
      this.jobs.set(id, job);
    }
  }
  private save(job: GoalModelJob) {
    const path = join(this.directory, job.id, "job.json");
    writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2));
    renameSync(`${path}.tmp`, path);
  }
  snapshot(): GoalModelSnapshot {
    return {
      defaults: goalTrainingParameters.parse({}),
      jobs: [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt),
    };
  }
  get(id: string) {
    idSchema.parse(id);
    const job = this.jobs.get(id);
    if (!job) throw new Error("Goal model not found");
    return job;
  }
  start(request: unknown) {
    if (this.closing) throw new Error("Control service is shutting down");
    if (this.active)
      throw new Error(
        "A goal model is already training. Wait or cancel it first.",
      );
    const spec = requestSchema.parse(request);
    const parent = spec.parentId ? this.get(spec.parentId) : undefined;
    if (spec.trainingMode && !parent)
      throw new Error("Choose a saved model to continue or fine-tune");
    if (parent && parent.status !== "completed")
      throw new Error("Fine-tuning requires a completed model");
    const parameters = goalTrainingParameters.parse({
      ...parent?.parameters,
      ...spec.parameters,
    });
    const dataset = this.datasets.get(spec.datasetId);
    if (spec.trainingMode === "continue" && parent) {
      if (dataset.id !== parent.datasetId)
        throw new Error(
          "Continue on the same dataset; use fine-tuning for expansions",
        );
      for (const key of [
        "batchSize",
        "learningRate",
        "hardWeight",
        "seed",
      ] as const) {
        if (parameters[key] !== parent.parameters[key])
          throw new Error(
            `Continuation preserves ${key}; use fine-tuning to change it`,
          );
      }
    }
    if (parent) {
      let lineage = dataset;
      const visited = new Set<string>();
      while (
        lineage.id !== parent.datasetId &&
        lineage.parentId &&
        !visited.has(lineage.id)
      ) {
        visited.add(lineage.id);
        lineage = this.datasets.get(lineage.parentId);
      }
      if (lineage.id !== parent.datasetId)
        throw new Error(
          "Fine-tune using the original dataset or an expansion that preserves its splits",
        );
    }
    if (
      dataset.status !== "completed" ||
      dataset.generatorId !== "phase1a" ||
      !dataset.artifacts.includes("train.jsonl")
    )
      throw new Error("Choose a completed Phase 1A JSONL dataset");
    const metadataPath = this.datasets.artifact(dataset.id, "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (!(
      metadata.split_sizes?.train > 0 && metadata.split_sizes?.validation > 0
    ))
      throw new Error("Dataset needs non-empty train and validation splits");
    const teacher = join(this.root, "scripts/datasets/phase1a.py");
    const teacherHash = createHash("sha256")
      .update(readFileSync(teacher))
      .digest("hex");
    if (metadata.source_hash !== teacherHash)
      throw new Error(
        "Dataset teacher changed. Generate a new dataset before training.",
      );
    // Validate each registered input; no caller-provided filesystem paths.
    if (parent) {
      this.artifact(parent.id, "checkpoint.pt");
      const saved = JSON.parse(
        readFileSync(this.artifact(parent.id, "config.json"), "utf8"),
      );
      if (saved.teacher_hash !== teacherHash)
        throw new Error("Fine-tuning requires the same teacher rules");
      if (
        saved.architecture.width !== parameters.width ||
        saved.architecture.layers !== parameters.layers ||
        saved.architecture.dropout !== parameters.dropout
      )
        throw new Error(
          "Fine-tuning must preserve the checkpoint architecture",
        );
    }
    for (const split of ["train", "validation", "test", "ood_test"])
      this.datasets.artifact(dataset.id, `${split}.jsonl`);
    const script = join(this.root, "scripts/learning/phase1a.py");
    const job: GoalModelJob = {
      id: randomUUID(),
      datasetId: dataset.id,
      modelVersion: "1.0.0",
      sourceHash: createHash("sha256")
        .update(readFileSync(script))
        .digest("hex"),
      parameters,
      ...(parent ? { parentId: parent.id } : {}),
      trainingMode: parent
        ? (spec.trainingMode ?? "fine_tune")
        : "from_scratch",
      status: "running",
      createdAt: Date.now(),
      phase: "Starting training",
      logs: [],
      metrics: [],
      artifacts: [],
    };
    mkdirSync(join(this.directory, job.id));
    this.jobs.set(job.id, job);
    this.save(job);
    const flags = Object.entries(parameters).flatMap(([key, value]) => [
      `--${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`,
      String(value),
    ]);
    const child = spawn(
      this.python,
      [
        "-u",
        script,
        "train",
        "--dataset-dir",
        join(metadataPath, ".."),
        "--dataset-id",
        dataset.id,
        "--output-dir",
        join(this.directory, job.id, "output"),
        ...flags,
        ...(parent
          ? [
              "--parent-dir",
              join(this.directory, parent.id, "output"),
              "--parent-id",
              parent.id,
            ]
          : []),
        ...(spec.trainingMode === "continue" ? ["--continue-training"] : []),
      ],
      { cwd: this.root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active = { job, child, done };
    const log = (line: string) => {
      job.logs.push(line.slice(0, 4000));
      if (job.logs.length > 100) job.logs.shift();
      try {
        const event = JSON.parse(line);
        if (event.event === "loading") job.phase = `Loading ${event.split}`;
        if (event.event === "baseline") job.phase = "Training";
        if (event.event === "epoch") {
          const { event: _, best_epoch: __, ...metric } = event;
          job.metrics.push(metric as GoalEpochMetric);
          job.phase = `Epoch ${event.epoch} / ${job.parameters.epochs}`;
        }
        if (event.event === "completed") job.phase = "Evaluation complete";
      } catch {
        /* stderr remains available in the logs */
      }
      this.save(job);
    };
    createInterface({ input: child.stdout! }).on("line", log);
    createInterface({ input: child.stderr! }).on("line", log);
    child.once("error", (error) => {
      job.error = `Could not start training with ${this.python}: ${error.message}. Check PYTHON_PATH.`;
    });
    const timeout = setTimeout(() => {
      job.error = "Training exceeded the six-hour limit";
      child.kill("SIGKILL");
    }, 6 * 3600000);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (job.status === "running") {
        try {
          if (code !== 0 || job.error)
            throw new Error(
              job.error ??
                `Training exited ${code}. ${job.logs.slice(-3).join(" ")}`,
            );
          for (const file of artifacts) {
            const info = lstatSync(
              join(this.directory, job.id, "output", file),
            );
            if (!info.isFile() || info.isSymbolicLink())
              throw new Error(`Missing regular model output: ${file}`);
          }
          job.evaluation = JSON.parse(
            readFileSync(
              join(this.directory, job.id, "output/evaluation.json"),
              "utf8",
            ),
          );
          job.artifacts = [...artifacts];
          const state = join(
            this.directory,
            job.id,
            "output",
            "training-state.pt",
          );
          if (existsSync(state)) {
            const info = lstatSync(state);
            if (!info.isFile() || info.isSymbolicLink())
              throw new Error("Invalid training state artifact");
            job.artifacts.push("training-state.pt");
          }
          job.status = "completed";
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
    return job;
  }
  cancel(id: string) {
    const job = this.get(id);
    if (this.active?.job.id !== id || job.status !== "running")
      throw new Error("Goal model is not training");
    job.status = "cancelled";
    this.save(job);
    this.active.child.kill("SIGKILL");
    return job;
  }
  rerun(id: string) {
    const job = this.get(id);
    return this.start({
      datasetId: job.datasetId,
      parameters: job.parameters,
      ...(job.parentId ? { parentId: job.parentId } : {}),
      ...(job.trainingMode && job.trainingMode !== "from_scratch"
        ? { trainingMode: job.trainingMode }
        : {}),
    });
  }
  artifact(id: string, file: string) {
    const job = this.get(id);
    if (
      job.status !== "completed" ||
      !job.artifacts.includes(file) ||
      !(artifacts.includes(file) || file === "training-state.pt")
    )
      throw new Error("Goal model artifact unavailable");
    const path = join(this.directory, id, "output", file);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Invalid goal model artifact");
    return path;
  }
  private rejectPending(error: Error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
  private inferenceWorker() {
    if (this.worker) return this.worker;
    const child = spawn(
      this.python,
      ["-u", join(this.root, "scripts/learning/phase1a.py"), "serve"],
      { cwd: this.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.worker = child;
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result as GoalPrediction);
      } catch {
        /* Ignore non-protocol library output */
      }
    });
    child.once("error", (error) => this.rejectPending(error));
    child.once("close", () => {
      if (this.worker === child) {
        this.worker = undefined;
        this.rejectPending(
          new Error(`Goal prediction worker stopped. ${stderr}`),
        );
      }
    });
    return child;
  }
  private async workerRequest(
    id: string,
    values: Record<string, unknown>,
  ): Promise<GoalPrediction> {
    if (this.closing) throw new Error("Control service is shutting down");
    for (const file of ["checkpoint.pt", "config.json", "teacher.py"])
      this.artifact(id, file);
    if (this.pending.size >= 16)
      throw new Error("Prediction queue is full. Retry shortly.");
    const worker = this.inferenceWorker();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Goal prediction timed out"));
        worker.kill("SIGKILL");
      }, 12000);
      this.pending.set(requestId, { resolve, reject, timer });
      worker.stdin!.write(
        JSON.stringify({
          id: requestId,
          model_dir: join(this.directory, id, "output"),
          ...values,
        }) + "\n",
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(requestId);
            reject(error);
          }
        },
      );
    });
  }
  predict(id: string, request: unknown): Promise<GoalPrediction> {
    const { example } = predictionSchema.parse(request);
    return this.workerRequest(id, { example });
  }
  async reload(id: string) {
    await this.workerRequest(id, { reload: true });
    return { id, loaded: true };
  }
  async close() {
    this.closing = true;
    if (this.active) {
      const { job, done } = this.active;
      if (job.status === "running") this.cancel(job.id);
      await done;
    }
    this.rejectPending(new Error("Control service shutting down"));
    if (this.worker) {
      const worker = this.worker;
      const done = new Promise<void>((resolve) =>
        worker.once("close", () => resolve()),
      );
      worker.kill("SIGKILL");
      await done;
    }
  }
}
