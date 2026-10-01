# Training world profiles

Open **Minecraft server → Training worlds** in the dashboard. Changes manage only MLCraft's configured `SERVER_DIR`; the original RLCraft server remains separate. On an existing installation, stop Minecraft normally, stop/restart `npm run dev` to load the updated control service, then open the world controls.

1. Finish or cancel queued/active Minecraft runs, including paused ones.
2. Click **Stop server** and wait for `stopped`, allowing the world to save.
3. Select a saved profile/generation or create a new one. Set terrain, seed, difficulty, agent game mode and generated structures. Superflat also offers a biome and editable block layers from bottom to top.
4. Click **Start server**. Reconnect ChilledVibe to view the experiment and submit your live training runs.

The server is deliberately kept stopped after changes, so you can review selections before it generates or loads terrain. Simulator runs remain independent and can continue during world changes.

## Terrain and customisation

Supported terrain types are normal Minecraft terrain, superflat, large biomes and amplified. World generation is validated against the current Paper 1.18.1 setup. Block/biome names must be valid Minecraft 1.18.1 identifiers, such as `minecraft:grass_block` or `minecraft:plains`. Flat layers may total at most 384 blocks and use at most 32 layers. Flat structures enable villages where the selected biome supports them; this is not an arbitrary structure generator editor.

Terrain and game mode are separate: normal terrain can be used with creative agents, while superflat can use survival agents. ChilledVibe's viewer protection still forces spectator mode and restores admin permissions. The existing viewer plugin applies `spectatorsGenerateChunks=false` in each world as it loads. Player capacity remains at least 100 and unrelated server settings are preserved.

Leaving the seed blank generates and records a signed 64-bit random seed when creating a generation. Numeric or text seeds are accepted. A run's experiment RNG seed is separate from its Minecraft world seed. Resetting with the same seed repeats terrain generation, not all entity timing, player actions or Minecraft simulation randomness.

## Reset, refresh and restore

- **Create and select profile** makes a named experiment and selects its first generation.
- **Select saved generation** resumes that world's existing state, including its saved terrain and player data.
- **Reset with same seed** selects a new directory using the selected generation's settings/seed. Minecraft generates fresh terrain, dimensions and player state at next startup.
- **Refresh with random seed** selects a fresh generation with a recorded new seed.
- **Apply edits to a fresh generation** uses the form's terrain, seed and rules, preserving the previous generation's configuration and state.

Resets never delete or overwrite old world directories. Each managed generation has its own `rlcraft-<uuid>` directory; Paper's corresponding `_nether` and `_the_end` directories stay with it. Select an older generation to return to it. The previously configured world is adopted as **Existing training world**; its actual seed is read from `level.dat` when available, preserving full 64-bit precision. Reading the catalog does not change its properties or world files.

Earlier generations are retained working worlds, rather than immutable snapshots: loading one resumes it and subsequent play can change it. There is no automatic disk cleanup. Use stopped-server backups for archival and monitor disk use. The catalog currently allows 50 profiles and 500 generations per profile; a filesystem storage/retention UI can be added later.

The manifest is `SERVER_DIR/rlcraft-worlds.json`. Generation settings are recorded there; `server.properties` selects the active directory. Updates use temporary files and atomic replacement, persist new generation metadata before selecting it, and reject overlapping changes. No dimension/world directory is moved or recursively removed by normal management operations.

New Minecraft runs targeting the local managed host record their selected world generation/settings in run history and `config.json`. Rerunning such a record requires selecting the same generation first. Queued, active and paused Minecraft work blocks switching. External Minecraft servers remain managed externally; these controls do not reset an external host.

## API and cloud storage

Authenticated endpoints are `GET /worlds`, `POST /worlds` (name/settings), `POST /worlds/:id/activate` (generationId), and `POST /worlds/:id/reset` (generationId, optional randomSeed/settings). The dashboard proxies these through its existing allowlist and Origin check; credentials remain server-side.

Profiles, generations and the manifest all live under `SERVER_DIR`, so the optional cloud server volume carries them together. Copy the complete server directory with Minecraft/control stopped when migrating. Avoid editing `server.properties` or the manifest behind a running control service; use the world controls for tracked experiments.

`npm run worlds:verify` starts a temporary isolated Paper server on an unused local port, using the prepared jar/bootstrap files, installed viewer plugin and existing EULA acceptance. It verifies all four terrain types, custom flat layers/villages/seed, same-seed reset, restoration of a changed block and spectator chunk protection, then stops and removes its temporary test directory. It does not touch the training world. Java 17 and a prepared server are required. `npm test` covers configuration, retained state, validation, API guards and concurrency without a real Minecraft server.
