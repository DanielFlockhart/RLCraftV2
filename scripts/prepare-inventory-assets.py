"""Extract pinned vanilla inventory assets and project textured item/player models.

No external dependencies; uses the prepared official Minecraft 1.18.1 client JAR.
"""
import base64
import json
import math
import sys
import struct
import zlib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JAR = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data/fabric/minecraft/client-1.18.1.jar"
OUTPUT = ROOT / "apps/dashboard/public/minecraft/inventory"
OUTPUT.mkdir(parents=True, exist_ok=True)


def project(point, yaw, pitch, scale, center):
    x, y, z = point
    x, z = x * math.cos(yaw) + z * math.sin(yaw), -x * math.sin(yaw) + z * math.cos(yaw)
    y, z = y * math.cos(pitch) - z * math.sin(pitch), y * math.sin(pitch) + z * math.cos(pitch)
    return center[0] + x * scale, center[1] - y * scale, z


def quad_image(points, texture, crop, dimensions, opacity=1):
    a, b, c = points[:3]
    width, height = crop[2:]
    transform = [(b[0]-a[0])/width, (b[1]-a[1])/width, (c[0]-a[0])/height,
                 (c[1]-a[1])/height, a[0], a[1]]
    uri = "data:image/png;base64," + base64.b64encode(texture).decode()
    return (f'<g transform="matrix({" ".join(str(v) for v in transform)})" opacity="{opacity}">'
            f'<svg width="{width}" height="{height}" viewBox="{crop[0]} {crop[1]} {width} {height}">'
            f'<image width="{dimensions[0]}" height="{dimensions[1]}" href="{uri}"/></svg></g>')


