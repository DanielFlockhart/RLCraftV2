import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type {
  BackendDescriptor,
  BackendSnapshot,
  Environment,
  RunSpec,
} from "@rlcraft/core";
import { inputCatalog } from "@rlcraft/core";
import type { BackendContext, BackendAdapter } from "./contract.js";
import { selectedEnvironment } from "./selected.js";

export const backendIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const channelIds = new Set(inputCatalog.channels.map((entry) => entry.id));
export const backendDescriptorSchema = z
  .object({
    id: backendIdSchema,
    label: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
    version: z.string().min(1).max(100),
    mode: z.enum(["minecraft", "simulator"]),
    minecraftVersions: z.array(z.string().min(1).max(40)).min(1).max(128),
    inputSupport: z.record(
      z.string().refine((id) => channelIds.has(id), "Unknown input channel"),
      z.enum(["native", "approximate", "external", "unsupported"]),
    ),
    actions: z.array(z.enum(["controls", "look", "dig"])).max(3),
    lifecycle: z
      .object({
        reset: z.boolean(),
        respawn: z.boolean(),
        teleport: z.boolean(),
        capture: z.boolean(),
      })
      .strict(),
    limitations: z.array(z.string().max(2000)).max(30),
  })
  .strict();
const stdioSchema = z
  .object({
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(8192)).max(128).default([]),
    cwd: z.string().min(1).max(4096).default("."),
    env: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().max(32768),
      )
      .optional(),
    requestTimeoutMs: z.number().int().min(100).max(30000).default(5000),
    maxMessageBytes: z.number().int().min(1024).max(16777216).default(4194304),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    backends: z
      .array(
        z.union([
          z
            .object({
              descriptor: backendDescriptorSchema,
              module: z.string().min(1).max(4096),
            })
            .strict(),
          z
            .object({ descriptor: backendDescriptorSchema, stdio: stdioSchema })
            .strict(),
        ]),
      )
      .max(32),
  })
  .strict();
type Definition = z.infer<typeof manifestSchema>["backends"][number];
interface Entry extends BackendSnapshot {
  definition?: Definition;
  create?: BackendAdapter["createEnvironment"];
}
const revision = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const allInputs = (fallback: BackendDescriptor["inputSupport"][string]) =>
  Object.fromEntries(
    inputCatalog.channels.map((entry) => [entry.id, fallback]),
  );

