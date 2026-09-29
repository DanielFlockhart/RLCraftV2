import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inspectModuleTree,
  inspectModels,
  inspectComponent,
  validateInspection,
  type InspectableModule,
  PlaceholderPolicy,
  PlaceholderTrainer,
} from "@rlcraft/agents";
import { modelCodeVersion } from "../apps/control/src/models.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

class Layer implements InspectableModule {
  name = "dense";
  units = 4;
  inputShape = [null, 8];
  getClassName() {
    return "Dense";
  }
  getConfig() {
    return { units: this.units, activation: "relu" };
  }
  get outputShape() {
    return [null, this.units];
  }
  countParams() {
    return 8 * this.units + this.units;
  }
  get trainableWeights() {
    return [{ shape: [8, this.units] }, { shape: [this.units] }];
  }
}
class Network implements InspectableModule {
  name = "actual-network";
  layers: InspectableModule[] = [new Layer()];
  countParams() {
    return [...new Set(this.layers)].reduce(
      (sum, layer) => sum + (layer.countParams?.() ?? 0),
      0,
    );
  }
}
test("runtime module introspection follows architecture and optimizer changes without diagram metadata edits", async () => {
  const network = new Network(),
    optimizer = { learningRate: 0.001 };
  const policy = new PlaceholderPolicy();
  policy.inspectModel = () =>
    inspectModuleTree(network, optimizer, "test framework");
  const first = await inspectModels("movement", [
    { username: "agent-a", policy },
  ]);
  assert.equal(first[0].inspection.parameters, 36);
  assert.deepEqual(first[0].inspection.nodes[1].outputShape, [null, 4]);
  assert.equal(first[0].inspection.nodes[1].trainableParameters, 36);
  assert.equal(
    first[0].inspection.trainableParameters,
    undefined,
    "unknown root counts must remain unknown",
  );
  (network.layers[0] as Layer).units = 12;
  optimizer.learningRate = 0.0005;
  network.layers.push(new Layer());
  const second = await inspectModels("movement", [
    { username: "agent-a", policy },
  ]);
  assert.notEqual(first[0].fingerprint, second[0].fingerprint);
  assert.equal(second[0].inspection.nodes.length, 3);
  assert.equal(second[0].inspection.parameters, 144);
  assert.equal(second[0].inspection.nodes[1].config?.units, 12);
  assert.deepEqual(second[0].inspection.nodes[1].outputShape, [null, 12]);
  assert.equal(second[0].inspection.hyperparameters.learningRate, 0.0005);
  assert.equal(
    first[0].inspection.nodes[1].config?.units,
    4,
    "earlier snapshot is immutable",
  );
});
test("shared modules are represented once, and agents are grouped by actual metadata", async () => {
  const network = new Network();
  network.layers.push(network.layers[0]);
  const graph = inspectModuleTree(network);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges[1].label, "shared module");
  assert.equal(graph.parameters, 36);
  const variants = await inspectModels(
    "pvp",
    [
      { username: "one", policy: new PlaceholderPolicy() },
      { username: "two", policy: new PlaceholderPolicy() },
    ],
    new PlaceholderTrainer(),
  );
  assert.equal(variants.length, 2);
  assert.deepEqual(variants[0].agents, ["one", "two"]);
  assert.equal(variants[1].role, "trainer");
});
test("invalid, absent and inherited placeholder inspectors cannot present a guessed model", async () => {
  const policy = new PlaceholderPolicy();
  const inspection = policy.inspectModel();
  assert.throws(
    () =>
      validateInspection({
        ...inspection,
        edges: [{ from: "missing", to: "policy" }],
      }),
    /absent/,
  );
  assert.throws(
    () => validateInspection({ ...inspection, parameters: -1 }),
    /parameter count/,
  );
  assert.throws(
    () => validateInspection({ ...inspection, reason: "世".repeat(50000) }),
    /128 KiB/,
  );
  assert.throws(
    () =>
      validateInspection({
        ...inspection,
        nodes: [...inspection.nodes, inspection.nodes[0]],
      }),
    /module/,
  );
  assert.throws(
    () => inspectModuleTree({ getConfig: () => new Map() }),
    /plain JSON/,
  );
  class ActualPolicy extends PlaceholderPolicy {}
  assert.equal(
    (await inspectComponent(new ActualPolicy())).status,
    "unavailable",
  );
  const absent = { act: policy.act, reset: policy.reset, close: policy.close };
  assert.equal((await inspectComponent(absent)).status, "unavailable");
  policy.inspectModel = () => {
    throw null;
  };
  assert.equal((await inspectComponent(policy)).status, "unavailable");
});
test("metadata omits credential fields but preserves model token settings, and deadlines report unavailable", async () => {
  const inspected = inspectModuleTree(new Network(), {
    learningRate: 0.01,
    api_key: "secret",
    accessToken: "secret",
    max_tokens: 2048,
    nested: { password: "secret", activation: "relu" },
  });
  assert.deepEqual(inspected.hyperparameters, {
    learningRate: 0.01,
    max_tokens: 2048,
    nested: { activation: "relu" },
  });
  const policy = new PlaceholderPolicy();
  const slow = {
    ...policy,
    act: policy.act,
    reset: policy.reset,
    close: policy.close,
    inspectModel: () => new Promise<never>(() => {}),
  };
  const result = await inspectComponent(slow);
  assert.equal(result.status, "unavailable");
  assert.match(result.reason!, /one second/);
  const retry = await inspectComponent(slow);
  assert.equal(retry.status, "unavailable");
  assert.match(retry.reason!, /still running/);
});
test("source fingerprints detect same-size edits and ignore generated dependency folders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rlcraft-model-version-"));
  try {
    await mkdir(join(directory, "packages", "agents", "src"), {
      recursive: true,
    });
    const source = join(directory, "packages", "agents", "src", "model.ts");
    await writeFile(source, "size=12");
    const first = await modelCodeVersion(directory);
    await writeFile(source, "size=24");
    const second = await modelCodeVersion(directory);
    assert.notEqual(second, first);
    await mkdir(join(directory, "packages", "agents", "node_modules"), {
      recursive: true,
    });
    await writeFile(
      join(directory, "packages", "agents", "node_modules", "generated.json"),
      "{}",
    );
    assert.equal(await modelCodeVersion(directory), second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
