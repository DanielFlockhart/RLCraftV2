# Experiment game rules

Use **New training run → Experiment game rules** to configure the run without editing code. Its full rule snapshot is saved in `config.json`, retained by reruns and included in optional Firebase archiving. Existing runs keep their original settings. Simulator runs record settings but do not simulate Minecraft rule behavior.

## Agent settings

Keep inventory on death, no hunger loss, creeper damage to agents, PvP, fall damage, drowning damage and fire/lava damage apply only to owned training players. ChilledVibe remains a protected spectator and unrelated players keep their normal behavior. Allowed damage remains subject to the server's existing protections; these switches prevent damage rather than bypass other protections.

Keep inventory defaults to on. Switching it off allows item/XP drops on death, even when the world's native `keepInventory` is enabled. Whether the next generation restores a starting kit is a separate choice under Starting inventory. Drops remain in free-roam worlds until collected/despawned; rebuilding an arena clears its bounded contents as usual. No hunger loss prevents food depletion and exhaustion; it preserves the configured starting hunger rather than filling it automatically.

## Shared overworld settings

Difficulty, creeper block damage, daylight/weather cycles, natural mob spawning, mob griefing, fire spread, natural regeneration, mob/block/entity loot, phantom/patrol/trader spawning, random tick speed and spawn radius are shared overworld settings. Boolean native rules default to **Use world setting**; blank numeric fields inherit the world value. Difficulty defaults to **Use world difficulty**. Creeper block damage defaults to allowed by native world rules.

Controls apply before arena preparation and spawning and remain active during pauses. They affect the current overworld, including unrelated players there. Other dimensions keep their native settings. Natural mob spawning rules do not block explicitly configured arena mobs, subject to difficulty. Peaceful can remove hostile mobs, and restoring difficulty cannot bring them back. Restoration does not roll back terrain, loot, mobs or elapsed world time.

Concurrent or queued Minecraft experiments must request identical shared settings. Agent-only settings may differ. The API rejects conflicts before enqueueing and the plugin checks again before applying them. Identical world settings share leases and restore when the final lease exits. Finish/cancel an experiment before submitting an incompatible one.

Previous native values are saved in `plugins/RLCraftViewerGuard/training-world-rules.yml` before changes. They restore on completion, cancellation, failure or plugin shutdown, and recover after a Java crash. A lease expires after 60 seconds without control-service HUD heartbeats. Restoration saves the world before removing its recovery record. Keep the plugin directory with the server volume during backups/cloud migration.

After a crash, start Minecraft once to recover pending rules before switching world profiles. The dashboard blocks world changes while a recovery record remains.

Random tick speed is bounded to `0–100`; spawn radius to `0–128`. Spectator chunk generation and arbitrary unsupported gamerules cannot be overridden. Changing rules is a new-run operation; playback controls do not change the snapshot.

## Updating and verification

Stop Minecraft, restart the control/dashboard services, use **Prepare/update server**, then start Minecraft. Training rules support must be ready for live runs. `npm run agents:verify` uses an isolated temporary server/world to check hunger isolation, inventory-on/off deaths, creeper protection, native settings, conflicts, shared restoration and saved rules.
