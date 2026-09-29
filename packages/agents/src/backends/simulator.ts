import type {
  Action,
  Environment,
  Observation,
  AgentSetup,
  ArenaPoint,
  AgentInputConfig,
  CaptureFrame,
} from "@rlcraft/core";
import { defaultInputs, inputCatalog } from "@rlcraft/core";
import { inputJson, projectFields } from "../inputs/serialize.js";
export class SimulatorEnvironment implements Environment {
  constructor(
    private inputs: AgentInputConfig = structuredClone(defaultInputs),
  ) {}
  private position = { x: 0, y: 64, z: 0 };
  private inventory: Record<string, number> = {};
  private health = 20;
  private food = 20;
  async connect() {}
  observe(tick: number): Observation {
    return {
      position: { ...this.position },
      health: this.health,
      food: this.food,
      inventory: { ...this.inventory },
      tick,
      inputs: {
        schemaVersion: 1,
        at: Date.now(),
        tick,
        sequence: tick,
        channels: Object.fromEntries(
          inputCatalog.channels
            .filter((c) => this.inputs.channels[c.id]?.enabled)
            .map((c) => [
              c.id,
              [
                "self.pose",
                "self.vitals",
                "self.inventory",
                "self.controls",
              ].includes(c.id)
                ? {
                    status: "ready",
                    sampledAt: Date.now(),
                    source: "simulator",
                    data: projectFields(
                      inputJson(
                        c.id === "self.pose"
                          ? { position: { ...this.position } }
                          : c.id === "self.vitals"
                            ? {
                                health: this.health,
                                food: this.food,
                                alive: this.health > 0,
                              }
                            : c.id === "self.inventory"
                              ? {
                                  slots: Array.from(
                                    { length: 46 },
                                    (_, slot) => ({
                                      slot,
                                      item:
                                        [...this.slots].find(
                                          ([configured]) =>
                                            (configured <= 8
                                              ? configured + 36
                                              : configured <= 35
                                                ? configured
                                                : configured <= 39
                                                  ? 44 - configured
                                                  : 45) === slot,
                                        )?.[1] ?? null,
                                    }),
                                  ),
                                }
                              : {},
                      ),
                      this.inputs.channels[c.id].fields,
                    ),
                  }
                : {
                    status: "unavailable",
                    sampledAt: Date.now(),
                    source: "simulator",
                    reason:
                      "Minecraft client data is not available in simulator mode",
                  },
            ]),
        ),
        diagnostics: { droppedEvents: 0, droppedBytes: 0, eventBytes: 0 },
      },
    };
  }
  async apply(action: Action) {
    if (action.controls?.forward) this.position.z += 0.1;
    if (action.controls?.back) this.position.z -= 0.1;
  }
  async close() {}
  async reset(setup: AgentSetup) {
    // Slot bookkeeping matters when preserving unspecified slots between episodes.
    if (setup.clearInventory) this.slots.clear();
    for (const item of setup.items)
      this.slots.set(item.slot, {
        name: item.item.replace(/^minecraft:/, ""),
        count: item.count,
      });
    this.inventory = {};
    for (const item of this.slots.values())
      this.inventory[item.name] = (this.inventory[item.name] ?? 0) + item.count;
    if (setup.resetVitals) {
      this.health = setup.health;
      this.food = setup.food;
    }
    if (setup.spawn) this.position = { ...setup.spawn };
  }
  private slots = new Map<number, { name: string; count: number }>();
}
