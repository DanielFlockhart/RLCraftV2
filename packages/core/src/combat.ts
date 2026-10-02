import type { Action, AgentSetup, ArenaSpec, Observation } from "./index.js";

export const combatSessions = [
  {
    id: "C0",
    name: "Unarmed livestock",
    detail: "Learn aim and attack timing against a cow.",
    mob: "cow",
    weapon: undefined,
    armor: [],
  },
  {
    id: "C1",
    name: "Wooden sword basics",
    detail: "Fight a pig with a wooden sword.",
    mob: "pig",
    weapon: "wooden_sword",
    armor: [],
  },
  {
    id: "C2",
    name: "Stone axe timing",
    detail: "Fight a sheep using slower, heavier axe strikes.",
    mob: "sheep",
    weapon: "stone_axe",
    armor: [],
  },
  {
    id: "C3",
    name: "First hostile",
    detail: "Fight a zombie with a stone sword and leather armor.",
    mob: "zombie",
    weapon: "stone_sword",
    armor: [
      "leather_helmet",
      "leather_chestplate",
      "leather_leggings",
      "leather_boots",
    ],
  },
  {
    id: "C4",
    name: "Spider movement",
    detail: "Track and fight a fast spider with light gear.",
    mob: "spider",
    weapon: "stone_sword",
    armor: [
      "leather_helmet",
      "leather_chestplate",
      "leather_leggings",
      "leather_boots",
    ],
  },
  {
    id: "C5",
    name: "Ranged opponent",
    detail: "Close the gap to a skeleton with an iron sword.",
    mob: "skeleton",
    weapon: "iron_sword",
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C6",
    name: "Shield defence",
    detail: "Use a shield and stone axe against a skeleton.",
    mob: "skeleton",
    weapon: "stone_axe",
    shield: true,
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C7",
    name: "Under-equipped zombie",
    detail: "Survive and defeat a zombie with a wooden sword and no armor.",
    mob: "zombie",
    weapon: "wooden_sword",
    armor: [],
  },
  {
    id: "C8",
    name: "Two zombies",
    detail: "Manage two simultaneous melee threats with iron gear.",
    mob: "zombie",
    count: 2,
    weapon: "iron_sword",
    shield: true,
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C9",
    name: "Mixed melee threats",
    detail: "Fight a zombie and spider with mixed iron gear.",
    mob: "zombie",
    secondMob: "spider",
    weapon: "iron_axe",
    shield: true,
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C10",
    name: "Mixed ranged threats",
    detail: "Fight a skeleton and zombie while managing arrows.",
    mob: "skeleton",
    secondMob: "zombie",
    weapon: "iron_sword",
    shield: true,
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C11",
    name: "Mixed cover challenge",
    detail: "Fight a skeleton and spider around seeded arena cover.",
    mob: "skeleton",
    secondMob: "spider",
    weapon: "iron_sword",
    shield: true,
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C12",
    name: "Fast passive target",
    detail: "Track a chicken with a gold sword.",
    mob: "chicken",
    weapon: "golden_sword",
    armor: [],
  },
  {
    id: "C13",
    name: "Small evasive target",
    detail: "Track a rabbit with a diamond sword.",
    mob: "rabbit",
    weapon: "diamond_sword",
    armor: [],
  },
  {
    id: "C14",
    name: "Husk endurance",
    detail: "Fight a husk with a gold axe and leather armor.",
    mob: "husk",
    weapon: "golden_axe",
    armor: [
      "leather_helmet",
      "leather_chestplate",
      "leather_leggings",
      "leather_boots",
    ],
  },
  {
    id: "C15",
    name: "Drowned melee",
    detail: "Fight a drowned on land with a diamond axe.",
    mob: "drowned",
    weapon: "diamond_axe",
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C16",
    name: "Stray arrows",
    detail: "Fight a stray with a netherite axe and shield.",
    mob: "stray",
    weapon: "netherite_axe",
    shield: true,
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C17",
    name: "Cave spider",
    detail: "Fight a small poisonous spider with an iron sword.",
    mob: "cave_spider",
    weapon: "iron_sword",
    difficulty: "normal",
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C18",
    name: "Creeper fuse",
    detail: "Approach and retreat from a creeper with a diamond sword.",
    mob: "creeper",
    weapon: "diamond_sword",
    armor: [
      "diamond_helmet",
      "diamond_chestplate",
      "diamond_leggings",
      "diamond_boots",
    ],
  },
  {
    id: "C19",
    name: "Witch potions",
    detail: "Close the distance to a witch with a diamond axe.",
    mob: "witch",
    weapon: "diamond_axe",
    armor: [
      "diamond_helmet",
      "diamond_chestplate",
      "diamond_leggings",
      "diamond_boots",
    ],
  },
  {
    id: "C20",
    name: "Pillager crossbow",
    detail: "Fight a pillager with a netherite sword and shield.",
    mob: "pillager",
    weapon: "netherite_sword",
    shield: true,
    armor: [
      "diamond_helmet",
      "diamond_chestplate",
      "diamond_leggings",
      "diamond_boots",
    ],
  },
  {
    id: "C21",
    name: "Vindicator axe",
    detail: "Fight a vindicator with a netherite axe.",
    mob: "vindicator",
    weapon: "netherite_axe",
    shield: true,
    armor: [
      "diamond_helmet",
      "diamond_chestplate",
      "diamond_leggings",
      "diamond_boots",
    ],
  },
  {
    id: "C22",
    name: "Ravager",
    detail: "Fight a large, fast melee opponent with netherite gear.",
    mob: "ravager",
    weapon: "netherite_sword",
    shield: true,
    armor: [
      "netherite_helmet",
      "netherite_chestplate",
      "netherite_leggings",
      "netherite_boots",
    ],
  },
  {
    id: "C23",
    name: "Slime hops",
    detail: "Fight a hopping slime with a stone axe.",
    mob: "slime",
    weapon: "stone_axe",
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C24",
    name: "Magma cube",
    detail: "Defeat a jumping magma cube with a diamond axe.",
    mob: "magma_cube",
    weapon: "diamond_axe",
    armor: [
      "diamond_helmet",
      "diamond_chestplate",
      "diamond_leggings",
      "diamond_boots",
    ],
  },
  {
    id: "C25",
    name: "Blaze fire",
    detail: "Fight a blaze with a netherite sword and shield.",
    mob: "blaze",
    weapon: "netherite_sword",
    shield: true,
    armor: [
      "netherite_helmet",
      "netherite_chestplate",
      "netherite_leggings",
      "netherite_boots",
    ],
  },
  {
    id: "C26",
    name: "Bow aim",
    detail: "Use a bow against a skeleton while managing draw time.",
    mob: "skeleton",
    weapon: "bow",
    ammo: "arrow",
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C27",
    name: "Crossbow timing",
    detail: "Use a crossbow against a pillager.",
    mob: "pillager",
    weapon: "crossbow",
    ammo: "arrow",
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C28",
    name: "Trident throw",
    detail: "Use a trident against a drowned.",
    mob: "drowned",
    weapon: "trident",
    armor: [
      "diamond_helmet",
      "diamond_chestplate",
      "diamond_leggings",
      "diamond_boots",
    ],
  },
  {
    id: "C29",
    name: "Explosive mixed threat",
    detail: "Manage a creeper and zombie together with a diamond sword.",
    mob: "creeper",
    secondMob: "zombie",
    weapon: "diamond_sword",
    shield: true,
    armor: [
      "diamond_helmet",
      "diamond_chestplate",
      "diamond_leggings",
      "diamond_boots",
    ],
  },
  {
    id: "C30",
    name: "Neutral opponent",
    detail: "Fight a wolf that becomes aggressive after being attacked.",
    mob: "wolf",
    weapon: "wooden_axe",
    armor: [
      "leather_helmet",
      "leather_chestplate",
      "leather_leggings",
      "leather_boots",
    ],
  },
  {
    id: "C31",
    name: "Wither skeleton",
    detail: "Fight a wither skeleton while managing its status effect.",
    mob: "wither_skeleton",
    weapon: "diamond_sword",
    shield: true,
    armor: [
      "diamond_helmet",
      "diamond_chestplate",
      "diamond_leggings",
      "diamond_boots",
    ],
  },
  {
    id: "C32",
    name: "Zombified piglin",
    detail: "Provoke and defeat a neutral zombified piglin.",
    mob: "zombified_piglin",
    weapon: "iron_axe",
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C33",
    name: "Zoglin charge",
    detail: "Fight a fast, charging zoglin with a shield.",
    mob: "zoglin",
    weapon: "netherite_axe",
    shield: true,
    armor: [
      "netherite_helmet",
      "netherite_chestplate",
      "netherite_leggings",
      "netherite_boots",
    ],
  },
  {
    id: "C34",
    name: "Polar bear",
    detail: "Fight a large neutral polar bear with a stone sword.",
    mob: "polar_bear",
    weapon: "stone_sword",
    armor: ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"],
  },
  {
    id: "C35",
    name: "Llama spit",
    detail: "Fight a llama that retaliates at range after being attacked.",
    mob: "llama",
    weapon: "bow",
    ammo: "arrow",
    armor: [
      "leather_helmet",
      "leather_chestplate",
      "leather_leggings",
      "leather_boots",
    ],
  },
] as const;

