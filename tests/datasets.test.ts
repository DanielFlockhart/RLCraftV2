import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatasetManager } from "../apps/control/src/datasets.js";
import type { DatasetJob } from "@mlcraft/core";
const root = fileURLToPath(new URL("../", import.meta.url));
const python =
  process.env.PYTHON_PATH ??
  (process.platform === "win32" ? "python" : "python3");
const hasPython = spawnSync(python, ["--version"]).status === 0;
const parameters = {
  trainSize: 40,
  validationSize: 12,
  testSize: 10,
  oodSize: 8,
};
async function finished(job: DatasetJob) {
  const deadline = Date.now() + 15000;
  while (job.status === "running" && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(job.status, "running", "generator must terminate");
  return job;
}
test(
  "generator data properties and CLI validation",
  { skip: !hasPython },
  () => {
    const result = spawnSync(python, [join(root, "tests/datasets_test.py")], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);
test(
  "dataset jobs preserve versions, expand, rerun and recover history",
  { skip: !hasPython },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "rlcraft-datasets-"));
    const manager = new DatasetManager(dir, root, python);
    try {
      assert.throws(
        () => manager.start({ generatorId: "../../evil" }),
        /Unknown/,
      );
      assert.throws(() =>
        manager.start({ generatorId: "phase1a", parameters: { command: 1 } }),
      );
      assert.throws(
        () =>
          manager.start({
            generatorId: "phase1a",
            parameters: {
              trainSize: 0,
              validationSize: 0,
              testSize: 0,
              oodSize: 0,
            },
          }),
        /total new rows/,
      );
      assert.throws(
        () =>
          manager.start({
            generatorId: "phase1a",
            parameters: { trainSize: 2000000 },
          }),
        /total new rows/,
      );
      const first = manager.start({ generatorId: "phase1a", parameters });
      assert.throws(
        () => manager.start({ generatorId: "phase1a", parameters }),
        /already running/,
      );
      assert.throws(
        () => manager.artifact(first.id, "train.jsonl"),
        /unavailable/,
      );
      await finished(first);
      assert.equal(first.status, "completed", first.error);
      assert.equal(first.artifacts.length, 5);
      const original = await readFile(
        manager.artifact(first.id, "train.jsonl"),
        "utf8",
      );
      const preview = await manager.examples(first.id, {
        split: "train",
        offset: 5,
        limit: 3,
      });
      assert.equal(preview.total, 40);
      assert.equal(preview.coverage?.covered_cases, 40);
      assert.equal(preview.coverage?.complete, false);
      assert.deepEqual(
        preview.examples.map((row) => row.data),
        original
          .trim()
          .split("\n")
          .slice(5, 8)
          .map((line) => JSON.parse(line)),
      );
      assert.equal(preview.examples[0].index, 5);
      await assert.rejects(manager.examples(first.id, { split: "../../job" }));
      await assert.rejects(manager.examples(first.id, { limit: 51 }));
      assert.deepEqual(
        (await manager.examples(first.id, { offset: 40 })).examples,
        [],
      );
      assert.throws(
        () => manager.artifact(first.id, "../../job.json"),
        /unavailable/,
      );
      assert.throws(
        () =>
          manager.start({
            generatorId: "phase1a",
            parameters: { ...parameters, temperature: 2 },
            parentId: first.id,
          }),
        /temperature/,
      );
      const expanded = manager.start({
        generatorId: "phase1a",
        parameters: { ...parameters, seed: 43 },
        parentId: first.id,
      });
      await finished(expanded);
      assert.equal(expanded.status, "completed", expanded.error);
      const metadata = JSON.parse(
        await readFile(manager.artifact(expanded.id, "metadata.json"), "utf8"),
      );
      assert.deepEqual(metadata.split_sizes, {
        train: 80,
        validation: 24,
        test: 20,
        ood_test: 16,
      });
      assert.ok(
        (
          await readFile(manager.artifact(expanded.id, "train.jsonl"), "utf8")
        ).startsWith(original),
      );
      const rerun = manager.rerun(first.id);
      await finished(rerun);
      assert.equal(rerun.status, "completed", rerun.error);
      assert.notEqual(rerun.id, first.id);
      assert.equal(
        await readFile(manager.artifact(rerun.id, "train.jsonl"), "utf8"),
        original,
      );
      await manager.close();
      const recovered = new DatasetManager(dir, root, python);
      assert.equal(recovered.snapshot().jobs.length, 3);
      assert.equal(recovered.get(first.id).status, "completed");
      await recovered.close();
    } finally {
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "cancellation terminates workers and incomplete restart records fail",
  { skip: !hasPython },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "rlcraft-dataset-cancel-"));
    const manager = new DatasetManager(dir, root, python);
    try {
      const job = manager.start({
        generatorId: "phase1a",
        parameters: { trainSize: 1000000 },
      });
      manager.cancel(job.id);
      await manager.close();
      assert.equal(job.status, "cancelled");
      assert.ok(job.finishedAt);
      assert.deepEqual(job.artifacts, []);
      job.status = "running";
      await writeFile(join(dir, job.id, "job.json"), JSON.stringify(job));
      const recovered = new DatasetManager(dir, root, python);
      assert.equal(recovered.get(job.id).status, "failed");
      assert.match(recovered.get(job.id).error!, /stopped/);
      await recovered.close();
    } finally {
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test("missing Python reports actionable failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rlcraft-dataset-no-python-"));
  const manager = new DatasetManager(
    dir,
    root,
    join(dir, "missing-python.exe"),
  );
  try {
    const job = manager.start({ generatorId: "phase1a", parameters });
    await finished(job);
    assert.equal(job.status, "failed");
    assert.match(job.error!, /PYTHON_PATH/);
    assert.deepEqual(job.artifacts, []);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "indexed previews cross block boundaries and handle empty splits",
  { skip: !hasPython },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "rlcraft-dataset-preview-"));
    const manager = new DatasetManager(dir, root, python);
    try {
      const job = manager.start({
        generatorId: "phase1a",
        parameters: { ...parameters, trainSize: 520, validationSize: 0 },
      });
      await finished(job);
      assert.equal(job.status, "completed", job.error);
      const lines = (
        await readFile(manager.artifact(job.id, "train.jsonl"), "utf8")
      )
        .trim()
        .split("\n");
      for (const offset of [255, 256, 510, 512, 519]) {
        const preview = await manager.examples(job.id, { offset, limit: 3 });
        assert.deepEqual(
          preview.examples.map((entry) => entry.data),
          lines.slice(offset, offset + 3).map((line) => JSON.parse(line)),
        );
      }
      const empty = await manager.examples(job.id, { split: "validation" });
      assert.equal(empty.total, 0);
      assert.deepEqual(empty.examples, []);
    } finally {
      await manager.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("legacy CSV jobs remain downloadable and cannot mix with the slot schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rlcraft-dataset-legacy-"));
  const id = randomUUID();
  await mkdir(join(dir, id, "output"), { recursive: true });
  const old: DatasetJob = {
    id,
    generatorId: "phase1a",
    generatorVersion: "1.0.0",
    sourceHash: "legacy",
    parameters: {},
    status: "completed",
    createdAt: 1,
    logs: [],
    artifacts: ["train.csv"],
  };
  await writeFile(join(dir, id, "job.json"), JSON.stringify(old));
  await writeFile(join(dir, id, "output", "train.csv"), "logs,planks\n4,8\n");
  const manager = new DatasetManager(dir, root, python);
  try {
    assert.equal(
      await readFile(manager.artifact(id, "train.csv"), "utf8"),
      "logs,planks\n4,8\n",
    );
    await assert.rejects(manager.examples(id, {}), /older aggregate format/);
    assert.throws(
      () => manager.start({ generatorId: "phase1a", parentId: id, parameters }),
      /Generator code changed/,
    );
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});
