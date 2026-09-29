import { z } from "zod";
import minecraftData from "minecraft-data";
const data = minecraftData("1.18.1");
export const itemCatalog = Object.values(data.itemsByName)
  .filter((item) => item.name !== "air")
  .map((item) => ({
    id: `minecraft:${item.name}`,
    name: item.displayName,
    stackSize: item.stackSize,
  }));
export const agentSetupSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            slot: z.number().int().min(0).max(40),
            item: z.string().regex(/^minecraft:[a-z0-9_]+$/),
            count: z.number().int().min(1).max(64),
          })
          .strict(),
      )
      .max(41),
    clearInventory: z.boolean(),
    resetVitals: z.boolean(),
    health: z.number().min(1).max(20),
    food: z.number().int().min(0).max(20),
    experienceLevel: z.number().int().min(0).max(10000),
    heldSlot: z.number().int().min(0).max(8),
    gamemode: z.enum(["world", "survival", "creative", "adventure"]),
    applyEachEpisode: z.boolean(),
    spawn: z
      .object({
        x: z.number().min(-29999984).max(29999984),
        y: z.number().min(-64).max(319),
        z: z.number().min(-29999984).max(29999984),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((setup, context) => {
    const slots = new Set<number>();
    setup.items.forEach((item, index) => {
      const definition = data.itemsByName[item.item.replace(/^minecraft:/, "")];
      if (!definition || definition.name === "air")
        context.addIssue({
          code: "custom",
          path: ["items", index, "item"],
          message: "Unknown Minecraft 1.18.1 item",
        });
      if (definition && item.count > definition.stackSize)
        context.addIssue({
          code: "custom",
          path: ["items", index, "count"],
          message: `Maximum stack size is ${definition.stackSize}`,
        });
      if (item.slot >= 36 && item.slot <= 39 && item.count !== 1)
        context.addIssue({
          code: "custom",
          path: ["items", index, "count"],
          message: "Armor slots hold one item",
        });
      if (slots.has(item.slot))
        context.addIssue({
          code: "custom",
          path: ["items", index, "slot"],
          message: "Each slot may appear only once",
        });
      slots.add(item.slot);
    });
  });
export const agentPresetSchema = z
  .object({ name: z.string().trim().min(1).max(80), setup: agentSetupSchema })
  .strict();
