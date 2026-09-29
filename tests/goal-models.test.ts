import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatasetManager } from "../apps/control/src/datasets.js";
import { GoalModelManager } from "../apps/control/src/goal-models.js";
import type { DatasetJob, GoalModelJob } from "@rlcraft/core";

const root = fileURLToPath(new URL("../", import.meta.url));
const python =
  process.env.PYTHON_PATH ??
  (process.platform === "win32" ? "python" : "python3");
const hasTorch = spawnSync(python, ["-c", "import torch, numpy"]).status === 0;
async function finished(job: DatasetJob | GoalModelJob) {
  const deadline = Date.now() + 60000;
  while (job.status === "running" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 30));
  assert.notEqual(job.status, "running", "job must terminate");
}
test(
  "Phase 1A training improves, excludes label leakage and reloads invariant predictions",
  { skip: !hasTorch },
  () => {
    const result = spawnSync(
      python,
      [join(root, "tests/goal_models_test.py")],
      { encoding: "utf8", timeout: 120000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  },
);
test(
  "goal models persist training, predict with a reusable worker and enforce lifecycle boundaries",
  { skip: !hasTorch },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rlcraft-goal-models-"));
    const datasets = new DatasetManager(
      join(directory, "datasets"),
      root,
      python,
    );
    let models = new GoalModelManager(
      join(directory, "models"),
      root,
      python,
      datasets,
    );
    try {
      const dataset = datasets.start({
        generatorId: "phase1a",
        parameters: {
          trainSize: 1100,
          validationSize: 100,
          testSize: 30,
          oodSize: 31,
        },
      });
      assert.throws(() => models.start({ datasetId: dataset.id }), /completed/);
      await finished(dataset);
      assert.equal(dataset.status, "completed", dataset.error);
      assert.throws(() =>
        models.start({ datasetId: dataset.id, parameters: { epochs: 0 } }),
      );
      assert.throws(() =>
        models.start({ datasetId: dataset.id, parameters: { script: "evil" } }),
      );
      const model = models.start({
        datasetId: dataset.id,
        parameters: { epochs: 2, threads: 1 },
      });
      assert.throws(
        () => models.start({ datasetId: dataset.id }),
        /already training/,
      );
      assert.throws(
        () => models.artifact(model.id, "checkpoint.pt"),
        /unavailable/,
      );
      await finished(model);
      assert.equal(model.status, "completed", model.error);
      assert.equal(model.metrics.length, 2);
      assert.equal(model.evaluation?.splits.ood_test.rows, 31);
      assert.equal(model.artifacts.length, 7);
      const unrelated = datasets.start({
        generatorId: "phase1a",
        parameters: {
          trainSize: 40,
          validationSize: 12,
          testSize: 10,
          oodSize: 8,
        },
      });
      await finished(unrelated);
      assert.equal(unrelated.status, "completed", unrelated.error);
      assert.throws(
        () => models.start({ datasetId: unrelated.id, parentId: model.id }),
        /original dataset or an expansion/,
      );
      const preview = await datasets.examples(dataset.id, {
        split: "test",
        offset: 0,
        limit: 1,
      });
      const prediction = await models.predict(model.id, {
        example: preview.examples[0].data,
      });
      const repeated = await models.predict(model.id, {
        example: preview.examples[0].data,
      });
      assert.deepEqual(prediction.probabilities, repeated.probabilities);
      assert.equal(prediction.objective, "obtain_iron_pickaxe");
      assert.ok(
        prediction.ranked_goals.every(
          (goal) => prediction.valid_goals[goal.goal],
        ),
      );
      assert.deepEqual(await models.reload(model.id), {
        id: model.id,
        loaded: true,
      });
      assert.deepEqual(
        (await models.predict(model.id, { example: preview.examples[0].data }))
          .probabilities,
        prediction.probabilities,
      );
      assert.throws(
        () =>
          models.start({
            datasetId: dataset.id,
            parentId: model.id,
            parameters: { width: 64 },
          }),
        /architecture/,
      );
      const fine = models.start({
        datasetId: dataset.id,
        parentId: model.id,
        parameters: { epochs: 1, learningRate: 0.0001 },
      });
      await finished(fine);
      assert.equal(fine.status, "completed", fine.error);
      assert.equal(fine.parentId, model.id);
      const parentConfig = JSON.parse(
        await readFile(models.artifact(fine.id, "config.json"), "utf8"),
      );
      assert.equal(parentConfig.parent_model_id, model.id);
      assert.equal(parentConfig.training_mode, "fine_tune");
      assert.throws(
        () => models.start({ datasetId: dataset.id, trainingMode: "continue" }),
        /saved model/,
      );
      assert.throws(
        () =>
          models.start({
            datasetId: dataset.id,
            parentId: model.id,
            trainingMode: "continue",
            parameters: { learningRate: 0.0001 },
          }),
        /preserves learningRate/,
      );
      assert.throws(
        () =>
          models.start({
            datasetId: unrelated.id,
            parentId: model.id,
            trainingMode: "continue",
          }),
        /same dataset/,
      );
      const continued = models.start({
        datasetId: dataset.id,
        parentId: model.id,
        trainingMode: "continue",
        parameters: { epochs: 1 },
      });
      await finished(continued);
      assert.equal(continued.status, "completed", continued.error);
      assert.equal(continued.trainingMode, "continue");
      const continuedConfig = JSON.parse(
        await readFile(models.artifact(continued.id, "config.json"), "utf8"),
      );
      assert.equal(continuedConfig.optimizer_restored, true);
      assert.equal(
        continuedConfig.training.learning_rate,
        model.parameters.learningRate,
      );
      await assert.rejects(
        models.predict(model.id, {
          example: {
            inventory: { size: 41, selected_hotbar_slot: 0, slots: [] },
            context: {},
          },
        }),
        /Context/,
      );
      assert.throws(
        () => models.artifact(model.id, "../../job.json"),
        /unavailable/,
      );
      assert.throws(() => models.cancel(model.id), /not training/);
      assert.ok(
        (
          await readFile(models.artifact(model.id, "config.json"), "utf8")
        ).includes(dataset.id),
      );
      const cancelled = models.rerun(model.id);
      models.cancel(cancelled.id);
      await models.close();
      assert.equal(cancelled.status, "cancelled");
      const orphan = { ...model, id: randomUUID(), status: "running" };
      await mkdir(join(directory, "models", orphan.id));
      await writeFile(
        join(directory, "models", orphan.id, "job.json"),
        JSON.stringify(orphan),
      );
      models = new GoalModelManager(
        join(directory, "models"),
        root,
        python,
        datasets,
      );
      assert.equal(models.get(model.id).status, "completed");
      assert.equal(models.get(fine.id).parentId, model.id);
      assert.equal(models.get(orphan.id).status, "failed");
      const failureManager = new GoalModelManager(
        join(directory, "missing-python"),
        root,
        "rlcraft-python-does-not-exist",
        datasets,
      );
      const failed = failureManager.start({ datasetId: dataset.id });
      await finished(failed);
      assert.equal(failed.status, "failed");
      assert.match(failed.error!, /PYTHON_PATH/);
      await failureManager.close();
    } finally {
      await models.close();
      await datasets.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
