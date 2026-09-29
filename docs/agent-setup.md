# Starting setups and inventory presets

Use **Training → Agent setup presets** to create, update or delete named starting setups. Use the **Starting setup** editor in the new-run dialog to enable a setup, choose a preset, or configure a one-off kit. Saving a preset does not change online players or start training. Each submitted run stores a complete copy of its setup; later preset edits or deletion leave queued runs, history and reruns unchanged.

The editor supports:

- Minecraft 1.18.1 items, quantities and individual hotbar, backpack, armor and off-hand slots.
- Clearing the inventory first or preserving unspecified slots. Specified slots replace their current contents in either case.
- Health, hunger and XP level, with an option to keep current vitals instead.
- Survival, creative, adventure or the world's default game mode, and the selected hotbar slot.
- Optional spawn coordinates in the current world.
- Applying once at connection or again before every episode.

Choose an item from the catalog or enter its `minecraft:` identifier. Unknown items, duplicate slots and quantities exceeding the item's stack size are rejected. Armor slots accept one item. This initial editor handles ordinary item stacks; custom names, enchantments, potion variants and arbitrary NBT are not implemented.

All agents in a run receive the same setup. To compare different kits, submit separate runs. Starting items are applied before the initial observation and reward baseline, so receiving a kit does not count as collecting those items. Per-episode kit reapplication restores inventory, selected vitals and the initial/custom spawn position. Without a custom setup, Minecraft runs use empty inventories, full health/food and a reset before every generation. Applying a custom setup only once preserves subsequent state and free-roam position; arena placement still resets every generation. Use the separate [arena builder](arenas.md) to build/rebuild bounded training structures and their contents, or **Minecraft server → Training worlds** for server-wide world changes while Minecraft and live runs are stopped. Arena runs control their own spawn positions: remove a kit's custom spawn when using an arena.

Dead agents stop acting for the remainder of their generation. Surviving agents continue; if everyone dies, the generation ends early with `endedBy: "agents-dead"`. Dead agents respawn before the next generation, then receive its configured reset and placement. Deaths follow the [experiment keep-inventory rule](training-rules.md), which defaults to retaining inventory/XP without ground drops. Reset frequency determines whether the retained kit is cleared or preserved. Per-generation rewards start at zero; agent step counters count the whole run. Completed, cancelled and failed runs disconnect their owned players. Connection loss remains a run failure.

Join as **ChilledVibe**, then use **Watch** in selected-run details or **Watch as ChilledVibe** in Agent fleet. These controls move/follow only the protected spectator. The roster shows players during connection, setup and pauses, before the first training step. Policies produce no movement, mining or combat until implemented.

## Managed Minecraft setup

The Paper plugin applies setups through a console-only command acknowledged by the control service. Workers request changes only for their own generated agent usernames and use the setup recorded by the parent service. Agents receive no operator permissions. ChilledVibe and unrelated players are excluded from this setup path.

For an existing installation, finish or cancel live Minecraft runs and stop Minecraft, then restart the control service and dashboard to load this update. Use **Minecraft server → Prepare/update server** to install/update the plugin, and start Minecraft again. The page shows **Starting inventory support: ready** after the updated plugin loads. Preparation preserves existing worlds and settings. It requires compiler tools (`javac` and `jar` from JDK 17 or newer); Paper 1.18.1 itself still runs with Java 17. EULA acceptance remains an explicit edit in `runtime/server/eula.txt`.

Preparation can use the existing server jar or an optional source jar path on the runtime machine. Preparation, world changes and new live runs cannot overlap. Progress and failures appear in the dashboard logs.

Custom setups work in the simulator and on the Minecraft process managed by the control service. A remotely hosted dashboard can manage kits on its cloud control service in the same way; the control service must own the Java process. Connecting bots directly to an unrelated external Minecraft server does not provide the console protocol needed for these setups.

## Persistence and extension points

Presets live in the control service's SQLite database under `DATA_DIR`. Include that directory in backups and cloud migration. A run's setup is also saved in its downloadable `config.json`, alongside stage and episode settings. The Agents page shows current hunger and observed inventory as workers report updates.

World selection/reset, setup presets, arena resets, stage/component selection, run parameters, spectator watching, queue controls, logs, metrics and managed server preparation/start/stop are dashboard operations. Adding AI policies, rewards, new action types or distributed workers still uses the code extension points described in the README.

Run `npm run agents:verify` for an isolated live check of slot mapping, armor/off-hand items, vitals, spawn, episode reapplication, viewer isolation and the worker-to-server setup protocol. It requires a prepared server and accepted EULA, uses a temporary world/port and does not change the training world.
