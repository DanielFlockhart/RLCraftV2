"use client";
import { useState } from "react";
import type { GoalSelectionExample } from "@rlcraft/core";
import fontData from "../public/minecraft/inventory/font.json";
import itemData from "../public/minecraft/inventory/items.json";

const glyphs = fontData as Record<
  string,
  { x: number; y: number; advance: number }
>;
const items = itemData as Record<string, { name: string; icon: string }>;
export const itemName = (id: string) =>
  items[id]?.name ??
  id
    .replace("minecraft:", "")
    .split("_")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
export function inventorySlotPosition(slot: number) {
  if (slot < 9)
    return { x: 8 + slot * 18, y: 142, label: `Hotbar ${slot + 1}` };
  if (slot < 36)
    return {
      x: 8 + ((slot - 9) % 9) * 18,
      y: 84 + Math.floor((slot - 9) / 9) * 18,
      label: `Inventory ${slot - 8}`,
    };
  if (slot === 40) return { x: 77, y: 62, label: "Off-hand", empty: "shield" };
  const empty = ["boots", "leggings", "chestplate", "helmet"][slot - 36];
  return {
    x: 8,
    y: 8 + (39 - slot) * 18,
    label: empty[0].toUpperCase() + empty.slice(1),
    empty,
  };
}
function PixelText({
  text,
  x,
  y,
  dark = false,
  shadow = false,
}: {
  text: string;
  x: number;
  y: number;
  dark?: boolean;
  shadow?: boolean;
}) {
  let cursor = x;
  const letters = [...text].map((character, index) => {
    const glyph = glyphs[character] ?? glyphs["?"];
    const position = cursor;
    cursor += glyph.advance;
    return (
      <svg
        key={index}
        x={position}
        y={y}
        width="8"
        height="8"
        viewBox={`${glyph.x} ${glyph.y} 8 8`}
      >
        <image href="/minecraft/inventory/ascii.png" width="128" height="128" />
      </svg>
    );
  });
  return (
    <g
      className={
        dark
          ? "inventory-text-dark"
          : shadow
            ? "inventory-text-shadow"
            : undefined
      }
    >
      {letters}
    </g>
  );
}

export function PlayerInventory({
  value,
  onSelect,
}: {
  value: GoalSelectionExample["inventory"];
  onSelect?: (slot: number) => void;
}) {
  const [hovered, setHovered] = useState<number>();
  const stacks = new Map(value.slots.map((stack) => [stack.slot, stack]));
  const hoveredStack = hovered === undefined ? undefined : stacks.get(hovered);
  const tooltipPosition =
    hovered === undefined ? undefined : inventorySlotPosition(hovered);
  return (
    <div className="player-inventory-wrap">
      <div className="player-inventory-stage">
        <svg
          className="player-inventory"
          viewBox="0 0 176 166"
          role="group"
          aria-label="Minecraft player inventory"
          onMouseLeave={() => setHovered(undefined)}
        >
          <image
            href="/minecraft/inventory/inventory.png"
            width="256"
            height="256"
          />
          <image
            href="/minecraft/inventory/player.svg"
            x="26"
            y="8"
            width="52"
            height="70"
          />
          <PixelText text="Crafting" x={97} y={8} dark />
          <svg
            x="104"
            y="61"
            width="20"
            height="18"
            viewBox="0 0 20 18"
            aria-hidden="true"
          >
            <image
              href="/minecraft/inventory/recipe_button.png"
              width="256"
              height="256"
            />
          </svg>
          {Array.from({ length: 41 }, (_, slot) => {
            const position = inventorySlotPosition(slot);
            const stack = stacks.get(slot);
            const label = `${position.label} · slot ${slot}${stack ? ` · ${itemName(stack.item)} × ${stack.count}` : " · empty"}`;
            const count = String(stack?.count ?? "");
            const countWidth = [...count].reduce(
              (sum, char) => sum + glyphs[char].advance,
              0,
            );
            return (
              <g
                key={slot}
                role="button"
                tabIndex={0}
                aria-label={label}
                onMouseEnter={() => setHovered(slot)}
                onFocus={() => setHovered(slot)}
                onBlur={() => setHovered(undefined)}
                onClick={() => onSelect?.(slot)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect?.(slot);
                  }
                }}
              >
                {stack && items[stack.item] ? (
                  <image
                    href={items[stack.item].icon}
                    x={position.x}
                    y={position.y}
                    width="16"
                    height="16"
                  />
                ) : !stack && position.empty ? (
                  <image
                    href={`/minecraft/inventory/empty_armor_slot_${position.empty}.png`}
                    x={position.x}
                    y={position.y}
                    width="16"
                    height="16"
                  />
                ) : null}
                {stack && !items[stack.item] && (
                  <PixelText text="?" x={position.x + 5} y={position.y + 4} />
                )}
                {stack && stack.count > 1 && (
                  <>
                    <PixelText
                      text={count}
                      x={position.x + 18 - countWidth}
                      y={position.y + 10}
                      shadow
                    />
                    <PixelText
                      text={count}
                      x={position.x + 17 - countWidth}
                      y={position.y + 9}
                    />
                  </>
                )}
                <rect
                  x={position.x}
                  y={position.y}
                  width="16"
                  height="16"
                  fill={hovered === slot ? "#fff" : "transparent"}
                  fillOpacity={hovered === slot ? 0.45 : 0}
                />
                <title>{label}</title>
              </g>
            );
          })}
        </svg>
        {hoveredStack && tooltipPosition && (
          <div
            className="inventory-tooltip"
            style={{
              left: `${(Math.min(tooltipPosition.x + 10, 100) / 176) * 100}%`,
              top: `${(Math.max(0, tooltipPosition.y - 15) / 166) * 100}%`,
            }}
          >
            <strong>{itemName(hoveredStack.item)}</strong>
            <span>{hoveredStack.item}</span>
            <span>
              {hoveredStack.count} items · slot {hoveredStack.slot}
            </span>
          </div>
        )}
      </div>
      <p className="world-help">
        Selected hotbar slot: {value.selected_hotbar_slot} ·{" "}
        {value.slots.length} occupied slots. Hover for item details; click a
        slot to inspect its data.
      </p>
    </div>
  );
}
