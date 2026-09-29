# Minecraft dashboard textures

`inventory/` contains the original 1.18.1 player-inventory GUI, ASCII font,
empty equipment-slot textures, skin and Phase 1A item textures from the prepared
official client JAR. `scripts/prepare-inventory-assets.py` extracts these assets,
projects block item models using the vanilla GUI transform, and builds the static
default Steve viewport. The inspector renders the original panel at its 176×166
logical size, with game slot coordinates and the bitmap font's original advances.
The player/crafting preview is decorative; the actual inventory data is shown in
the storage, hotbar, armour and off-hand slots.

These are the original Minecraft Java Edition 1.18.1 block/item textures, mirrored by [PrismarineJS/minecraft-assets](https://github.com/PrismarineJS/minecraft-assets). Minecraft assets belong to Mojang/Microsoft; this dashboard is an unofficial project.

Pinned source commit: `67c9b138b00a6b67c29ba68dae74c41faef4889d`.

Source paths: `data/1.18.1/blocks/<filename>.png` and `data/1.18.1/items/<filename>.png` at that commit. The texture filenames are preserved in the matching local directories. The dashboard serves these small files locally; it makes no requests to an external asset host when used.

Progress icons also use original textures extracted from the prepared official Minecraft 1.18.1 client JAR (`assets/minecraft/textures/block/` and `item/`). Beds and shields use small SVG silhouettes because vanilla renders these as entity models rather than flat item textures. Every progression milestone and section has an icon mapping in `components/progress-icons.ts`; unknown future entries fall back to the book icon.

`components/minecraft-icon.tsx` renders item textures directly, or projects actual block faces into an isometric cube with normal grass biome tint and face shading. The Superflat icon renders the same textures as a short platform. SVG/CSS preserves pixelated texture rendering. `components/minecraft-select.tsx` provides labeled, keyboard-operated icon dropdowns with arrow keys, Enter/Space, Home/End, Escape and type-to-search.