export const combatMobTypes = [
  ...new Set(
    combatSessions.flatMap((session) => [
      session.mob,
      ...("secondMob" in session ? [session.secondMob] : []),
    ]),
  ),
];
export const combatMobTemperament: Record<
  string,
  "passive" | "neutral" | "hostile"
> = {
  cow: "passive",
  pig: "passive",
  sheep: "passive",
  chicken: "passive",
  rabbit: "passive",
  wolf: "neutral",
  zombified_piglin: "neutral",
  polar_bear: "neutral",
  llama: "neutral",
  spider: "hostile",
  cave_spider: "hostile",
  slime: "hostile",
  magma_cube: "hostile",
  zombie: "hostile",
  skeleton: "hostile",
  husk: "hostile",
  drowned: "hostile",
  stray: "hostile",
  creeper: "hostile",
  witch: "hostile",
  pillager: "hostile",
  vindicator: "hostile",
  ravager: "hostile",
  blaze: "hostile",
  wither_skeleton: "hostile",
  zoglin: "hostile",
};

export type CombatSession = (typeof combatSessions)[number]["id"];
export const combatSession = (id: CombatSession) =>
  combatSessions.find((entry) => entry.id === id)!;

/** Stage duration is anchored to its first episode, even after retries. */
export function combatFullRunTargetEpisodes(
  stageEpisodes: number,
  checkpointEpisode: number,
  stageStartEpisode: number,
) {
  const target = stageStartEpisode + stageEpisodes;
  if (!Number.isSafeInteger(stageStartEpisode) || stageStartEpisode < 0 || !Number.isSafeInteger(target) || target <= checkpointEpisode || target > 100000)
    throw new Error("Combat Full Run episode limit reached or checkpoint already reached the stage target");
  return target;
}

