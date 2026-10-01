import type {
  AgentInputFrame,
  AgentState,
  GoalSelectionExample,
} from "@mlcraft/core";

type Inventory = GoalSelectionExample["inventory"];
type GoalInput = {
  inventory: Inventory;
  context: Record<string, number | boolean>;
};
const supported = new Set([
  "oak_log",
  "oak_planks",
  "stick",
  "cobblestone",
  "raw_iron",
  "iron_ingot",
  "coal",
  "charcoal",
  "crafting_table",
  "furnace",
  "wooden_pickaxe",
  "stone_pickaxe",
  "iron_pickaxe",
]);
const nameOf = (value: unknown) =>
  typeof value === "string" ? value.replace(/^minecraft:/, "") : "";
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const number = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function liveGoalInput(
  frame: AgentInputFrame,
  agent: AgentState,
):
  | {
      display: Inventory;
      input: GoalInput;
      omitted: number;
      contextSource: string;
    }
  | undefined {
  const sample = frame.channels["self.inventory"];
  if (sample?.status !== "ready") return;
  const raw = object(sample.data);
  if (!Array.isArray(raw?.slots)) return;
  const slots = raw.slots.flatMap((entry) => {
    const wrapper = object(entry);
    if (!wrapper) return [];
    const slot = number(wrapper.slot, -1);
    const item = object(wrapper.item) ?? wrapper;
    const name = nameOf(item.name);
    const count = number(item.count, 0);
    const mapped =
      slot >= 36 && slot <= 44
        ? slot - 36
        : slot >= 9 && slot <= 35
          ? slot
          : slot === 45
            ? 40
            : slot >= 5 && slot <= 8
              ? 44 - slot
              : -1;
    return Number.isInteger(mapped) &&
      mapped >= 0 &&
      mapped <= 40 &&
      name &&
      name !== "air" &&
      count > 0
      ? [{ slot: mapped, item: `minecraft:${name}`, count }]
      : [];
  });
  const display: Inventory = {
    size: 41,
    selected_hotbar_slot: Math.max(0, Math.min(8, number(raw.quickBarSlot, 0))),
    slots,
  };
  const modelSlots = slots.filter(
    (stack) =>
      (supported.has(nameOf(stack.item)) && stack.slot < 36) ||
      (supported.has(nameOf(stack.item)) && stack.slot === 40),
  );
  const vitals = object(frame.channels["self.vitals"]?.data);
  const time = object(frame.channels["world.time"]?.data);
  const blocks = object(frame.channels["world.blocks"]?.data);
  const seen = new Set(
    Array.isArray(blocks?.blocks)
      ? blocks.blocks.map((block) => nameOf(object(block)?.name))
      : [],
  );
  const has = (...names: string[]) => names.some((name) => seen.has(name));
  const ironNearby = has("iron_ore", "deepslate_iron_ore");
  const context = {
    wood_accessible: [...seen].some((name) => name.endsWith("_log")),
    stone_accessible: has("stone", "cobblestone", "deepslate"),
    iron_known: ironNearby,
    iron_accessible: ironNearby,
    crafting_table_accessible: has("crafting_table"),
    furnace_accessible: has("furnace"),
    health: Math.max(0, Math.min(20, number(vitals?.health, agent.health))),
    hunger: Math.max(0, Math.min(20, number(vitals?.food, agent.food ?? 20))),
    daytime: typeof time?.isDay === "boolean" ? time.isDay : true,
  };
  return {
    display,
    input: { inventory: { ...display, slots: modelSlots }, context },
    omitted: slots.length - modelSlots.length,
    contextSource: Array.isArray(blocks?.blocks)
      ? "Nearby client-known blocks"
      : "Nearby blocks unavailable; resource flags default to false",
  };
}
