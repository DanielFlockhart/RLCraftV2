# Custom structures and training arenas

Use **Training → Training structure blueprints** to design/save reusable boxes, cages, resource rooms or obstacle arenas. In a new run, enable **Training arena and structures**, choose a saved blueprint and set its world placement. Selecting an arena switches the run to Minecraft mode. Blueprints are copied into the run: changing/deleting a preset does not change queued runs, reruns or recorded experiments.

## Design a cage

Set the interior width/depth/height, then choose floor, walls and roof blocks. The shell adds one block around the sides and one above/below. Glass makes a useful observation cage; use bedrock/barrier for walls agents should not break. Use `minecraft:air` for an open roof or open sides.

Contents use **interior coordinates**, starting at `0,0,0` just above the floor:

- **Block regions:** inclusive From/To coordinates fill a rectangular volume. Add single blocks, resource piles, logs, obstacles, platforms or several regions forming a custom structure. Later regions replace earlier ones; air regions carve spaces.
- **Containers:** place a chest/barrel, then choose its inventory slots, items and quantities. Containers override block regions at their positions. Each container holds up to 27 configured slots.
- **Mobs:** choose cows, pigs, sheep, chickens, zombies, skeletons or spiders, with positions/counts. Minecraft difficulty still applies; hostile mobs do not survive Peaceful. Their normal AI remains active.
- **Spawn:** choose the agent's feet position using coordinates or click the floor-plan preview. The preview can show different heights. Feet/head must be clear, with a supporting block below.

Example: a `7 × 7 × 4` glass cage with a stone floor, a small log stack at interior `0,0,0` through `1,2,0`, a barrel at `6,0,6` stocked with 16 stone, and agent spawn `3,0,3`.

This builder uses ordinary Minecraft 1.18.1 blocks and item stacks. Block states/orientation, custom NBT, enchantments, arbitrary entity types and imported WorldEdit/structure files are not supported yet. Several regions can form more complex layouts without editing code.

## Place an experiment

Select **Separate cell for each agent** to repeat the blueprint in a grid, or **One shared arena** to put all agents into one structure. Set grid columns and spacing, and choose the **world origin**, which is the outside corner of the floor. An agent's absolute feet position is:

```text
cell origin + (1 + spawn X + 0.5, 1 + spawn Y, 1 + spawn Z + 0.5)
```

For a default flat world with ground at Y `-60`, an outside floor corner at Y `-61` puts spawn Y `0` at ground height. Different flat layers/terrain need their own placement. The dashboard shows world bounds before submission. Starting inventory presets remain separate; remove their custom spawn when using an arena.

Arena runs require the owned Minecraft server with the updated plugin. Finish/cancel live runs and stop Minecraft, restart the control/dashboard services to load the update, use **Minecraft server → Prepare/update server**, then start Minecraft. **Arena support: ready** confirms the plugin is loaded. Changing the whole terrain type/seed remains a separate stopped-server operation under Training worlds.

## Build and reset behavior

Starting a run replaces blocks and clears **non-player entities inside each cell's bounded volume**, then creates its configured contents. Players are never cleared. An unrelated player standing inside the volume causes preparation to fail; ChilledVibe remains a protected spectator and may observe inside it. Neighboring blocks/inventories outside cell bounds receive no direct edits. Chunk loading may generate nearby terrain, and normal Minecraft physics/mob AI continues after preparation: open/breakable structures do not provide permanent containment.

Choose **Before every episode** to rebuild the original blocks, restock containers, clear existing arena drops/mobs and respawn configured mobs. Agents already in the run are held/protected while their cells are rebuilt, then returned to their configured spawns. Their original invulnerability state is restored. Starting inventory/vitals follow the separate starting-setup frequency (default: every generation). Dead agents respawn before generation preparation. All agents return to the arena spawn each generation, including when terrain reset is disabled. Rebuilding does not reset the whole world.

Choose **Once before the run** to preserve terrain/container changes between episodes. Completed arenas remain in the world for inspection. A later run may reuse the same location and overwrite its cells again. No automatic teardown or rollback is performed. Cancelling stops preparation and releases temporary chunk tickets; a partially built structure may remain.

Active/queued arena footprints cannot overlap. Concurrent arena and unrestricted Minecraft runs are blocked because they share a world. Simulator runs can continue independently. Disjoint arenas still share server resources and Minecraft time; pause stops agent ticks rather than world simulation.

## Limits and persistence

- Interior dimensions: width/depth `3–32`, height `3–16`.
- Up to 32 regions, 8 stocked containers and 16 mobs per cell.
- At most 524,288 shell/interior blocks and 128 configured mobs across a run. A Phase 3A motor session uses 8,092 blocks per isolated agent, so its standard layout fits 64 agents.
- The configured `MAX_AGENTS` default is 64. It applies across active workers; Minecraft's player-slot limit and the separate Fabric rendered-client limit do not raise it.
- Up to 100 saved blueprints. Cells use the configured agent capacity; 100 player slots do not automatically increase worker limits.

The plugin loads chunks asynchronously and performs up to 512 block placements per job per server tick. Preparation has a 300-second deadline. Motor sessions build their terrain once and teleport agents back to their spawn each generation; they do not rebuild the unchanged terrain each generation. This reduces repeated work but does not guarantee a particular TPS under all workloads.

Blueprints live in SQLite under `DATA_DIR`, independently of world profiles. `config.json` stores the full run blueprint, origin, layout and reset frequency alongside its world generation and starting kit. Agent telemetry includes current position. If Firebase archiving is enabled, blueprint presets and run configurations are archived too. Include the database, run artifacts and server world directory in migration/backups.

`npm run arenas:verify` runs inventory and arena checks in a temporary Paper world/port. It checks individual/shared layouts, blocks, container restocking, mob respawn, episode rebuilding, occupied-player rejection, cancellation, overlap checks, viewer preservation and outside sentinel blocks. The running training world is left alone.
