import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import type { AgentInputConfig } from "@mlcraft/core";
import { isViewerUsername } from "@mlcraft/core";
import { inputJson } from "./serialize.js";
import { iterators } from "prismarine-world";
export function sightRay(bot: Bot, origin: Vec3, dir: Vec3, distance: number) {
  const iterator = new iterators.RaycastIterator(origin, dir, distance);
  let position: Vec3 | null = origin.floored();
  while (position) {
    const block = bot.blockAt(position);
    if (!block)
      return {
        unknown: true,
        distance: position.distanceTo(origin),
        block: null,
      };
    const intersection = iterator.intersect(block.shapes, position);
    if (intersection)
      return {
        unknown: false,
        distance: intersection.pos.distanceTo(origin),
        block,
      };
    const next = iterator.next();
    position = next ? new Vec3(next.x, next.y, next.z) : null;
  }
  return { unknown: false, distance, block: null };
}
export function entityView(entity: Bot["entity"]) {
  const e = entity as unknown as Record<string, unknown>;
  return inputJson(
    Object.fromEntries(
      [
        "id",
        "uuid",
        "username",
        "name",
        "type",
        "kind",
        "entityType",
        "displayName",
        "position",
        "velocity",
        "yaw",
        "pitch",
        "headYaw",
        "height",
        "width",
        "onGround",
        "metadata",
        "equipment",
        "effects",
        "attributes",
        "health",
        "isValid",
      ]
        .filter((key) => e[key] !== undefined)
        .map((key) => [key, e[key]]),
    ),
  );
}
export function visibleEntities(bot: Bot, limit: number) {
  const origin = bot.entity.position.offset(
    0,
    (bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? 1.62,
    0,
  );
  return Object.values(bot.entities)
    .filter(
      (entity) =>
        entity.id !== bot.entity.id && !isViewerUsername(entity.username),
    )
    .sort(
      (a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin),
    )
    .filter((entity) => {
      const center = entity.position.offset(0, (entity.height ?? 1) / 2, 0),
        delta = center.minus(origin),
        distance = delta.norm();
      const yaw = bot.entity.yaw,
        pitch = bot.entity.pitch,
        forward = new Vec3(
          -Math.sin(yaw) * Math.cos(pitch),
          Math.sin(pitch),
          -Math.cos(yaw) * Math.cos(pitch),
        );
      if (distance > 0 && delta.dot(forward) <= 0) return false;
      if (distance < 0.01) return true;
      const hit = sightRay(bot, origin, delta.scaled(1 / distance), distance);
      return !hit.unknown && hit.distance >= distance - 0.1;
    })
    .slice(0, limit)
    .map((entity) => entityView(entity));
}
export function geometryVision(bot: Bot, limits: AgentInputConfig["limits"]) {
  const width = limits.visionWidth,
    height = limits.visionHeight,
    depth: (number | null)[] = [],
    stateIds: number[] = [],
    entityIds: number[] = [],
    valid: boolean[] = [],
    legend: Record<string, string> = {};
  const yaw = bot.entity.yaw,
    pitch = bot.entity.pitch,
    origin = bot.entity.position.offset(
      0,
      (bot.entity as unknown as { eyeHeight?: number }).eyeHeight ?? 1.62,
      0,
    );
  const forward = new Vec3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    ),
    right = new Vec3(Math.cos(yaw), 0, -Math.sin(yaw)),
    up = right.cross(forward);
  const spread = Math.tan((limits.visionFov * Math.PI) / 360),
    entities = Object.values(bot.entities).filter(
      (entity) =>
        entity.id !== bot.entity.id && !isViewerUsername(entity.username),
    );
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dir = forward
        .plus(right.scaled((((x + 0.5) / width) * 2 - 1) * spread))
        .plus(
          up.scaled(((1 - ((y + 0.5) / height) * 2) * spread * height) / width),
        )
        .normalize();
      const ray = sightRay(bot, origin, dir, limits.visionDistance),
        unknown = ray.unknown,
        hit = ray.block;
      let distance = ray.distance,
        id = 0,
        state = hit?.stateId ?? -1;
      for (const entity of entities) {
        const half = (entity.width ?? 0.6) / 2,
          minimum = entity.position.offset(-half, 0, -half),
          maximum = entity.position.offset(half, entity.height ?? 1.8, half);
        let near = 0,
          far = distance;
        for (const axis of ["x", "y", "z"] as const) {
          if (Math.abs(dir[axis]) < 1e-9) {
            if (origin[axis] < minimum[axis] || origin[axis] > maximum[axis])
              far = -1;
          } else {
            const a = (minimum[axis] - origin[axis]) / dir[axis],
              b = (maximum[axis] - origin[axis]) / dir[axis];
            near = Math.max(near, Math.min(a, b));
            far = Math.min(far, Math.max(a, b));
          }
        }
        if (near <= far && near < distance) {
          distance = near;
          id = entity.id;
          state = -1;
          legend[`entity:${id}`] = entity.name ?? entity.type;
        }
      }
      if (hit && state >= 0) legend[String(state)] = hit.name;
      depth.push(unknown && !id ? null : distance);
      stateIds.push(state);
      entityIds.push(id);
      valid.push(!unknown || !!id);
    }
  return {
    width,
    height,
    fov: limits.visionFov,
    distance: limits.visionDistance,
    origin: inputJson(origin),
    yaw,
    pitch,
    depth,
    stateIds,
    entityIds,
    valid,
    legend,
  };
}
