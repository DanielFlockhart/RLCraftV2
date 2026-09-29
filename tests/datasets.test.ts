import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatasetManager } from "../apps/control/src/datasets.js";
import type { DatasetJob } from "@rlcraft/core";
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
        () => manager.artifact(first.id, "train.csv"),
        /unavailable/,
      );
      await finished(first);
      assert.equal(first.status, "completed", first.error);
      assert.equal(first.artifacts.length, 5);
      const original = await readFile(
        manager.artifact(first.id, "train.csv"),
        "utf8",
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
          await readFile(manager.artifact(expanded.id, "train.csv"), "utf8")
        ).startsWith(original),
      );
      const rerun = manager.rerun(first.id);
      await finished(rerun);
      assert.equal(rerun.status, "completed", rerun.error);
      assert.notEqual(rerun.id, first.id);
      assert.equal(
        await readFile(manager.artifact(rerun.id, "train.csv"), "utf8"),
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
