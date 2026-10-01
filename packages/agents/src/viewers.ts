import type { Bot } from "mineflayer";
import { DEFAULT_VIEWERS, isViewerUsername } from "@mlcraft/core";
/** Use this when extending observations or combat targeting with nearby entities.
 * The server also hides viewers from agents, so they are excluded at both layers.
 */
export function trainingEntities(
  bot: Pick<Bot, "entities">,
  viewers: readonly string[] = DEFAULT_VIEWERS,
) {
  return Object.values(bot.entities).filter(
    (entity) => !isViewerUsername(entity.username, viewers),
  );
}
