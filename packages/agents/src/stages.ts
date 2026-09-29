import type { Observation, StageId } from "@rlcraft/core";
const count = (o: Observation, pattern: RegExp) =>
  Object.entries(o.inventory).reduce(
    (n, [name, amount]) => n + (pattern.test(name) ? amount : 0),
    0,
  );
/** Stage-specific extension hook. The worker handles agent respawn, starting state,
 * placement and configured arena reconstruction before resetting policies.
 */
export async function prepareStage(_stage: StageId, _episode: number) {}
export function reward(
  stage: StageId,
  before: Observation,
  after: Observation,
) {
  switch (stage) {
    case "movement":
      return Math.hypot(
        after.position.x - before.position.x,
        after.position.z - before.position.z,
      );
    case "wood_collection":
      return Math.max(
        0,
        count(after, /_log$|_stem$/) - count(before, /_log$|_stem$/),
      );
    case "block_collection":
      return Math.max(
        0,
        count(after, /cobblestone|dirt|stone$/) -
          count(before, /cobblestone|dirt|stone$/),
      );
    // Define task-specific survival/combat rewards before training these stages.
    default:
      return 0;
  }
}
