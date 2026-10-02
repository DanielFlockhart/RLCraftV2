import { createHash } from "node:crypto";
import type {
  ModelInspection,
  ModelValue,
  ModelSnapshot,
  Policy,
  Trainer,
  StageId,
} from "@mlcraft/core";

// An adapter reads these methods from the actual framework object, without copying weights.
export interface InspectableModule {
  name?: string;
  getClassName?(): string;
  getConfig?(): unknown;
  countParams?(): number;
  inputShape?: unknown;
  outputShape?: unknown;
  trainableWeights?: readonly { shape: readonly number[] }[];
  layers?: readonly InspectableModule[];
}
const pendingInspections = new WeakSet<Policy | Trainer>();
function jsonValue(value: unknown, depth = 0): ModelValue {
  if (depth > 8) throw new Error("Model metadata nesting exceeds eight levels");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 1024)
      throw new Error("Model metadata array is too large");
    return value.map((item) => jsonValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error("Model metadata objects must be plain JSON records");
    const credential =
      /^(secret|password|token|credential|credentials|authorization|apikey|accesstoken|refreshtoken|authtoken|clientsecret|privatekey)$/i;
    const entries = Object.entries(value).filter(
      ([key, value]) =>
        !credential.test(key.replace(/[_-]/g, "")) && value !== undefined,
    );
    if (entries.length > 256)
      throw new Error("Too many model configuration fields");
    return Object.fromEntries(
      entries.map(([key, value]) => [key, jsonValue(value, depth + 1)]),
    );
  }
  throw new Error("Model metadata must contain JSON values");
}
export function inspectModuleTree(
  model: InspectableModule,
  hyperparameters: unknown = {},
  framework = "runtime modules",
): ModelInspection {
  const nodes: ModelInspection["nodes"] = [],
    edges: ModelInspection["edges"] = [];
  const seen = new Map<InspectableModule, string>();
  const walk = (module: InspectableModule, parent?: string) => {
    const existing = seen.get(module);
    if (existing) {
      if (parent)
        edges.push({ from: parent, to: existing, label: "shared module" });
      return;
    }
    if (nodes.length >= 512) throw new Error("Model has more than 512 modules");
    const id = `module-${nodes.length}`;
    seen.set(module, id);
    const config = jsonValue(module.getConfig?.() ?? {}) as Record<
      string,
      ModelValue
    >;
    const count = module.countParams?.();
    const trainable = module.trainableWeights?.reduce(
      (total, weight) =>
        total + weight.shape.reduce((size, dimension) => size * dimension, 1),
      0,
    );
    nodes.push({
      id,
      label: module.name ?? module.getClassName?.() ?? module.constructor.name,
      kind: module.getClassName?.() ?? module.constructor.name,
      config,
      ...(count !== undefined ? { parameters: count } : {}),
      ...(trainable !== undefined ? { trainableParameters: trainable } : {}),
      ...(module.inputShape !== undefined
        ? { inputShape: jsonValue(module.inputShape) }
        : {}),
      ...(module.outputShape !== undefined
        ? { outputShape: jsonValue(module.outputShape) }
        : {}),
    });
    if (parent) edges.push({ from: parent, to: id, label: "contains" });
    for (const child of module.layers ?? []) walk(child, id);
  };
  walk(model);
  return validateInspection({
    implementation: model.constructor.name,
    framework,
    status: "ready",
    nodes,
    edges,
    hyperparameters: jsonValue(hyperparameters) as Record<string, ModelValue>,
    ...(nodes[0].parameters !== undefined
      ? { parameters: nodes[0].parameters }
      : {}),
    ...(nodes[0].trainableParameters !== undefined
      ? { trainableParameters: nodes[0].trainableParameters }
      : {}),
  });
}
export function validateInspection(value: ModelInspection): ModelInspection {
  const parsed = jsonValue(value) as unknown as ModelInspection;
  if (Buffer.byteLength(JSON.stringify(parsed)) > 131072)
    throw new Error("Model inspection exceeds 128 KiB");
  if (
    !["ready", "placeholder", "unavailable"].includes(parsed.status) ||
    typeof parsed.implementation !== "string" ||
    typeof parsed.framework !== "string" ||
    !Array.isArray(parsed.nodes) ||
    !Array.isArray(parsed.edges) ||
    parsed.nodes.length > 512 ||
    parsed.edges.length > 1024 ||
    !parsed.hyperparameters ||
    Array.isArray(parsed.hyperparameters) ||
    typeof parsed.hyperparameters !== "object"
  )
    throw new Error("Invalid model inspection");
  const ids = new Set<string>();
  const validCount = (count?: number) =>
    count === undefined || (Number.isSafeInteger(count) && count >= 0);
  if (parsed.reason !== undefined && typeof parsed.reason !== "string")
    throw new Error("Invalid inspection reason");
  for (const node of parsed.nodes) {
    if (
      typeof node.id !== "string" ||
      ids.has(node.id) ||
      typeof node.label !== "string" ||
      typeof node.kind !== "string" ||
      !validCount(node.parameters) ||
      !validCount(node.trainableParameters)
    )
      throw new Error("Invalid model module");
    ids.add(node.id);
    if (
      node.config !== undefined &&
      (!node.config ||
        typeof node.config !== "object" ||
        Array.isArray(node.config))
    )
      throw new Error("Invalid module configuration");
  }
  for (const edge of parsed.edges)
    if (
      !ids.has(edge.from) ||
      !ids.has(edge.to) ||
      (edge.label !== undefined && typeof edge.label !== "string")
    )
      throw new Error(
        "Model edge refers to an absent module or has an invalid label",
      );
  if (!validCount(parsed.parameters) || !validCount(parsed.trainableParameters))
    throw new Error("Invalid parameter count");
  return parsed;
}
export async function inspectComponent(
  component: Policy | Trainer,
): Promise<ModelInspection> {
  const implementation = component.constructor?.name ?? "Unknown component";
  try {
    if (!component.inspectModel)
      throw new Error(
        "This implementation exposes no runtime model inspector. Connect its actual model and optimizer to inspectModel().",
      );
    if (pendingInspections.has(component))
      throw new Error(
        "Previous model inspection is still running; no overlapping inspection was started.",
      );
    pendingInspections.add(component);
    const operation = Promise.resolve()
      .then(() => component.inspectModel!())
      .then(validateInspection);
    // A timed-out asynchronous hook may still be in flight. Never accumulate new
    // requests for that component, and never publish its late result as a fresh sample.
    void operation.then(
      () => pendingInspections.delete(component),
      () => pendingInspections.delete(component),
    );
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Model inspection exceeded one second")),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  } catch (error) {
    return {
      implementation,
      framework: "unknown",
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
      nodes: [],
      edges: [],
      hyperparameters: {},
    };
  }
}
export async function inspectModels(
  stage: StageId,
  policies: { username: string; policy: Policy }[],
  trainer?: Trainer,
): Promise<ModelSnapshot["variants"]> {
  const variants: ModelSnapshot["variants"] = [];
  const add = (
    role: "policy" | "trainer",
    inspection: ModelInspection,
    username?: string,
  ) => {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(inspection))
      .digest("hex");
    const shared = variants.find(
      (variant) => variant.role === role && variant.fingerprint === fingerprint,
    );
    if (shared && username) shared.agents.push(username);
    else
      variants.push({
        role,
        inspection,
        fingerprint,
        agents: username ? [username] : [],
      });
  };
  const sharedInspections = new Map<Policy, Promise<ModelInspection>>();
  const inspected = await Promise.all(
    policies.map((member) => {
      let pending = sharedInspections.get(member.policy);
      if (!pending) {
        pending = inspectComponent(member.policy);
        sharedInspections.set(member.policy, pending);
      }
      return pending;
    }),
  );
  for (let i = 0; i < policies.length; i++)
    add("policy", inspected[i], policies[i].username);
  if (trainer) add("trainer", await inspectComponent(trainer));
  return variants;
}
