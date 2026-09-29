# Model architecture and inspection

The **Architecture** dashboard tab shows interactive graphs, module configuration,
input/output shapes, parameter counts and component hyperparameters. Select nodes,
pan, zoom, search modules and export the inspected JSON. Choose the current stage
registry or a specific run. There are no separate diagram files to maintain.

## Sources and accuracy

- **Current registry:** instantiates the registered policy and trainer in a fresh
  isolated process. It does not connect agents, reset policies or perform training.
  Preview caches are invalidated when package source/configuration contents change,
  and expire after thirty seconds to follow external configuration changes.
  The dashboard checks every five seconds. **Refresh inspection** also reconstructs
  the preview, for factories dependent on external files or services. Heavy or lazy
  models should be inspected through an initialized run.
- **Runtime:** reads the actual per-agent policy objects and the shared trainer.
  Samples are taken after generation reset, at step boundaries approximately every
  two seconds, during pauses, after trainer episode updates and after checkpoint
  creation. Long steps delay sampling; the timestamp and stale indicator expose
  that delay. Evaluation includes policies only; environment checks have no active
  model. Identical inspected metadata is grouped; identical architecture does not
  imply identical weights.
- **Finished runs:** show the last saved runtime snapshot, labelled historical.
  Restarting the service retrieves it from the run's `models.json` artifact. Existing
  runs retain their instantiated code; changing a source file affects previews and
  newly started workers. The view does not claim that running objects were hot reloaded.

The built-in policy and trainer are still no-op placeholders, shown with zero
parameters and no learning hyperparameters. Missing, failing, oversized or timed-out
inspectors explicitly show inspection unavailable. Unknown counts stay unknown.

## Connecting your AI once

`Policy` and `Trainer` expose an optional `inspectModel()` method returning
`ModelInspection`, synchronously or asynchronously. Connect this method to the
**actual model and optimizer objects** when implementing your AI. The dashboard
cannot safely infer arbitrary JavaScript/Python execution or an external service's
network from source text. The adapter is the extension point, and subsequently
reads architecture and hyperparameter changes automatically.

For models exposing `layers`, `getConfig()`, `getClassName()`, `countParams()`, shapes
and `trainableWeights[].shape`, the supplied adapter walks native objects:

```ts
import { inspectModuleTree } from "@rlcraft/agents";

inspectModel() {
  // These are your real objects, not duplicated diagram settings.
  return inspectModuleTree(
    this.model,
    this.optimizer.getConfig(),
    "your model framework",
  );
}
```

The adapter reads module configuration, shapes and native counts without copying
weight values. It traverses the current `layers` collection on every sample and
represents shared modules once. Total counts come from the root's native count
method; child counts are not summed, which avoids double counting shared/nested
parameters. A module lacking a root count stays unknown. Edges labelled `contains`
are module hierarchy, not an inferred computation graph.

For another framework, NEAT topology, multiple networks, or an external model
service, implement an adapter returning the shared `ModelInspection` contract from
native modules/connections and the current optimizer/configuration. Return actual
connections for a computation graph. Stable node IDs help retain selection. If a
model is not initialized yet, return `status: "unavailable"` with a reason; never
substitute a planned architecture. Expose trainer algorithm and optimizer values
through its own inspector, and make policy metadata describe the model actually
used by `act()`. Derived placeholder classes must provide their own inspectors.

Inspectors must be lightweight and read-only. They run in the existing isolated
worker; synchronous code can still block its event loop. Async inspection has a
one-second deadline, and a timed-out hook is not called again while it remains in
flight. Preview subprocesses have a ten-second lifetime and a 512 MiB
JavaScript heap limit. JSON metadata is bounded to 512 nodes, 1,024 edges and 128 KiB
per component, with a 1 MiB total snapshot limit. Known credential keys are omitted.
Don't return weights, tensors, arbitrary class instances or large configuration data.
Inspection errors show an unavailable result and do not substitute stale metadata.

## Persistence and API

The worker atomically replaces `ARTIFACT_DIR/<run-id>/models.json` and publishes it
over IPC. The API keeps a bounded cache and reads saved snapshots for older runs.
Model graphs are kept out of the global telemetry payload and SQLite run updates.
When Firebase archiving is enabled, the artifact is included in existing uploads.
Live control still works locally by default.

All endpoints use the existing authenticated dashboard proxy:

| Endpoint                              | Result                                               |
| ------------------------------------- | ---------------------------------------------------- |
| `GET /models`                         | Stage catalog and package code fingerprint           |
| `GET /models/stage/:stage`            | Current factory preview; `?fresh=1` bypasses cache   |
| `GET /models/run/:id`                 | Latest actual run snapshot, or 404 before inspection |
| `GET /runs/:id/artifacts/models.json` | Downloadable saved snapshot                          |

Old runs created before this feature have no model snapshots. No Minecraft plugin
update or server/world change is required for model inspection.
