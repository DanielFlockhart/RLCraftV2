import type { ArenaSpec, ArenaPoint } from "./index.js";
export function arenaCellOrigin(arena: ArenaSpec, index: number): ArenaPoint {
  const cell = arena.layout === "shared" ? 0 : index;
  return {
    x:
      arena.origin.x +
      (cell % arena.columns) * (arena.blueprint.width + 2 + arena.gap),
    y: arena.origin.y,
    z:
      arena.origin.z +
      Math.floor(cell / arena.columns) *
        (arena.blueprint.depth + 2 + arena.gap),
  };
}
export function arenaSpawn(arena: ArenaSpec, index: number): ArenaPoint {
  const origin = arenaCellOrigin(arena, index);
  return {
    x: origin.x + 1 + arena.blueprint.spawn.x + 0.5,
    y: origin.y + 1 + arena.blueprint.spawn.y,
    z: origin.z + 1 + arena.blueprint.spawn.z + 0.5,
  };
}
export function arenaBounds(arena: ArenaSpec, agents: number) {
  const cells = arena.layout === "shared" ? 1 : agents;
  const columns = Math.min(cells, arena.columns);
  const rows = Math.ceil(cells / arena.columns);
  return {
    min: { ...arena.origin },
    max: {
      x:
        arena.origin.x +
        columns * (arena.blueprint.width + 2 + arena.gap) -
        arena.gap -
        1,
      y: arena.origin.y + arena.blueprint.height + 1,
      z:
        arena.origin.z +
        rows * (arena.blueprint.depth + 2 + arena.gap) -
        arena.gap -
        1,
    },
  };
}
export function arenasOverlap(
  a: ArenaSpec,
  agentsA: number,
  b: ArenaSpec,
  agentsB: number,
) {
  const one = arenaBounds(a, agentsA),
    two = arenaBounds(b, agentsB);
  return (["x", "y", "z"] as const).every(
    (axis) => one.min[axis] <= two.max[axis] && two.min[axis] <= one.max[axis],
  );
}
