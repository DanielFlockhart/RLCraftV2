"use client";
import Image from "next/image";
import { useId } from "react";
import type { StageId, WorldSettings } from "@mlcraft/core";

const blocks = {
  grass_block: ["grass_block_top", "grass_block_side", "grass_block_side"],
  grass_slab: ["grass_block_top", "grass_block_side", "grass_block_side"],
  stone: ["stone", "stone", "stone"],
  oak_log: ["oak_log_top", "oak_log", "oak_log"],
  furnace: ["furnace_top", "furnace_front", "furnace_side"],
  crafting_table: [
    "crafting_table_top",
    "crafting_table_front",
    "crafting_table_side",
  ],
  barrel: ["barrel_top", "barrel_side", "barrel_side"],
  bedrock: ["bedrock", "bedrock", "bedrock"],
  oak_planks: ["oak_planks", "oak_planks", "oak_planks"],
  obsidian: ["obsidian", "obsidian", "obsidian"],
  netherrack: ["netherrack", "netherrack", "netherrack"],
  nether_bricks: ["nether_bricks", "nether_bricks", "nether_bricks"],
  end_stone: ["end_stone", "end_stone", "end_stone"],
  purpur_block: ["purpur_block", "purpur_block", "purpur_block"],
  dragon_egg: ["dragon_egg", "dragon_egg", "dragon_egg"],
  carved_pumpkin: ["pumpkin_top", "carved_pumpkin", "pumpkin_side"],
} as const;
const items = {
  compass: "compass_16",
  experience_bottle: "experience_bottle",
  iron_axe: "iron_axe",
  iron_pickaxe: "iron_pickaxe",
  iron_sword: "iron_sword",
  apple: "apple",
  book: "book",
  leather_boots: "leather_boots",
  diamond: "diamond",
  stick: "stick",
  wooden_pickaxe: "wooden_pickaxe",
  stone_pickaxe: "stone_pickaxe",
  coal: "coal",
  raw_iron: "raw_iron",
  iron_ingot: "iron_ingot",
  bread: "bread",
  iron_chestplate: "iron_chestplate",
  bucket: "bucket",
  water_bucket: "water_bucket",
  lava_bucket: "lava_bucket",
  flint: "flint",
  flint_and_steel: "flint_and_steel",
  diamond_pickaxe: "diamond_pickaxe",
  golden_boots: "golden_boots",
  blaze_rod: "blaze_rod",
  blaze_powder: "blaze_powder",
  gold_ingot: "gold_ingot",
  emerald: "emerald",
  ender_pearl: "ender_pearl",
  ender_eye: "ender_eye",
  bow: "bow",
  arrow: "arrow",
  end_crystal: "end_crystal",
  dragon_breath: "dragon_breath",
  elytra: "elytra",
} as const;
export type MinecraftAsset =
  keyof typeof blocks | keyof typeof items | "red_bed" | "shield";
export const worldIcons: Record<WorldSettings["type"], MinecraftAsset> = {
  survival: "grass_block",
  flat: "grass_slab",
  large_biomes: "oak_log",
  amplified: "stone",
};
export const stageIcons: Record<StageId, MinecraftAsset> = {
  movement: "leather_boots",
  motor: "stick",
  interaction: "iron_pickaxe",
  wood_collection: "iron_axe",
  block_collection: "iron_pickaxe",
  survival: "apple",
  pvp: "iron_sword",
};

/** Actual 1.18.1 textures, rendered as game items or shaded block faces. */
export function MinecraftIcon({
  name,
  size = 24,
  label,
}: {
  name: MinecraftAsset;
  size?: number;
  label?: string;
}) {
  const filterId = `grass-${useId().replaceAll(":", "")}`;
  if (name === "red_bed" || name === "shield") {
    // These items use entity models instead of flat item textures in vanilla.
    // Project their silhouettes with the same locally served Minecraft textures.
    const patternId = `${filterId}-wood`;
    return (
      <svg
        className="minecraft-icon"
        width={size}
        height={size}
        viewBox="0 0 48 48"
        role={label ? "img" : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      >
        <defs>
          <pattern
            id={patternId}
            width="16"
            height="16"
            patternUnits="userSpaceOnUse"
          >
            <image
              href="/minecraft/blocks/oak_planks.png"
              width="16"
              height="16"
            />
          </pattern>
        </defs>
        {name === "shield" ? (
          <>
            <path d="M8 4h32v25L24 44 8 29Z" fill="#b8b8b8" />
            <path d="M12 8h24v19L24 38 12 27Z" fill={`url(#${patternId})`} />
            <path d="M24 8h12v19L24 38Z" fill="#000" opacity=".16" />
          </>
        ) : (
          <>
            <path
              d="M4 26 27 12l17 9v12L21 46 4 37Z"
              fill={`url(#${patternId})`}
            />
            <path d="M4 21 27 7l17 9v12L21 41 4 32Z" fill="#9e2027" />
            <path d="M4 21 27 7l17 9L21 30Z" fill="#c73138" />
            <path d="M18 12 27 7l17 9-9 5Z" fill="#ece9e1" />
            <path
              d="M4 32v9l5-3v-3m30-10v12l5-3V28m-23 13v7l5-3v-7"
              fill={`url(#${patternId})`}
            />
          </>
        )}
      </svg>
    );
  }
  if (name in items)
    return (
      <Image
        className="minecraft-icon minecraft-item"
        src={`/minecraft/items/${items[name as keyof typeof items]}.png`}
        width={size}
        height={size}
        alt={label ?? ""}
        unoptimized
        aria-hidden={label ? undefined : true}
      />
    );
  const faces = blocks[name as keyof typeof blocks];
  const grass = name === "grass_block" || name === "grass_slab";
  const slab = name === "grass_slab";
  const height = slab ? 8 : 26;
  const source = (texture: string) => `/minecraft/blocks/${texture}.png`;
  return (
    <svg
      className="minecraft-icon minecraft-block"
      width={size}
      height={size}
      viewBox={`0 0 48 ${24 + height}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {grass && (
        <defs>
          <filter id={filterId} colorInterpolationFilters="sRGB">
            <feColorMatrix
              type="matrix"
              values="0.57 0 0 0 0  0 0.74 0 0 0  0 0 0.35 0 0  0 0 0 1 0"
            />
          </filter>
        </defs>
      )}
      <image
        href={source(faces[0])}
        width="16"
        height="16"
        transform="matrix(1.5 .75 -1.5 .75 24 0)"
        filter={grass ? `url(#${filterId})` : undefined}
      />
      <image
        href={source(faces[1])}
        width="16"
        height="16"
        transform={`matrix(1.5 .75 0 ${height / 16} 0 12)`}
      />
      <image
        href={source(faces[2])}
        width="16"
        height="16"
        transform={`matrix(1.5 -.75 0 ${height / 16} 24 24)`}
      />
      {grass && (
        <>
          <image
            href={source("grass_block_side_overlay")}
            width="16"
            height="16"
            transform={`matrix(1.5 .75 0 ${height / 16} 0 12)`}
            filter={`url(#${filterId})`}
          />
          <image
            href={source("grass_block_side_overlay")}
            width="16"
            height="16"
            transform={`matrix(1.5 -.75 0 ${height / 16} 24 24)`}
            filter={`url(#${filterId})`}
          />
        </>
      )}
      <polygon
        points={`0,12 24,24 24,${24 + height} 0,${12 + height}`}
        fill="#000"
        opacity=".14"
      />
      <polygon
        points={`24,24 48,12 48,${12 + height} 24,${24 + height}`}
        fill="#000"
        opacity=".28"
      />
    </svg>
  );
}
