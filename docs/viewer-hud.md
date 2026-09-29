# In-game training HUD

ChilledVibe (and other names in the viewer plugin configuration) automatically receives a personal Minecraft sidebar and boss bar when online. The managed control service sends state once a second. Restart both the control service and Minecraft after installing this version; `npm run viewer:build` installs the plugin, or use the dashboard's Prepare/update server while Minecraft is stopped.

The sidebar shows the experiment stage and run ID, execution status/phase, generation number, completed steps, generation elapsed time, configured generation minimum, previous generation length, total runtime, overall progress, agent count, component and world. The boss bar shows current generation step progress and changes color for pause, completion, failure and disconnected control.

**Generation currently means a training episode**, not an evolutionary population generation. Policies/trainers are still placeholders. Terrain world generations are separate from this training counter.

## Timers

- Generation elapsed and previous generation length use measured worker time, including that episode's preparation and trainer work, with acknowledged pauses excluded.
- Generation minimum is the configured step count multiplied by the step wait interval. Preparation, environment calls and training work add time, so it is not a countdown or finish-time prediction. An environment connectivity check has one step per episode.
  The interval includes the effective sampling speed. A timed generation shows an **Active limit** instead, and its boss bar uses active training time. The sidebar also displays requested/effective sampling pace. See [training playback controls](playback.md).
- Total runtime begins in the worker, includes initial arena setup/agent connection and pauses, and excludes time spent queued. Timers stop when the run ends; interrupted runs retain the last recorded timing rather than adding time spent offline.
- Completed episode durations and total elapsed time are also saved in `episodes.jsonl`. Current timing is persisted with the run and included in the optional Firebase archive. Older runs without timing display `--`.

## Choose an experiment

| Minecraft command                      | Effect                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/rlcrafthud auto` or `/rlcrafthud on` | Follow the experiment belonging to the agent you are spectating; otherwise show an active experiment, a queued experiment, or the latest finished experiment. |
| `/rlcrafthud next`                     | Cycle through available Minecraft experiments and pin the selected run.                                                                                       |
| `/rlcrafthud abcdef12`                 | Pin the experiment matching a unique run ID prefix of at least six characters.                                                                                |
| `/rlcrafthud off`                      | Hide both displays and restore your previous scoreboard.                                                                                                      |

Use `/spectate <agent-username>` to watch an agent's camera. Manual selection overrides automatic following until you use `auto` again. Up to 16 experiments are available, with active runs prioritized over queued and finished runs. Simulator runs are omitted. Viewer choices survive player reconnects during the same Minecraft process; restart returns to automatic mode. A pinned run that leaves the bounded list displays “Selected run unavailable.”

The HUD is a private scoreboard and per-player boss bar. It does not write to the world/main scoreboard, spawn entities, change inventories, or send its scoreboard/boss bar to agents. Hidden mode restores the previous scoreboard when this plugin still owns the current one. State older than five seconds displays “Control disconnected” and retains the last received values. The sync command is console-only and payloads are bounded; regular agent players cannot change viewer selection or submit training state.

`npm run viewer:verify` checks the HUD against an isolated Paper server, including progress/timers, multiple experiments, spectating, pause, hide/show, disconnected control, reconnect and agent isolation. `npm test` also checks worker timing and projections.
