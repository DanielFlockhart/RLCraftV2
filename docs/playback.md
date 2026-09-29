# Training speed, generation limits and manual advancement

Use **Training → New run → Training pace and generation length** to select 0.25×, 0.5×, 1×, 2×, 4× or 8× sampling speed. Set the generation limit in completed steps or active training seconds, and optionally start paused after preparation. Select a run to open **Generation and playback controls** for live adjustments.

Generations currently mean training episodes. Policies and trainers remain placeholders.

## What speed controls

The multiplier divides the configured base step wait interval. With a 100ms base interval, 2× requests a 50ms wait. Policy, environment and trainer work adds to that wait, so actual throughput depends on component cost and resources; it is not guaranteed to double.

Simulator waits have a 1ms floor. Minecraft sampling has a 50ms floor, matching one nominal server tick. The dashboard and viewer HUD report requested and effective sampling pace so a capped setting remains visible. For example, a 50ms base interval at 2× still has a 50ms minimum and an effective sampling pace of 1×.

**This does not accelerate or freeze the Minecraft world.** Paper 1.18.1 continues to run physics, mobs, redstone and players at its normal tick rate while agents are paused or their sampling pace changes. Faster sampling can change how much world time an agent sees per observation and therefore changes experiment semantics. Use consistent settings when comparing runs. Minecraft's built-in `/tick` control was introduced in 1.20.3; changing physical simulation speed would need a separate compatible server/mod and agent integration, rather than `randomTickSpeed`, which affects only selected block updates. See [Minecraft 1.20.3 release notes](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-3) and [Paper scheduling](https://docs.papermc.io/paper/dev/scheduler/).

## Generation lengths

- **Steps:** each agent performs the configured number of complete observation/action steps per generation. Changing sampling pace changes the minimum time needed to complete that work.
- **Active seconds:** measured time spent executing training steps, including policy/environment/trainer-observation calls and the step wait. Preparation, acknowledged pauses, inter-generation reporting and artifact writes do not consume this budget. Faster sampling can produce more steps in the same time budget.
- Length edits apply to the current and subsequent generations at the next step boundary. A limit below already completed work ends the current generation rather than undoing work.
- **Extend length:** adds seconds directly to an active-time limit. For a step limit, it adds `ceil(seconds × 1000 / baseStepMs)` steps. The dashboard explains this conversion; it uses the base interval, independently of the speed multiplier.
- Time limits are 0.1–86,400 seconds. Step limits are 1–100,000. Timed generations also stop at 100,000 steps as a safety cap. A full step is allowed to finish past a time limit, so overshoot depends on component execution time.
- Environment connectivity checks always execute one step per generation; their generation limits cannot be extended or changed live.

The viewer's **generation elapsed** clock includes episode preparation/trainer finalization and excludes pauses. It differs from **active training seconds**, which controls a timed limit. Total runtime includes preparation and pauses. The HUD boss bar uses step progress for step limits and active-time progress for time limits.

## Manual controls

Pause a run, or create it with **Start paused after environment preparation**:

| Control                       | Result                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Advance N steps               | Every agent performs exactly N additional steps, then pauses. The budget can cross generation boundaries.                                                                                                                                                |
| Advance N seconds, then pause | Executes steps until their measured active time reaches the increment, then pauses. The budget can cross generations; preparation consumes none of it.                                                                                                   |
| Run to generation boundary    | Completes the remaining work of the current generation, or the next generation if already paused between generations, then pauses.                                                                                                                       |
| End generation now            | Ends the current generation at a step boundary, records a partial result, and pauses before preparing the next generation. No blocks/inventories are changed by this command itself; usual configured resets happen when the next generation is started. |
| Resume continuously           | Clears any remaining manual budget and continues normal training.                                                                                                                                                                                        |

Pausing during a manual advance clears its remaining budget. A new advance requires an acknowledged pause. The final generation completes the run even if a manual budget remains. Initial preparation and connections happen before the first pause, and paused workers continue to reserve scheduler capacity.

## API and provenance

Optional initial `RunSpec` fields are `speed` (default 1), `generationSeconds` and `startPaused` (default false). Existing specs retain step-based limits. `tickMs` remains the base wait interval and `episodes` the generation count.

`POST /runs/:id/playback` accepts one command:

```json
{ "action": "speed", "speed": 2 }
```

```json
{ "action": "length", "unit": "seconds", "value": 60 }
```

```json
{ "action": "length", "unit": "steps", "value": 500 }
```

```json
{ "action": "extend", "seconds": 10 }
```

```json
{ "action": "advance", "unit": "steps", "value": 1 }
```

```json
{ "action": "advance", "unit": "seconds", "value": 5 }
```

```json
{ "action": "advance", "unit": "generation", "value": 1 }
```

```json
{ "action": "end-generation" }
```

Running updates are acknowledged by the owning worker. Queued pace/length edits are saved for launch. Terminal/pausing runs reject changes; overlapping pending updates reject rather than silently replacing each other. The dashboard proxy uses the existing credentials and same-origin protection.

`Run.playback` records current acknowledged settings; the original `Run.spec` remains unchanged. Rerun uses the original spec. `config.json` captures launch settings, `controls.jsonl` records accepted live changes with episode/step/time, and `episodes.jsonl` records actual step counts, active time, generation duration, final playback settings and whether a generation ended by limit or manual request. Playback history is downloadable from run details and included in optional Firebase artifact archival. The history file is empty if no live change occurred.

Validation: `npm test` checks exact step/time budgets, generation crossings, pause/resume, live limit edits and partial results. `npm run arenas:verify` checks manual Minecraft advancement at 2× sampling pace with arena resets. `npm run viewer:verify` checks the in-game capped speed/time-limit display. The production dashboard proxy verification covers acknowledged changes and history downloads.
