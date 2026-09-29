import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { format } from "prettier";
import type { ProgressStep, ProgressRule } from "@rlcraft/core";

// Canonical catalog: edit this list, regenerate JSON + README. Detection rules
// describe observed facts rather than claiming an item was crafted when gifted.
const groups = [
  { id: "foundation", title: "1. Overworld foundations" },
  { id: "equipment", title: "2. Food and equipment" },
  { id: "portal", title: "3. Nether access: choose a route" },
  { id: "nether", title: "4. Fortress and blaze powder" },
  { id: "pearls", title: "5. Ender pearls: choose a route" },
  { id: "stronghold", title: "6. Eyes, stronghold and End portal" },
  { id: "dragon", title: "7. The End and dragon fight" },
  { id: "finish", title: "8. Exit portal and completion" },
  { id: "postgame", title: "9. Optional postgame" },
];
const steps: ProgressStep[] = [];
const inv = (items: string[], count = 1): ProgressRule => ({
  kind: "inventory",
  items,
  count,
});
const suffix = (value: string, count = 1): ProgressRule => ({
  kind: "inventory",
  suffix: value,
  count,
});
const adv = (id: string): ProgressRule => ({
  kind: "advancement",
  id: `minecraft:${id}`,
});
const stat = (
  category: "mined" | "crafted" | "used" | "picked_up" | "killed",
  names: string[],
  count = 1,
): ProgressRule => ({ kind: "statistic", category, names, count });
const block = (...names: string[]): ProgressRule => ({ kind: "block", names });
function add(
  group: string,
  id: string,
  title: string,
  requirement: ProgressStep["requirement"],
  instructions: string[],
  items: string,
  minimum: string,
  alternatives: string,
  ...rules: ProgressRule[]
) {
  steps.push({
    id,
    group,
    title,
    requirement,
    instructions,
    items,
    minimum,
    alternatives,
    rules,
  });
}
const wood = [
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "oak_wood",
  "spruce_wood",
  "birch_wood",
  "jungle_wood",
  "acacia_wood",
  "dark_oak_wood",
  "crimson_stem",
  "warped_stem",
];
const planks = [
  "oak_planks",
  "spruce_planks",
  "birch_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "crimson_planks",
  "warped_planks",
];
add(
  "foundation",
  "wood",
  "Obtain wood",
  "route",
  [
    "Find a reachable tree or another legal wood source.",
    "Break a log with the attack control, complete mining, and collect the drop.",
  ],
  "Logs/stems or reusable found planks.",
  "A normal self-crafted tool route starts with wood; exact total depends on selected tools/fuel.",
  "Loot/village workstations or existing equipment can skip wood gathering.",
  inv(wood),
);
add(
  "foundation",
  "planks",
  "Obtain planks",
  "route",
  [
    "Put a log/stem into the personal 2×2 crafting grid.",
    "Take the output; one ordinary log/stem produces four matching planks.",
  ],
  "1 log/stem → 4 planks.",
  "4 planks for a new crafting table; other recipes consume more.",
  "Found/looted planks also satisfy possession, but do not prove crafting.",
  inv(planks),
);
add(
  "foundation",
  "craft-planks",
  "Craft planks",
  "route",
  [
    "Select a valid log-to-planks recipe, take the result, and clear unused grid items.",
  ],
  "1 log/stem per batch of 4 planks.",
  "One batch when crafting planks yourself.",
  "Skip if using found planks.",
  stat("crafted", planks),
);
add(
  "foundation",
  "table",
  "Obtain a crafting table",
  "route",
  [
    "Arrange four planks in the 2×2 inventory grid.",
    "Take the crafting table, or collect an existing one.",
  ],
  "4 planks → 1 crafting table.",
  "1 reusable table for recipes needing 3×3.",
  "An accessible village/existing table can replace a carried one.",
  inv(["crafting_table"]),
);
add(
  "foundation",
  "use-table",
  "Open a crafting table",
  "route",
  ["Place or find a reachable table.", "Use it to open the 3×3 crafting menu."],
  "1 accessible crafting table; placement does not consume it permanently.",
  "No new table if one already exists.",
  "2×2 recipes such as eyes do not require a table.",
  { kind: "window", type: "crafting" },
);
add(
  "foundation",
  "sticks",
  "Obtain sticks",
  "route",
  [
    "Place two planks vertically; collect four sticks.",
    "Retain unused sticks for later tools.",
  ],
  "2 planks → 4 sticks.",
  "2 sticks per pickaxe; 1 per sword; 3 per bow.",
  "Dead bushes, leaves/loot or found tools can replace crafting.",
  inv(["stick"]),
);
add(
  "foundation",
  "wood-pick",
  "Obtain a wooden pickaxe",
  "route",
  [
    "Use three planks across the top and two sticks down the center.",
    "Take and equip the wooden pickaxe.",
  ],
  "3 planks + 2 sticks → 1 wooden pickaxe.",
  "1 for the conventional stone-tool bootstrap.",
  "A found stone-or-better pickaxe skips this tier.",
  inv(["wooden_pickaxe"]),
);
add(
  "foundation",
  "mine-stone",
  "Mine stone-tier material",
  "route",
  [
    "Find exposed stone/cobblestone or deepslate.",
    "Mine with a sufficient pickaxe and collect cobblestone/cobbled deepslate.",
  ],
  "Wooden-or-better pickaxe; suitable block.",
  "3 drops for a stone pickaxe; 8 more for a furnace.",
  "Loot stone tools or find a furnace instead.",
  stat("mined", ["stone", "cobblestone", "deepslate", "cobbled_deepslate"]),
);
add(
  "foundation",
  "stone-material",
  "Hold 11 stone-tier blocks",
  "route",
  ["Collect enough material for a stone pickaxe and furnace."],
  "11 cobblestone/cobbled deepslate, usable by the corresponding recipes.",
  "3 + 8 = 11 for these two crafted objects.",
  "Possession threshold is a supply check; spent materials may mean this checkpoint is never observed even if later stages succeed.",
  inv(["cobblestone", "cobbled_deepslate"], 11),
);
add(
  "foundation",
  "stone-pick",
  "Obtain a stone pickaxe",
  "route",
  [
    "Craft with three cobblestone/cobbled deepslate and two sticks, or obtain an equivalent higher-tier tool.",
    "Use a stone-or-better pickaxe for iron ore.",
  ],
  "3 stone-tier blocks + 2 sticks.",
  "1 stone pickaxe for the conventional iron route.",
  "Found higher-tier pickaxe bypasses this exact tier.",
  inv(["stone_pickaxe"]),
  adv("story/upgrade_tools"),
);
add(
  "foundation",
  "furnace",
  "Obtain a furnace",
  "route",
  [
    "Arrange eight cobblestone/cobbled deepslate around an empty center.",
    "Take it and place it near a fuel/ore supply, or use an existing furnace.",
  ],
  "8 stone-tier blocks → 1 furnace.",
  "1 reusable furnace for smelting route.",
  "Found furnace or looted/traded iron ingots can skip crafting.",
  inv(["furnace"]),
);
add(
  "foundation",
  "open-furnace",
  "Open a furnace",
  "route",
  ["Use a reachable furnace to access input, fuel and output slots."],
  "Accessible furnace.",
  "No extra material when using existing station.",
  "Other accepted iron-smelting station or found ingots can replace it.",
  { kind: "window", type: "furnace" },
);
add(
  "foundation",
  "fuel",
  "Obtain smelting fuel",
  "route",
  [
    "Mine coal or prepare charcoal/other furnace fuel.",
    "Put enough fuel in the fuel slot to smelt selected ore.",
  ],
  "Coal/charcoal, ordinary wood or other valid fuel.",
  "1 coal/charcoal smelts up to 8 items; selected bucket+igniter route needs 4 ingots.",
  "Nether wood is not ordinary wood fuel; do not assume every plank/log item burns. Looted ingots bypass smelting.",
  inv(["coal", "charcoal"]),
);
add(
  "foundation",
  "raw-iron",
  "Obtain raw iron",
  "route",
  [
    "Mine iron/deepslate iron ore with a stone-or-better pickaxe.",
    "Collect raw iron drops.",
  ],
  "Stone-or-better pickaxe and ore.",
  "4 raw iron for one crafted bucket plus flint and steel.",
  "Found ingots, golem drops or other legal iron sources bypass raw ore.",
  inv(["raw_iron"]),
);
add(
  "foundation",
  "iron",
  "Obtain four iron ingots",
  "route",
  [
    "Place raw iron/ore in furnace input and fuel in fuel slot.",
    "Wait for processing, collect ingots, and reserve three for the bucket and one for the igniter.",
  ],
  "4 iron ingots; ore/fuel if smelting.",
  "4 for this chosen bucket-cast/igniter route; not a universal game minimum.",
  "Found buckets/igniter or alternate ignition can lower required ingots.",
  inv(["iron_ingot"], 4),
);
add(
  "equipment",
  "food",
  "Obtain food",
  "preparation",
  [
    "Gather, hunt, farm or loot edible items.",
    "Cook applicable foods or use a safe edible source; keep a travel supply.",
  ],
  "Edible food; amount depends on travel, damage and difficulty.",
  "No fixed universal count; food is practical preparation, not an End-portal ingredient.",
  "Peaceful/no-hunger training rules change this requirement.",
  inv([
    "bread",
    "apple",
    "baked_potato",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_chicken",
    "cooked_mutton",
    "cooked_cod",
    "cooked_salmon",
    "carrot",
    "potato",
    "sweet_berries",
    "glow_berries",
    "melon_slice",
    "beetroot",
    "mushroom_stew",
    "rabbit_stew",
    "beetroot_soup",
    "dried_kelp",
    "porkchop",
    "beef",
    "chicken",
    "mutton",
    "rabbit",
    "cooked_rabbit",
    "cod",
    "salmon",
    "tropical_fish",
    "pufferfish",
    "rotten_flesh",
    "spider_eye",
    "poisonous_potato",
    "cookie",
    "pumpkin_pie",
    "golden_carrot",
    "golden_apple",
    "enchanted_golden_apple",
    "suspicious_stew",
  ]),
);
add(
  "equipment",
  "eat",
  "Eat food",
  "preparation",
  [
    "Select suitable food, hold use until consumption completes, and release.",
    "Avoid harmful foods or account for their effects.",
  ],
  "One consumable food item.",
  "As needed; not a fixed mandatory number.",
  "A food item in inventory is not proof that it has been eaten.",
  stat("used", [
    "bread",
    "apple",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_chicken",
    "baked_potato",
    "carrot",
    "golden_carrot",
  ]),
);
add(
  "equipment",
  "weapon",
  "Obtain a conventional melee weapon",
  "preparation",
  ["Craft/obtain a sword or axe and reserve durability for the fight."],
  "Sword: 2 matching material units + 1 stick; axe: 3 + 2 sticks.",
  "0 weapons strictly required; bare-hand damage exists.",
  "Beds/explosions are another combat route; tools and fists can also damage.",
  inv([
    "wooden_sword",
    "stone_sword",
    "iron_sword",
    "golden_sword",
    "diamond_sword",
    "netherite_sword",
    "wooden_axe",
    "stone_axe",
    "iron_axe",
    "golden_axe",
    "diamond_axe",
    "netherite_axe",
    "trident",
  ]),
);
add(
  "equipment",
  "shield",
  "Obtain a shield",
  "preparation",
  ["Craft with six planks and one iron ingot; equip appropriately."],
  "6 planks + 1 iron ingot.",
  "0 mandatory; 1 recommended for hazards.",
  "Shield does not make all dragon attacks harmless.",
  inv(["shield"]),
);
add(
  "equipment",
  "armor",
  "Obtain iron chest armor",
  "preparation",
  ["Craft or loot armor; equip the appropriate slots."],
  "Iron chestplate: 8 ingots. Full iron set: 24 ingots (5+8+7+4).",
  "0 armor strictly required.",
  "Other materials and enchantments are optional; possession is not proof of equipment.",
  inv(["iron_chestplate"]),
  adv("story/obtain_armor"),
);
add(
  "equipment",
  "blocks",
  "Hold building blocks",
  "preparation",
  [
    "Gather blocks for bridging, pillaring, shelters and escape routes.",
    "Do not assume a fixed stack suffices for every seed/platform layout.",
  ],
  "Suitable placeable solid blocks.",
  "Terrain-dependent; 64 is a useful supply checkpoint, not a guaranteed minimum.",
  "Pearls/terrain can replace some bridges; Nether fire hazards affect material choice.",
  inv(
    ["cobblestone", "cobbled_deepslate", "dirt", "netherrack", "end_stone"],
    64,
  ),
);
add(
  "equipment",
  "bed",
  "Obtain a bed",
  "preparation",
  [
    "Craft three wool of the same color and three planks, or collect a village bed.",
    "Use only safe Overworld sleeping if setting a checkpoint.",
  ],
  "3 same-color wool + 3 planks per crafted bed.",
  "0 mandatory for completion.",
  "Beds explode in Nether/End; a combat bed is consumed by the explosion.",
  suffix("_bed"),
);
add(
  "equipment",
  "spawn",
  "Sleep in the Overworld",
  "preparation",
  [
    "Place/use bed in the Overworld under valid sleep conditions; establish a practical recovery point.",
  ],
  "One accessible bed.",
  "Optional checkpoint.",
  "Nether/End bed use explodes rather than setting ordinary bed spawn.",
  adv("adventure/sleep_in_bed"),
);
add(
  "portal",
  "bucket",
  "Obtain a bucket",
  "route",
  ["Craft three ingots in a V shape or obtain a bucket elsewhere."],
  "3 iron ingots → 1 bucket.",
  "One bucket can suffice with suitable existing water/flow arrangements; two simplify repeated casting.",
  "Existing portal or mined obsidian can bypass bucket casting.",
  inv(["bucket", "water_bucket", "lava_bucket"]),
);
add(
  "portal",
  "water",
  "Obtain a water bucket",
  "route",
  [
    "Use an empty bucket on a water source.",
    "Preserve water placement/access for lava casting and later safety.",
  ],
  "1 bucket + water source.",
  "One reusable water supply for the chosen route.",
  "A fixed water source/flow and one repeatedly emptied bucket can replace two carried buckets.",
  inv(["water_bucket"]),
);
add(
  "portal",
  "lava",
  "Obtain a lava bucket",
  "route",
  ["Find a lava source, use a bucket to collect it, and plan safe placement."],
  "Bucket + lava source.",
  "Ten source-lava placements for a wholly new cornerless cast frame; bucket reused.",
  "Existing obsidian frame/ruined portal reduces new placements.",
  inv(["lava_bucket"]),
);
add(
  "portal",
  "flint",
  "Obtain flint",
  "route",
  ["Mine gravel until flint drops, or loot/trade it."],
  "Gravel or alternate flint source.",
  "1 flint for crafted flint and steel; gravel drops are random without applicable enchantment.",
  "Other ignition routes remove this item requirement.",
  inv(["flint"]),
);
add(
  "portal",
  "igniter",
  "Obtain a portal igniter",
  "route",
  [
    "Craft flint and steel with one flint and one iron ingot; reserve durability.",
  ],
  "1 iron ingot + 1 flint, or fire charge/other ignition source.",
  "1 ignition action on a valid frame.",
  "Lava-caused fire, existing lit portals or found igniters avoid the recipe.",
  inv(["flint_and_steel", "fire_charge"]),
);
add(
  "portal",
  "diamond",
  "Obtain three diamonds (mining alternative)",
  "route",
  [
    "Use iron-or-better pickaxe to mine diamond ore, or obtain diamonds from loot/trade.",
    "Reserve three for a diamond pickaxe if mining obsidian.",
  ],
  "3 diamonds; iron pickaxe recipe adds 3 ingots + 2 sticks.",
  "0 diamonds for bucket casting; 3 for self-crafted diamond pickaxe.",
  "Found diamond/netherite pickaxe replaces crafting.",
  inv(["diamond"], 3),
);
add(
  "portal",
  "diamond-pick",
  "Obtain an obsidian-capable pickaxe",
  "route",
  [
    "Craft diamond pickaxe with three diamonds and two sticks, or obtain diamond/netherite pickaxe.",
  ],
  "Diamond/netherite pickaxe.",
  "0 for casting directly into frame; 1 for survival obsidian drops through mining.",
  "Bucket casting/looted obsidian bypasses this tool.",
  inv(["diamond_pickaxe", "netherite_pickaxe"]),
);
add(
  "portal",
  "obsidian",
  "Hold ten obsidian (mining/loot alternative)",
  "route",
  [
    "Mine obsidian with sufficient tool or loot it.",
    "Build a vertical frame with 2×3 empty interior; corners can be omitted.",
  ],
  "10 obsidian for cornerless 4×5 outer footprint; 14 if corners included.",
  "10 frame blocks in the world; inventory obsidian can be 0 when casting directly.",
  "Ruined/existing frames reduce missing blocks. Crying obsidian cannot form a normal Nether portal.",
  inv(["obsidian"], 10),
);
add(
  "portal",
  "see-portal",
  "Observe an active Nether portal",
  "route",
  [
    "Complete valid frame, remove obstructing interior blocks, ignite inside, and verify purple portal blocks.",
    "Keep a safe route back.",
  ],
  "Valid obsidian frame + ignition; interior at least 2×3.",
  "One active portal; it may preexist.",
  "Sighting proves an active local portal, not that this agent built/ignited it.",
  block("nether_portal"),
);
add(
  "portal",
  "enter-nether",
  "Enter the Nether",
  "route",
  [
    "Move into the active portal, wait for dimension transfer, and verify destination.",
  ],
  "Active Nether portal.",
  "Required for self-sourced blaze rods in ordinary fresh survival, not for an already filled End portal.",
  "World must allow Nether travel; do not use beds there for normal sleeping.",
  { kind: "dimension", name: "the_nether" },
  adv("story/enter_the_nether"),
);
add(
  "nether",
  "gold-armor",
  "Obtain gold armor for piglin safety",
  "preparation",
  ["Craft/loot and equip a gold armor piece when traveling among piglins."],
  "Gold boots: 4 gold ingots; another armor piece can substitute.",
  "0 mandatory; one equipped piece reduces ordinary piglin hostility under its rules.",
  "Possession alone does not prove it is equipped; mining gold/opening containers can still provoke piglins.",
  inv([
    "golden_boots",
    "golden_helmet",
    "golden_chestplate",
    "golden_leggings",
  ]),
);
add(
  "nether",
  "fortress",
  "Reach a Nether fortress",
  "route",
  [
    "Explore safely until entering a generated fortress bounding region.",
    "Locate blaze spawning areas without falling/lava exposure.",
  ],
  "Navigation/survival capability; no fixed consumable ingredient.",
  "One fortress for conventional blaze route.",
  "Advancement proves entering the structure, not discovering a spawner specifically.",
  adv("nether/find_fortress"),
);
add(
  "nether",
  "blaze-seen",
  "Observe a blaze spawner",
  "route",
  [
    "Find and approach a reachable fortress spawner or naturally spawning blazes.",
    "Use cover and respect spawner activation distance.",
  ],
  "Reachable blaze source; non-Peaceful ordinary mob spawning.",
  "Spawner not mandatory if natural fortress blazes are available.",
  "Sighting a spawner alone does not identify its mob type; the block-entity data must say blaze.",
  { kind: "server-event", event: "blaze-seen" },
);
add(
  "nether",
  "kill-blaze",
  "Kill a blaze",
  "route",
  ["Fight a blaze, survive, and receive player kill credit."],
  "Any effective attack method; conventional weapon/cover optional.",
  "At least one credited kill; rod count depends on random drops and looting.",
  "Only credited kill statistics confirm this milestone; merely seeing a blaze die is insufficient.",
  stat("killed", ["blaze"]),
);
add(
  "nether",
  "rod",
  "Obtain a blaze rod",
  "route",
  [
    "Collect a rod from player/qualifying kill drops or legally supplied resources.",
  ],
  "Blaze rod.",
  "ceil(E/2) rods for E crafted eyes, before other blaze-powder uses.",
  "Ordinary fresh survival cannot replace blaze powder with another eye ingredient; a prefilled portal avoids eye production.",
  inv(["blaze_rod"]),
  adv("nether/obtain_blaze_rod"),
);
add(
  "nether",
  "rods-six",
  "Hold six blaze rods",
  "route",
  ["Continue collecting rods until the selected eye budget is available."],
  "6 blaze rods → 12 blaze powder.",
  "6 for 12 crafted eyes with no other powder use; more for search losses/brewing.",
  "You may craft incrementally and never hold six at once; this supply checkpoint is not a prerequisite gate.",
  inv(["blaze_rod"], 6),
);
add(
  "nether",
  "powder",
  "Obtain blaze powder",
  "route",
  ["Put a blaze rod in personal crafting grid; take both powder items."],
  "1 blaze rod → 2 blaze powder.",
  "1 powder per newly crafted eye.",
  "Brewing stand/fuel is optional and spends extra rods/powder.",
  inv(["blaze_powder"]),
);
add(
  "nether",
  "craft-powder",
  "Craft blaze powder",
  "route",
  ["Take the powder output from a valid recipe."],
  "1 rod per 2 powder.",
  "ceil(E/2) rods gives enough powder for E eyes.",
  "Possession alone is tracked separately from crafting evidence.",
  stat("crafted", ["blaze_powder"]),
);
add(
  "nether",
  "return-overworld",
  "Return to the Overworld",
  "route",
  [
    "Use a Nether portal and verify an Overworld spawn before searching for a stronghold.",
  ],
  "Accessible active portal.",
  "No additional consumed material for an existing safe return portal.",
  "An initially Overworld agent does not satisfy this transition; tracker requires earlier observed Nether presence.",
  { kind: "dimension", name: "overworld_after_nether" },
);
add(
  "pearls",
  "kill-enderman",
  "Kill an Enderman (hunting route)",
  "route",
  [
    "Find Endermen and use a safe combat method, such as a low shelter or water escape.",
    "Receive kill credit and collect dropped pearls.",
  ],
  "No fixed recipe; effective attack/survival method.",
  "Pearl drops are random; no fixed kill count guarantees the target amount.",
  "Trading or bartering can skip hunting entirely.",
  stat("killed", ["enderman"]),
);
add(
  "pearls",
  "gold",
  "Obtain gold ingots (bartering route)",
  "route",
  [
    "Acquire ingots via mining/smelting, nugget conversion or loot.",
    "Use ordinary adult piglins, not piglin brutes, for bartering.",
  ],
  "Gold ingots; 9 nuggets craft 1 ingot; 1 gold block gives 9 ingots.",
  "Random barter outcomes mean no finite guaranteed ingot count for a pearl target.",
  "A barter yields a batch of 2–4 pearls when the pearl outcome occurs in 1.18.1; hunting/cleric route avoids this budget.",
  inv(["gold_ingot"]),
);
add(
  "pearls",
  "barter",
  "Confirm a piglin barter",
  "route",
  [
    "Give/drop gold ingot to an eligible adult piglin, wait for processing and collect output.",
  ],
  "Adult piglin + gold ingot.",
  "One ingot per barter; repeated RNG outcomes may be needed.",
  "Holding both gold and pearls does not prove bartering.",
  adv("nether/distract_piglin"),
);
add(
  "pearls",
  "cleric",
  "Open a villager trade menu (cleric route)",
  "route",
  [
    "Find or establish a cleric using a brewing stand and valid villager profession conditions.",
    "Level trades to the pearl-selling tier; inspect actual offers.",
  ],
  "Villager, workstation if creating cleric, trade goods/emeralds; a crafted stand needs 1 rod + 3 cobblestone/blackstone.",
  "Generated offers/leveling costs determine actual emerald and goods budget.",
  "This detector proves a merchant menu was opened, not that it was a cleric or offered pearls.",
  { kind: "window", type: "merchant" },
);
add(
  "pearls",
  "trade",
  "Complete a villager trade",
  "route",
  ["Select a real offer, supply inputs, take output, and receive advancement."],
  "Actual offer inputs.",
  "No fixed universal count; repeated purchases depend on offer/restock limits.",
  "Any trade confirms trading capability; pearls still require the actual pearl offer.",
  adv("adventure/trade"),
);
add(
  "pearls",
  "pearl",
  "Obtain an Ender pearl",
  "route",
  ["Collect a hunted, bartered, traded or looted pearl."],
  "Ender pearl.",
  "1 pearl per crafted eye, plus any thrown for travel.",
  "Pearls spent as teleports are unavailable for crafting.",
  inv(["ender_pearl"]),
);
add(
  "pearls",
  "pearls-twelve",
  "Hold twelve Ender pearls",
  "route",
  [
    "Gather the pearl budget for an unfilled portal before consuming travel/search supplies.",
  ],
  "12 Ender pearls.",
  "12 only for 12 new eyes, no search loss or teleport spending.",
  "Prefilled frames reduce needed eyes; incremental crafting may bypass this possession checkpoint.",
  inv(["ender_pearl"], 12),
);
add(
  "stronghold",
  "eye",
  "Obtain an Eye of Ender",
  "route",
  [
    "Combine one pearl and one blaze powder in personal crafting grid and take one eye.",
  ],
  "1 Ender pearl + 1 blaze powder → 1 Eye of Ender.",
  "One eye per missing portal frame; zero if all 12 are prefilled.",
  "Finding a stronghold without eye throws is possible; throwing eyes does not activate a portal.",
  inv(["ender_eye"]),
);
add(
  "stronghold",
  "craft-eye",
  "Craft an Eye of Ender",
  "route",
  ["Take the actual recipe output."],
  "One pearl and one powder per eye.",
  "E eyes require E pearls and E powder.",
  "This milestone uses crafting statistics, not inventory coincidence.",
  stat("crafted", ["ender_eye"]),
);
add(
  "stronghold",
  "eyes-twelve",
  "Hold twelve Eyes of Ender",
  "route",
  ["Prepare a complete unfilled-portal eye budget before insertion."],
  "12 Eyes of Ender.",
  "Portal insertion count is 12 − prefilled frames; search losses are additional.",
  "This is a conservative supply checkpoint, not universally mandatory.",
  inv(["ender_eye"], 12),
);
add(
  "stronghold",
  "throw-eye",
  "Use an Eye of Ender for navigation",
  "route",
  [
    "Use an eye in the Overworld, follow its flight, recover it if it drops, repeat/triangulate as needed.",
    "Reserve enough intact eyes for insertion.",
  ],
  "Reusable eye if it returns; replacement eyes if it breaks.",
  "No fixed worst-case search-loss budget; no throws needed for an already-known stronghold.",
  "Use statistic confirms use, but does not prove an independent successful triangulation.",
  stat("used", ["ender_eye"]),
);
add(
  "stronghold",
  "stronghold",
  "Reach a stronghold",
  "route",
  [
    "Travel to the indicated area, dig a safe approach, and enter the generated stronghold.",
  ],
  "Navigation and safe excavation tools/route.",
  "One reachable stronghold with a portal room.",
  "The Eye Spy advancement is location-based in 1.18.1; eye throwing is not a prerequisite for receiving it.",
  adv("story/follow_ender_eye"),
);
add(
  "stronghold",
  "portal-room",
  "Observe End portal frames",
  "route",
  [
    "Search corridors/stairs for the portal room; handle silverfish and lava hazards.",
    "Inspect all twelve frame blocks and count existing eyes.",
  ],
  "Existing generated frame ring; frames cannot ordinarily be crafted/placed in survival.",
  "12 correctly arranged inward-facing frames; one surviving usable portal room.",
  "Local frame sighting does not prove the full ring or count all prefilled eyes.",
  block("end_portal_frame"),
);
add(
  "stronghold",
  "insert-eye",
  "Observe a filled End portal frame",
  "route",
  ["Use eyes on empty frames; preserve existing filled frames."],
  "1 eye per empty frame.",
  "P = 12 − s where s is prefilled count; P can be 0.",
  "Sighting an eye-filled frame does not establish that this agent inserted it.",
  { kind: "block", names: ["end_portal_frame"], properties: { eye: "true" } },
);
add(
  "stronghold",
  "active-end-portal",
  "Observe an active End portal",
  "route",
  [
    "Fill all missing eyes, verify active portal blocks inside the ring, and finish preparation before jumping in.",
  ],
  "Complete filled frame ring; usable portal.",
  "No extra eye if already active.",
  "Activation can be performed by another player; observation is not ownership credit.",
  block("end_portal"),
);
add(
  "dragon",
  "enter-end",
  "Enter the End",
  "completion",
  [
    "Move/jump into the active End portal and verify End dimension.",
    "Check spawn platform, void exposure and nearby island before moving.",
  ],
  "Active End portal; bridging/pearls if terrain requires them.",
  "Entering the End is required; a survival escape route is not automatically available until dragon defeat.",
  "Spawn-platform geometry controls required bridge/travel supplies.",
  { kind: "dimension", name: "the_end" },
  adv("story/enter_the_end"),
);
add(
  "dragon",
  "reach-island",
  "Reach the main End island",
  "route",
  [
    "If platform is separated, bridge/pillar or use a valid pearl trajectory; move to stable End stone.",
  ],
  "Terrain-dependent blocks or pearl.",
  "No universal block count; no bridge if platform is already connected.",
  "Tracker verifies nearby End stone while in End, not the quality of every bridge movement.",
  block("end_stone"),
);
add(
  "dragon",
  "bow",
  "Obtain a bow (ranged route)",
  "preparation",
  ["Craft/loot a bow and obtain ammunition; practice aim before End hazards."],
  "3 sticks + 3 string → 1 bow.",
  "0 bows mandatory; 1 for conventional ranged crystal/flying attacks.",
  "Crossbow costs 3 sticks + 2 string + 1 iron ingot + 1 tripwire hook; other damage routes exist.",
  inv(["bow", "crossbow"]),
);
add(
  "dragon",
  "arrows",
  "Obtain ammunition",
  "preparation",
  [
    "Craft with flint, stick and feather or collect/trade arrows; select compatible ammunition.",
  ],
  "1 flint + 1 stick + 1 feather → 4 arrows.",
  "No fixed universal count; misses/crystal route/enchants alter consumption.",
  "Infinity bows need an eligible arrow; crossbows and special ammunition have their own rules.",
  inv(["arrow", "spectral_arrow", "tipped_arrow"]),
);
add(
  "dragon",
  "pumpkin",
  "Obtain carved pumpkin (optional)",
  "preparation",
  [
    "Shear a placed pumpkin and collect/equip carved pumpkin for Enderman gaze protection.",
  ],
  "Pumpkin + shears if crafting this way; shears cost 2 iron ingots.",
  "0 mandatory; 1 optional head item.",
  "It reduces vision and does not prevent every cause of Enderman aggression.",
  inv(["carved_pumpkin"]),
);
add(
  "dragon",
  "crystal",
  "Observe an End crystal",
  "route",
  [
    "Identify crystals on obsidian pillars and which are caged.",
    "Plan ranged shot or safe pillar access; account for explosion radius.",
  ],
  "No item consumed just to observe.",
  "Crystal destruction is a practical fight plan, not logically necessary if damage outpaces healing.",
  "Seeing a crystal disappear or a nearby explosion is not proof this agent destroyed it.",
  { kind: "server-event", event: "crystal" },
);
add(
  "dragon",
  "destroy-crystals",
  "Destroy healing End crystals",
  "route",
  [
    "Shoot exposed crystals or reach them using safe traversal.",
    "For caged pillars, reach a safe position and open iron bars with a suitable method.",
    "Break crystals without standing in their explosion, then verify remaining healing sources.",
  ],
  "Weapon/projectile or safe melee access; blocks/water as needed.",
  "Zero strictly required for theoretical completion; ordinary fresh fights generate ten pillars/crystals.",
  "There is no fixed arrow/block budget and no requirement to collect crystal items.",
  { kind: "server-event", event: "destroy-crystals" },
);
add(
  "dragon",
  "fight-dragon",
  "Damage the Ender Dragon",
  "completion",
  [
    "Track flying/perching phases, avoid breath/knockback/void, and attack valid vulnerable parts.",
    "Use conventional attacks or a safely executed explosion route; continue until lethal damage.",
  ],
  "Any successful damage method; beds/materials conditional.",
  "Damage is required to defeat it; no specific sword/armor/bow item is mandatory.",
  "Observing damage alone does not identify the attacker.",
  { kind: "server-event", event: "fight-dragon" },
  adv("end/kill_dragon"),
  stat("killed", ["ender_dragon"]),
);
add(
  "dragon",
  "bed-fight",
  "Prepare beds for explosive combat (alternative)",
  "route",
  [
    "Obtain sufficient beds and protective positioning blocks.",
    "Place/use a bed near a valid dragon-perch setup in the End, keep explosion shielding, and repeat if needed.",
  ],
  "Each crafted bed: 3 same-color wool + 3 planks; protective block/setup.",
  "No fixed guaranteed bed count; damage depends on placement/timing. Each exploded bed is consumed.",
  "Conventional melee/ranged attacks skip this route entirely.",
  suffix("_bed"),
  stat("used", [
    "white_bed",
    "red_bed",
    "blue_bed",
    "black_bed",
    "yellow_bed",
    "green_bed",
    "pink_bed",
    "orange_bed",
    "purple_bed",
    "cyan_bed",
    "light_blue_bed",
    "light_gray_bed",
    "gray_bed",
    "lime_bed",
    "brown_bed",
    "magenta_bed",
  ]),
);
add(
  "dragon",
  "kill-dragon",
  "Receive Ender Dragon kill credit",
  "completion",
  [
    "Complete the fight and receive Free the End advancement or a player dragon-kill statistic.",
  ],
  "Successful credited dragon defeat.",
  "One defeat for initial completion.",
  "Seeing another player's kill, rewards or a spawned exit portal is not this agent's kill credit.",
  adv("end/kill_dragon"),
  stat("killed", ["ender_dragon"]),
);
add(
  "finish",
  "exit-portal",
  "Observe the active End exit portal",
  "route",
  [
    "After dragon defeat, approach the central exit fountain and verify active portal surface.",
  ],
  "An active central End exit portal.",
  "One usable exit portal.",
  "A portal at a stronghold is not an End exit; tracker requires current End dimension.",
  block("end_portal"),
);
add(
  "finish",
  "credits",
  "Trigger the End completion/credits event",
  "completion",
  [
    "Enter the central End exit portal after the dragon fight.",
    "Receive the server's win-game event; a rendered client may display the End poem/credits.",
  ],
  "Active End exit portal; no item consumed.",
  "One valid win-game event. Headless bots do not have a rendered credits screen.",
  "The event alone does not prove this same agent killed the dragon; those milestones stay separate.",
  { kind: "credits" },
);
add(
  "finish",
  "return-end",
  "Return from the End via the completion route",
  "completion",
  [
    "Finish/skip credits or allow the client backend's ordinary respawn response.",
    "Verify a subsequent Overworld spawn/dimension after the End exit event.",
  ],
  "No additional item; normal server/client lifecycle.",
  "A return after the recorded win-game event.",
  "Death or an admin teleport alone does not satisfy this detector.",
  { kind: "end-return" },
);
add(
  "postgame",
  "egg",
  "Obtain the dragon egg (not required)",
  "postgame",
  [
    "Collect the egg through a valid torch/piston or other survival method after its teleport mechanic.",
  ],
  "Method-dependent torch/piston/support.",
  "0 for completion.",
  "Egg is a trophy, not an ingredient needed to finish the game.",
  inv(["dragon_egg"]),
);
add(
  "postgame",
  "gateway",
  "Use an End gateway (not required)",
  "postgame",
  [
    "After dragon defeat, use the gateway to reach outer islands by safe pearl/crawl/other valid method.",
  ],
  "Method-dependent travel supplies.",
  "0 for initial completion.",
  "Advancement confirms gateway traversal, not return credits.",
  adv("end/enter_end_gateway"),
);
add(
  "postgame",
  "city",
  "Reach an End city (not required)",
  "postgame",
  ["Explore outer islands and enter an End city."],
  "Travel/survival resources.",
  "0 for completion.",
  "Not all cities have a ship.",
  adv("end/find_end_city"),
);
add(
  "postgame",
  "elytra",
  "Obtain elytra (not required)",
  "postgame",
  ["Find an End ship and collect the elytra."],
  "Ship access; optional flight rockets/repair materials later.",
  "0 for completion.",
  "Not a prerequisite for first dragon fight.",
  inv(["elytra"]),
  adv("end/elytra"),
);
add(
  "postgame",
  "respawn-dragon",
  "Respawn the dragon (not required)",
  "postgame",
  ["Place four End crystals around the exit fountain in the valid pattern."],
  "4 crystals; each crafted from 7 glass + 1 Eye of Ender + 1 ghast tear.",
  "0 for first completion; crafted respawn set uses 28 glass + 4 eyes + 4 tears.",
  "Repeated dragon fights and all-advancement completion are separate goals.",
  adv("end/respawn_dragon"),
);