export function combatSetup(id: CombatSession): AgentSetup {
  const session = combatSession(id);
  const items: AgentSetup["items"] = [];
  if (session.weapon)
    items.push({ slot: 0, item: `minecraft:${session.weapon}`, count: 1 });
  if ("ammo" in session)
    items.push({ slot: 1, item: `minecraft:${session.ammo}`, count: 64 });
  session.armor.forEach((item, index) =>
    items.push({ slot: 39 - index, item: `minecraft:${item}`, count: 1 }),
  );
  if ("shield" in session && session.shield)
    items.push({ slot: 40, item: "minecraft:shield", count: 1 });
  return {
    items,
    clearInventory: true,
    resetVitals: true,
    health: 20,
    food: 20,
    experienceLevel: 0,
    heldSlot: 0,
    gamemode: "survival",
    applyEachEpisode: true,
  };
}

export function combatArena(id: CombatSession, seed: number): ArenaSpec {
  const session = combatSession(id);
  // Use the same deterministic scenario for every genome in a trial batch.
  const variant = Math.abs(seed) % 8;
  const offsetX = [-3, -2, -1, 0, 1, 2, 3, 0][variant];
  const offsetZ = [0, 1, -1, 2, -2, 1, -1, 0][variant];
  const mobs: ArenaSpec["blueprint"]["entities"] = [
    {
      position: { x: 9 + offsetX, y: 0, z: 5 + offsetZ },
      type: session.mob,
      count: "count" in session ? session.count : 1,
    },
  ];
  if ("secondMob" in session)
    mobs.push({
      position: { x: 5 - Math.sign(offsetX), y: 0, z: 7 - Math.sign(offsetZ) },
      type: session.secondMob,
      count: 1,
    });
  const regions: ArenaSpec["blueprint"]["regions"] = [];
  if (id === "C11") {
    const x = 4 + (seed % 3);
    regions.push({
      from: { x, y: 0, z: 9 },
      to: { x, y: 1, z: 10 },
      block: "minecraft:stone",
    });
  }
  return {
    blueprint: {
      width: 18,
      depth: 18,
      height: 5,
      floor: "minecraft:stone",
      walls: "minecraft:barrier",
      roof: "minecraft:barrier",
      spawn: { x: 9 - Math.sign(offsetX), y: 0, z: 14 - Math.sign(offsetZ) },
      regions,
      containers: [],
      entities: mobs,
    },
    origin: { x: 18000, y: -61, z: 18000 },
    layout: "individual",
    columns: 4,
    gap: 8,
    resetEachEpisode: true,
  };
}

export function combatReward(
  before: Observation,
  after: Observation,
  action: Action,
  verifiedKills = 0,
) {
  const prior = before.combat?.targets ?? [];
  const next = after.combat?.targets ?? [];
  const kills = Math.max(0, verifiedKills);
  const healthLoss = Math.max(0, before.health - after.health);
  const target = prior[0];
  const oldDistance = target
    ? Math.hypot(
        target.position.x - before.position.x,
        target.position.z - before.position.z,
      )
    : 0;
  const newDistance = target
    ? Math.hypot(
        target.position.x - after.position.x,
        target.position.z - after.position.z,
      )
    : 0;
  const approach =
    target && oldDistance > 3.2
      ? Math.max(-0.03, Math.min(0.03, (oldDistance - newDistance) * 0.05))
      : 0;
  const damage = prior.reduce((total, previous) => {
    const current = next.find((entry) => entry.id === previous.id);
    return (
      total +
      (current && previous.health !== undefined && current.health !== undefined
        ? Math.max(0, previous.health - current.health)
        : 0)
    );
  }, 0);
  const confirmedHits = Math.max(
    0,
    (after.combat?.confirmedHits ?? 0) - (before.combat?.confirmedHits ?? 0),
  );
  return (
    kills * 20 +
    (damage > 0 ? damage * 0.6 : confirmedHits * 2) -
    healthLoss * 1.5 +
    approach -
    (action.attack && !target ? 0.03 : 0) -
    0.002
  );
}