def font_metrics(png, chars):
    # Read the original RGBA bitmap to preserve Minecraft's proportional advances.
    width, height, depth, color, *_ = struct.unpack(">IIBBBBB", png[16:29])
    if depth != 8 or color != 6:
        raise ValueError("Expected vanilla RGBA ASCII font")
    chunks = []
    cursor = 8
    while cursor < len(png):
        size = int.from_bytes(png[cursor:cursor+4], "big")
        if png[cursor+4:cursor+8] == b"IDAT":
            chunks.append(png[cursor+8:cursor+8+size])
        cursor += size + 12
    raw = zlib.decompress(b"".join(chunks))
    rows = []
    row_width = width * 4
    for y in range(height):
        start = y * (row_width + 1)
        mode, row = raw[start], bytearray(raw[start+1:start+1+row_width])
        previous = rows[-1] if rows else bytearray(row_width)
        for i in range(row_width):
            left = row[i-4] if i >= 4 else 0
            above, upper_left = previous[i], previous[i-4] if i >= 4 else 0
            prediction = left + above - upper_left
            paeth = min([left, above, upper_left], key=lambda value: abs(prediction-value))
            value = [0, left, above, (left+above)//2, paeth][mode]
            row[i] = (row[i] + value) % 256
        rows.append(row)
    metrics = {}
    for gy, line in enumerate(chars):
        for gx, character in enumerate(line):
            occupied = [x for x in range(8) if any(rows[gy*8+y][(gx*8+x)*4+3] for y in range(8))]
            metrics[character] = {"x": gx*8, "y": gy*8, "advance": max(occupied)+2 if occupied else 4}
    return metrics


with zipfile.ZipFile(JAR) as archive:
    prefix = "assets/minecraft/"
    for source, target in [("textures/gui/container/inventory.png", "inventory.png"),
                           ("textures/gui/recipe_button.png", "recipe_button.png"),
                           ("textures/font/ascii.png", "ascii.png"),
                           ("textures/entity/steve.png", "steve.png")]:
        (OUTPUT / target).write_bytes(archive.read(prefix + source))
    providers = json.loads(archive.read(prefix + "font/default.json"))["providers"]
    chars = next(p["chars"] for p in providers if p.get("file") == "minecraft:font/ascii.png")
    (OUTPUT / "font.json").write_text(json.dumps(font_metrics(archive.read(prefix + "textures/font/ascii.png"), chars)))
    names = json.loads(archive.read(prefix + "lang/en_us.json"))
    for slot in ["helmet", "chestplate", "leggings", "boots", "shield"]:
        name = f"empty_armor_slot_{slot}.png"
        (OUTPUT / name).write_bytes(archive.read(prefix + f"textures/item/{name}"))
    manifest = {}
    flat = ["stick", "raw_iron", "iron_ingot", "coal", "charcoal", "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe"]
    for item in flat:
        (OUTPUT / f"{item}.png").write_bytes(archive.read(prefix + f"textures/item/{item}.png"))
        manifest[f"minecraft:{item}"] = {"name": names[f"item.minecraft.{item}"], "icon": f"/minecraft/inventory/{item}.png"}
    blocks = {
        "oak_log": ("oak_log_top", "oak_log", "oak_log"),
        "oak_planks": ("oak_planks", "oak_planks", "oak_planks"),
        "cobblestone": ("cobblestone", "cobblestone", "cobblestone"),
        "crafting_table": ("crafting_table_top", "crafting_table_front", "crafting_table_side"),
        "furnace": ("furnace_top", "furnace_front", "furnace_side"),
    }
    # Vanilla block-item GUI transform: x=30, y=225 degrees, scale=.625.
    for item, textures in blocks.items():
        faces = [
            ([(-8,8,-8), (8,8,-8), (-8,8,8)], textures[0], 1),
            ([(8,8,-8), (-8,8,-8), (8,-8,-8)], textures[1], .8),
            ([(8,8,8), (8,8,-8), (8,-8,8)], textures[2], .6),
        ]
        content = []
        for vertices, texture, shade in faces:
            points = [project(p, math.radians(225), math.radians(30), .625, (8,8)) for p in vertices]
            content.append(quad_image(points, archive.read(prefix + f"textures/block/{texture}.png"), (0,0,16,16), (16,16)))
            if shade != 1:
                a,b,c = points
                d = (b[0]+c[0]-a[0], b[1]+c[1]-a[1])
                polygon = " ".join(f"{p[0]},{p[1]}" for p in [a,b,d,c])
                content.append(f'<polygon points="{polygon}" fill="black" opacity="{1-shade}"/>')
        (OUTPUT / f"{item}.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" style="image-rendering:pixelated">' + "".join(content) + '</svg>')
        manifest[f"minecraft:{item}"] = {"name": names[f"block.minecraft.{item}"], "icon": f"/minecraft/inventory/{item}.svg"}
    (OUTPUT / "items.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # Static default Steve model, built from vanilla skin UVs. It represents the
    # player viewport only, not agent appearance or a sampled data feature.
    skin = archive.read(prefix + "textures/entity/steve.png")
    model = []
    parts = [
        ((-4,24,-4,4,32,4), (8,8,8,8), (0,8,8,8), (8,0,8,8)),
        ((-4,12,-2,4,24,2), (20,20,8,12), (16,20,4,12), (20,16,8,4)),
        ((-8,12,-2,-4,24,2), (44,20,4,12), (40,20,4,12), (44,16,4,4)),
        ((4,12,-2,8,24,2), (36,52,4,12), (32,52,4,12), (36,48,4,4)),
        ((-4,0,-2,0,12,2), (4,20,4,12), (0,20,4,12), (4,16,4,4)),
        ((0,0,-2,4,12,2), (20,52,4,12), (16,52,4,12), (20,48,4,4)),
    ]
    for bounds, front, side, top in parts:
        x0,y0,z0,x1,y1,z1 = bounds
        for vertices, crop, shade in [
            ([(x0,y1,z1),(x1,y1,z1),(x0,y0,z1)],front,1),
            ([(x1,y1,z1),(x1,y1,z0),(x1,y0,z1)],side,.75),
            ([(x0,y1,z0),(x1,y1,z0),(x0,y1,z1)],top,.9),
        ]:
            points = [project(p, math.radians(-18), math.radians(8), 1.65, (26,63)) for p in vertices]
            model.append((sum(p[2] for p in points), quad_image(points,skin,crop,(64,64),shade)))
    (OUTPUT / "player.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 70" style="image-rendering:pixelated">' + "".join(face for _,face in sorted(model)) + '</svg>')
print(f"Prepared vanilla inventory assets at {OUTPUT}")