const resources = [
  {
    item: "Eye of Ender",
    minimum:
      "P = 12 − s inserted eyes; E = P + L crafted/search replacement eyes.",
    route: "Portal activation",
    notes:
      "s is prefilled-frame count (0–12); L is unrecovered broken/lost eye consumption. Extra deliberately stored spare eyes are additional. A fully prefilled portal needs 0 crafted eyes.",
  },
  {
    item: "Ender pearl",
    minimum:
      "E pearls for E crafted eyes, plus pearls actually spent on travel.",
    route: "Hunting / bartering / cleric trade / loot",
    notes:
      "RNG drops/barters have no finite guaranteed kill/ingot count; item possession does not identify source.",
  },
  {
    item: "Blaze powder / rods",
    minimum: "E powder; ceil(E/2) rods if converting rods only.",
    route: "Fortress rod drops → powder",
    notes:
      "1 rod gives 2 powder; brewing/cleric workstation costs extra. Twelve new eyes cost 12 pearls + 12 powder = 6 rods.",
  },
  {
    item: "Nether portal frame",
    minimum:
      "10 obsidian frame blocks (cornerless) or 14 with corners; subtract usable existing blocks.",
    route: "Bucket casting / diamond mining / loot / ruined portal",
    notes:
      "Cast blocks can remain in world: no obsidian inventory stack required. Crying obsidian is invalid. A prelit portal skips construction/ignition.",
  },
  {
    item: "Bucket + ignition",
    minimum:
      "Crafted bucket 3 iron; flint and steel 1 iron + 1 flint: 4 iron total.",
    route: "Chosen single-bucket casting + crafted igniter",
    notes:
      "One reusable bucket with suitable water flow can suffice; two buckets raise budget to 7 iron with igniter. Repeated lava sources are needed. Found tools/natural ignition alter budget.",
  },
  {
    item: "Conventional bootstrap",
    minimum:
      "Table 4 planks; sticks 2 planks → 4; wooden pick 3 planks + 2 sticks; stone pick 3 stone + 2 sticks; furnace 8 stone.",
    route: "Empty-inventory self-crafted tools",
    notes:
      "Combined: 9 planks (at least 3 ordinary logs giving 12 planks), 11 cobblestone/cobbled deepslate, plus iron ore/fuel. Remaining 3 planks may be fuel. Found stations/tools bypass costs.",
  },
  {
    item: "Iron smelting",
    minimum:
      "4 raw iron/ore + enough fuel for 4 smelts in chosen casting/igniter route.",
    route: "Stone-or-better mining → furnace",
    notes:
      "1 coal/charcoal can smelt 8 items. Making charcoal has its own log/fuel cost; ordinary planks are another fuel route. Standard route need not consume diamonds.",
  },
  {
    item: "Diamond mining alternative",
    minimum:
      "Diamond pick 3 diamonds + 2 sticks; iron pick 3 iron + 2 sticks if crafting ore-mining prerequisite.",
    route: "Mining obsidian",
    notes:
      "0 diamonds for casting/looted obsidian. Existing diamond/netherite tools bypass recipes.",
  },
  {
    item: "Gold",
    minimum:
      "No fixed guaranteed barter budget; gold boots 4 ingots if crafting piglin armor.",
    route: "Piglin pearl alternative",
    notes:
      "Adult piglins barter ingots; brutes do not. Gold armor safety is conditional, not invulnerability.",
  },
  {
    item: "Cleric trade setup",
    minimum:
      "Offer/level-dependent emeralds and goods; crafted brewing stand 1 blaze rod + 3 cobblestone/blackstone.",
    route: "Villager pearl alternative",
    notes:
      "Actual generated pearl offer, level, prices and restock behavior determine budget; no universal fixed emerald count.",
  },
  {
    item: "Melee equipment",
    minimum:
      "Sword 2 material + 1 stick; axe 3 material + 2 sticks; shield 6 planks + 1 iron.",
    route: "Conventional combat preparation",
    notes:
      "None of these specific items is universally mandatory; bare-hand/explosion damage alternatives exist.",
  },
  {
    item: "Bow / arrows",
    minimum:
      "Bow 3 sticks + 3 string; arrow batch 1 flint + 1 stick + 1 feather → 4 arrows.",
    route: "Ranged preparation",
    notes:
      "Exact shots needed are skill/route-dependent. A 64-arrow crafted reserve uses 16 each flint/stick/feather; not a minimum guarantee.",
  },
  {
    item: "Armor",
    minimum: "Iron set 24 ingots (helmet 5, chest 8, legs 7, boots 4).",
    route: "Optional survival protection",
    notes:
      "0 mandatory; other materials/enchants substitute. Shield/armor do not protect against the void.",
  },
  {
    item: "Beds",
    minimum:
      "3 same-color wool + 3 planks per crafted bed; bed count is fight-dependent.",
    route: "Checkpoint / End explosion alternative",
    notes:
      "Overworld sleep optional; beds explode in Nether/End. No fixed number guarantees dragon defeat across timings/damage.",
  },
  {
    item: "Food / blocks / water / safety",
    minimum:
      "Travel-, difficulty-, terrain-, damage- and skill-dependent; no universal count.",
    route: "Practical preparation",
    notes:
      "Carry enough building blocks, edible food, water and durability for selected route; don't present recommended stacks as mathematical minima.",
  },
];
const catalog = {
  schemaVersion: 1,
  minecraftVersion: "1.18.1",
  goal: "Defeat the Ender Dragon and use the End exit portal; distinguish kill credit, win-game event and return.",
  scope:
    "Vanilla survival completion on the configured Paper 1.18.1 baseline. No commands, glitches or creative shortcuts are assumed; routes and preparation are not universal prerequisites. Checks are historical observed facts, not a claim of unaided accomplishment.",
  groups,
  steps,
  resources,
};
if (new Set(steps.map((s) => s.id)).size !== steps.length)
  throw new Error("Duplicate progression IDs");