export class BackendRegistry {
  private entries = new Map<string, Entry>();
  constructor(readonly defaultMinecraft = "mineflayer") {}
  register(
    descriptor: BackendDescriptor,
    create: BackendAdapter["createEnvironment"],
    identity: unknown = descriptor,
  ) {
    this.add({
      descriptor: backendDescriptorSchema.parse(descriptor),
      revision: revision(identity),
      create,
    });
  }
  private add(entry: Entry) {
    if (this.entries.has(entry.descriptor.id))
      throw new Error(`Duplicate backend ID: ${entry.descriptor.id}`);
    this.entries.set(entry.descriptor.id, entry);
  }
  list(): BackendSnapshot[] {
    return [...this.entries.values()].map(({ descriptor, revision }) =>
      structuredClone({ descriptor, revision }),
    );
  }
  select(spec: RunSpec, minecraftVersion: string): BackendSnapshot {
    const id =
      spec.backend ??
      (spec.mode === "simulator" ? "simulator" : this.defaultMinecraft);
    const entry = this.entries.get(id);
    if (!entry)
      throw new Error(
        `Backend '${id}' is not registered. Configure AGENT_BACKENDS_FILE and restart control.`,
      );
    const descriptor = entry.descriptor;
    if (descriptor.mode !== spec.mode)
      throw new Error(`Backend '${id}' does not support ${spec.mode} mode`);
    if (
      spec.mode === "minecraft" &&
      !descriptor.minecraftVersions.some(
        (version) => version === "*" || version === minecraftVersion,
      )
    )
      throw new Error(
        `Backend '${id}' does not declare support for Minecraft ${minecraftVersion}`,
      );
    if (
      spec.mode === "minecraft" &&
      (!descriptor.lifecycle.reset || !descriptor.lifecycle.respawn)
    )
      throw new Error(
        `Backend '${id}' must support managed resets and respawning`,
      );
    if (spec.setup && !descriptor.lifecycle.reset)
      throw new Error(`Backend '${id}' does not support starting setup`);
    if (spec.arena && !descriptor.lifecycle.teleport)
      throw new Error(`Backend '${id}' does not support arena placement`);
    return structuredClone({ descriptor, revision: entry.revision });
  }
  async create(
    snapshot: BackendSnapshot,
    context: BackendContext,
  ): Promise<Environment> {
    const entry = this.entries.get(snapshot.descriptor.id);
    if (!entry || entry.revision !== snapshot.revision)
      throw new Error(
        "Backend configuration changed after this run was queued; create a new run with the current backend",
      );
    let environment: Environment;
    if (entry.create) environment = await entry.create(context);
    else if (entry.definition && "stdio" in entry.definition) {
      const { StdioEnvironment } = await import("./stdio.js");
      environment = new StdioEnvironment(context, entry.definition.stdio);
    } else if (entry.definition && "module" in entry.definition) {
      const adapter = (await import(
        pathToFileURL(entry.definition.module).href
      )) as Partial<BackendAdapter>;
      if (typeof adapter.createEnvironment !== "function")
        throw new Error(
          "Backend module must export createEnvironment(context)",
        );
      environment = await adapter.createEnvironment(context);
    } else throw new Error("Backend factory is unavailable");
    const methods = [
      "connect",
      "observe",
      "apply",
      "close",
      ...Object.entries(snapshot.descriptor.lifecycle)
        .filter(([, enabled]) => enabled)
        .map(([method]) => method),
    ];
    if (
      methods.some(
        (method) => typeof (environment as any)?.[method] !== "function",
      )
    ) {
      await environment?.close?.();
      throw new Error(
        "Backend factory does not implement its declared lifecycle capabilities",
      );
    }
    return selectedEnvironment(
      environment,
      context.inputs,
      snapshot.descriptor,
    );
  }
  async loadManifest(path: string) {
    const file = resolve(path);
    const raw = await readFile(file);
    if (raw.length > 1048576) throw new Error("Backend manifest exceeds 1 MiB");
    const manifest = manifestSchema.parse(JSON.parse(raw.toString("utf8")));
    for (const definition of manifest.backends) {
      const configured = structuredClone(definition);
      let moduleSource: string | undefined;
      if ("module" in definition) {
        definition.module = resolve(dirname(file), definition.module);
        moduleSource = createHash("sha256")
          .update(await readFile(definition.module))
          .digest("hex");
      } else {
        definition.stdio.cwd = resolve(dirname(file), definition.stdio.cwd);
        // Bare command names use PATH. Relative executable paths resolve against the profile cwd.
        if (/[\\/]/.test(definition.stdio.command))
          definition.stdio.command = resolve(
            definition.stdio.cwd,
            definition.stdio.command,
          );
      }
      this.add({
        descriptor: definition.descriptor,
        revision: revision({ definition: configured, moduleSource }),
        definition,
      });
    }
  }
}

export async function loadBackendRegistry(
  manifestPath?: string,
  defaultMinecraft = "mineflayer",
) {
  const registry = new BackendRegistry(defaultMinecraft);
  const require = createRequire(import.meta.url);
  const mineflayerVersion = require("mineflayer/package.json")
    .version as string;
  const descriptor: BackendDescriptor = {
    id: "mineflayer",
    label: "Mineflayer",
    description:
      "Lightweight Java protocol client for the shared training server.",
    version: mineflayerVersion,
    mode: "minecraft",
    minecraftVersions: ["*"],
    inputSupport: {
      ...allInputs("native"),
      "vision.geometry": "approximate",
      "entities.visible": "approximate",
      "vision.rgb": "external",
      "audio.pcm": "approximate",
      "audio.capture": "external",
    },
    actions: ["controls", "look", "dig"],
    lifecycle: { reset: true, respawn: true, teleport: true, capture: true },
    limitations: [
      "Version compatibility is checked by the installed Mineflayer library at connection time.",
      "No vanilla renderer or full client audio mixer. RGB and exact mixed audio require a producer attached to the same player session.",
      "Packet/world cache inputs can include occluded client-received data; disable these for visual-only experiments.",
    ],
  };
  const source = await readFile(
    fileURLToPath(new URL("./mineflayer.ts", import.meta.url)),
    "utf8",
  );
  registry.register(
    descriptor,
    async (context) => {
      const { MinecraftEnvironment } = await import("./mineflayer.js");
      return new MinecraftEnvironment(
        context.username,
        context.connection,
        context.managed.applySetup,
        context.managed.moveToArena,
        context.inputs,
        context.assetDirectory,
      );
    },
    {
      descriptor,
      source,
      progression: await readFile(
        fileURLToPath(new URL("../progression.ts", import.meta.url)),
        "utf8",
      ),
      catalog: await readFile(
        fileURLToPath(
          new URL(
            "../../../core/src/progression-catalog.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    },
  );
  const { fabricSourceHash } = await import("../../../runtime/src/fabric.js");
  const fabric: BackendDescriptor = {
    id: "fabric",
    label: "Minecraft client · Fabric RGB",
    version: "0.1.0",
    description:
      "Managed Minecraft 1.18.1 client with real first-person framebuffer capture and ordinary player controls.",
    mode: "minecraft",
    minecraftVersions: ["1.18.1"],
    inputSupport: {
      ...allInputs("unsupported"),
      ...Object.fromEntries(
        [
          "vision.rgb",
          "self.identity",
          "self.pose",
          "self.vitals",
          "self.inventory",
          "self.controls",
          "self.experience",
          "world.game",
        ].map((id) => [id, "native" as const]),
      ),
    },
    actions: ["controls", "look", "dig"],
    lifecycle: { reset: true, respawn: true, teleport: true, capture: false },
    limitations: [
      "Requires prepared client assets and a working OpenGL display; cloud Linux needs a display server and graphics drivers.",
      "Currently supports trusted offline-authenticated Minecraft 1.18.1 training servers on x64 Windows/Linux/macOS.",
      "Channels not listed as native remain explicitly unavailable. Exact client audio and all higher-level sensor channels are not implemented in this adapter yet.",
      "One Java game client per rendered agent; a separate bounded renderer capacity prevents oversubscription. RGB and viewer feed use the same real player camera.",
      "Movement, look and digging are implemented; expanded crafting/combat action APIs remain AI extension work.",
    ],
  };
  registry.register(
    fabric,
    async (context) => {
      const { FabricEnvironment } = await import("./fabric.js");
      return new FabricEnvironment(context);
    },
    {
      fabric,
      source: await readFile(
        fileURLToPath(new URL("./fabric.ts", import.meta.url)),
        "utf8",
      ),
      clientSource: await fabricSourceHash(),
    },
  );
  const simulator: BackendDescriptor = {
    id: "simulator",
    label: "Infrastructure simulator",
    description:
      "Small deterministic state simulator for checking the control pipeline; does not run Minecraft.",
    version: "1",
    mode: "simulator",
    minecraftVersions: ["*"],
    inputSupport: {
      ...allInputs("unsupported"),
      "self.pose": "native",
      "self.vitals": "native",
      "self.inventory": "native",
      "self.controls": "native",
    },
    actions: ["controls"],
    lifecycle: { reset: true, respawn: false, teleport: false, capture: false },
    limitations: [
      "Only forward/back movement and small simulated state are implemented. No Minecraft physics, media or events.",
    ],
  };
  registry.register(
    simulator,
    async (context) => {
      const { SimulatorEnvironment } = await import("./simulator.js");
      return new SimulatorEnvironment(context.inputs);
    },
    {
      simulator,
      source: await readFile(
        fileURLToPath(new URL("./simulator.ts", import.meta.url)),
        "utf8",
      ),
    },
  );
  if (manifestPath) await registry.loadManifest(manifestPath);
  return registry;
}