const path = resolve("packages/core/src/progression-catalog.json");
await writeFile(
  path,
  await format(JSON.stringify(catalog), { parser: "json" }),
);
const lines = [
  "# Completing Minecraft Java 1.18.1: steps and minimum resources",
  "",
  "The configured server version is **Paper / Minecraft Java 1.18.1** (`MC_VERSION=1.18.1`; the prepared runtime log identifies Paper-216 for MC 1.18.1). The goal here is **defeat the Ender Dragon, use the End exit portal, and return through the completion lifecycle**. Minecraft continues afterward. All advancements, Wither, elytra, dragon egg, respawned dragons and full item collection are separate optional goals.",
  "",
  `The checklist has **${steps.length} milestones** covering the standard survival route, its major legal alternative routes, preparation and optional postgame. Each includes ordered actions, ingredients/minimums, substitutions and the exact automatic evidence check. This is exhaustive within that stated route scope; arbitrary seeds, multiplayer assistance, mods, player skill, loot/RNG and custom experiments make a single universal linear minimum impossible. A rare already-active portal can skip all eye/Nether production. Found equipment can skip the tool chain.`,
  "",
  "## Preconditions and meaning of minimum",
  "",
  "Use a normal generated survival world with structures/strongholds, usable End portal and enabled End travel. Self-sourcing blaze rods ordinarily also needs Nether access, a fortress and a non-Peaceful source of blazes. Paper plugins, disabled dimensions, structure-free superflat/custom worlds, modified recipes/drops or a previously completed world can change feasibility. Starting equipment, keep-inventory, custom structures and no-hunger settings change costs; they are experiment conditions, not secretly completed actions.",
  "",
  "Minimum means a conditional ingredient floor, not a guaranteed safe loadout. No fixed universal arrow, block, food, gold-barter or mob-kill number guarantees success. Navigation may lose eyes and combat may consume more supplies. Tools/stations/buckets can be reused, while inserted eyes and exploded beds are consumed. Preparatory tiers are skippable when equivalent items/stations are found. The tracker never requires a skipped alternative before allowing a later milestone to be reached.",
  "",
  "## Route and exact resource ledger",
  "",
  "Standard route: wood/tools → enough iron/fuel → cast or mine a Nether portal → fortress/rods → powder + pearls (hunt, barter or trade) → eyes → stronghold/portal → End → dragon → exit/credits → return. Tool and pearl branches are alternatives, not tasks that must all be done.",
  "",
  "| Item/resource | Conditional minimum | Route | Qualifications |",
  "| --- | --- | --- | --- |",
  ...resources.map(
    (r) => `| ${r.item} | ${r.minimum} | ${r.route} | ${r.notes} |`,
  ),
  "",
  "If the portal has s prefilled eyes, P = 12 − s more insertions are needed. If search loses L eyes and no other eye spending occurs, E = P + L eyes must be supplied/crafted: E pearls + E powder, or ceil(E/2) rods. If s=0 and L=0, the insertion-only floor is **12 pearls + 6 rods**. That floor excludes search losses and other material spending. Converting a seventh rod may be sensible preparation, but it is not a universal minimum.",
  "",
  "An illustrative self-crafted one-bucket casting bootstrap (not a full guaranteed combat loadout) uses **3 ordinary logs → 12 planks**, spending 4 on table, 2 on four sticks, 3 on wooden pick, then the four sticks between wooden/stone picks; **11 stone-tier drops** for stone pick/furnace; **4 iron ore/raw iron** for bucket+igniter; sufficient smelting fuel and **1 flint**. The remaining three ordinary planks can provide more than four smelts' fuel. Safe water access and ten reusable-bucket lava-source placements make ten frame blocks. Extra weapon, armor, blocks, food and navigational supplies add their own budgets. A reusable table/furnace does not have to be carried afterward.",
  "",
  "## Every milestone and its detection",
  "",
];
let number = 0;
for (const group of groups) {
  lines.push(`### ${group.title}`, "");
  for (const s of steps.filter((s) => s.group === group.id)) {
    lines.push(
      `#### ${++number}. ${s.title} — \`${s.id}\``,
      "",
      `**Classification:** ${s.requirement}.`,
      "",
      ...s.instructions.map((x, i) => `${i + 1}. ${x}`),
      "",
      `**Items:** ${s.items}`,
      "",
      `**Minimum:** ${s.minimum}`,
      "",
      `**Alternatives/limits:** ${s.alternatives}`,
      "",
      "**Evidence (any applicable rule):**",
      "",
      ...s.rules.map((r) => `- ${ruleText(r)}`),
      "",
    );
  }
}
function ruleText(r: ProgressRule): string {
  if (r.kind === "inventory")
    return `Observed player inventory containing ${r.count ?? 1} total matching item(s): ${r.items?.join(", ") ?? `names ending ${r.suffix}`}. Possession does not prove crafting or acquisition source.`;
  if (r.kind === "advancement")
    return `Completed received advancement \`${r.id}\`, evaluated against all transmitted requirement groups.`;
  if (r.kind === "statistic")
    return `Received player ${r.category} statistic for ${r.names.join(", ")} at least ${r.count ?? 1}. Cached/pre-existing totals are labeled existing evidence.`;
  if (r.kind === "dimension")
    return `Observed dimension ${r.name}. Overworld-after-Nether requires earlier Nether presence in this session.`;
  if (r.kind === "block")
    return `A loaded nearby block named ${r.names.join(" / ")}${r.properties ? ` with ${JSON.stringify(r.properties)}` : ""}. This proves local observation, not who placed it. End exit portal requires End dimension; main-island End stone also requires End.`;
  if (r.kind === "window")
    return `Opened window whose type contains \`${r.type}\`; station/menu sighting is not crafting/trade completion.`;
  if (r.kind === "credits")
    return "Received win-game event after observed End presence; do not infer victory from run completion or a generic death/respawn.";
  if (r.kind === "end-return")
    return "Observed Overworld spawn after End presence and the win-game event; death-only return is not enough.";
  if (r.kind === "server-event")
    return `Read-only Paper event \`${r.event}\`: registered agent sighting or accepted actor-attributed damage/destruction. Requires the updated viewer plugin; no hidden state is passed to the policy.`;
  return `**Requires an additional attribution hook; currently not automatically confirmed.** ${r.reason}`;
}
lines.push(
  "## Dashboard and evidence semantics",
  "",
  "The **Progress** tab shows every milestone, its required/route/preparation/postgame classification, ingredients/minimums and detection. It polls durable progress independently of the policy's selected inputs. All-runs history answers whether any registered agent ever reached a milestone; a run filter scopes it. Reached steps show first observed agent/run, generation/time, evidence source, game mode and existing/setup/live origin. History survives worker/control restart and world/generation resets; it is not current world state. Newly created worlds do not erase past accomplishments.",
  "",
  "The default view includes all agent game modes. Survival/adventure filtering uses the recorded mode at each evidence event; it does not certify an unassisted run because setup/gifts can still supply items. A first setup possession is labeled setup, a previously completed advancement/statistic is existing, and later observations are live. A supplied tool reaches Obtain tool but never proves Craft tool. No prerequisite is retroactively marked reached just because a later step succeeded.",
  "",
  "Statuses distinguish **Reached**, **Not observed**, and **Awaiting server evidence**. Four procedural/attribution milestones use the read-only Paper plugin for sighting or actor-attributed damage/destruction. They remain unconfirmed until that hook is available; there is no button to fabricate completion. Progress does not implement missing AI actions; current placeholder policies cannot independently complete the game yet. Old inactive runs have no complete retroactive event history, so unknown achievements are not backfilled from logs or guessed from current inventories.",
  "",
  "Native tracking listens to this agent's ordinary received advancements/statistics, inventory, dimension, nearby loaded blocks and UI. Statistics use the normal client statistics request, at most once every 10 seconds per native agent, and do not mutate worlds. Progress data is administrative telemetry, not an extra unmasked policy observation. Simulator runs never generate Minecraft milestone evidence. Alternate adapters can implement Environment.watchProgress; missing hooks are shown as unsupported.",
  "",
  "Plugin attribution reports a targeted blaze spawner, line-of-sight/forward-facing End crystal, accepted uncancelled player/projectile dragon damage, and crystal removal after that accepted actor damage. It does not mutate the world or expose extra policy sensors. Install with `npm run viewer:build` and restart Minecraft to load it; control must also restart for new routes/workers. Bed explosions with no player-attributed entity damage are not credited as a direct damage event; eventual dragon kill credit still proves combat. Completion/credits remains independently tracked.",
  "",
  "## Sources and maintenance",
  "",
  "Run `npm run progress:verify` to exercise setup inventory, actual crafting, received advancements, plugin attribution, and the End exit lifecycle against an isolated copy of the prepared Paper runtime. It uses a random port and disposable test world; scripted fixture grants verify detection and are not evidence of a policy beating survival. The normal running server and worlds are left untouched.",
  "",
  "Version-specific recipes, advancement predicates and barter counts were checked against the project's cached **official Mojang 1.18.1 server jar**, including `data/minecraft/recipes/ender_eye.json`, `blaze_powder.json`, `data/minecraft/advancements/story/follow_ender_eye.json`, `nether/find_fortress.json`, `end/kill_dragon.json` and `loot_tables/gameplay/piglin_bartering.json`. The installed minecraft-data 1.18.1 registry supplies numeric item/block/entity and packet definitions. No post-1.18 combat items or later smithing recipes are assumed.",
  "",
  "Primary explanatory references: [Minecraft: Stronghold](https://www.minecraft.net/en-us/article/stronghold) for the portal/dragon goal and [PrismarineJS minecraft-data](https://github.com/PrismarineJS/minecraft-data) for the versioned protocol/registry. The versioned jar/recipes are the authoritative ingredient checks rather than a modern-edition guide.",
  "",
  "Edit [scripts/export-progression.ts](../../scripts/export-progression.ts), then run `npm run progress:catalog` to update this README and the shared JSON catalog together. The dashboard reads the shared catalog rather than a separate manual checklist. Review recipes, rule decoding and evidence semantics when changing Minecraft version. An unsupported version is displayed as unsupported rather than silently relabeling this baseline.",
  "",
);
await mkdir(resolve("docs/progression"), { recursive: true });
await writeFile(
  resolve("docs/progression/README.md"),
  await format(lines.join("\n"), { parser: "markdown" }),
);
console.log(
  `Exported ${steps.length} milestones and ${resources.length} resource entries for Minecraft 1.18.1.`,
);
