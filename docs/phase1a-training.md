# Phase 1A goal prediction

Open **Training stages**, then **Phase 1A · Goal prediction** in the dashboard. Choose a completed Phase 1A JSONL dataset
with non-empty training and validation splits, configure the MLP, and select
**Train new model**, then **Train goal model**. Training is independent of the live Minecraft run scheduler.
The model learns the synthetic teacher's iron-pickaxe progression prior; it is
not yet connected to agent action execution.

## Setup

Python and PyTorch run on the control host. Set `PYTHON_PATH` in `.env` when needed.
CPU training dependencies can be installed using:

```powershell
python -m pip install -r scripts/learning/requirements.txt --index-url https://download.pytorch.org/whl/cpu
npm run dev
```

The Docker control image installs these dependencies into its Python environment.
For CUDA, install the appropriate official CUDA-enabled PyTorch build on the host,
then choose CUDA in the form. CPU is the default. Dependencies are never installed
automatically by a dashboard request.

## Architecture and inputs

The baseline has three 128-wide ReLU hidden layers, dropout 0.1, a 13-goal output
and a separate blocked output. Width, depth and dropout are configurable. Each
item contributes presence, total count / 64 and log-scaled total count; health
and hunger are scaled by 20, while environment/knowledge flags remain booleans.
Identical items are summed across all legal inventory slots. Moving or splitting
stacks preserves predictions exactly. Slot positions remain in the dataset but
are intentionally not features of this totals baseline. Future slot encoders can
use the same prediction contract.

Only inventory and context are inputs. Preferred goals, probabilities, validity
masks and diagnostics never enter the encoder. The objective is fixed to obtaining
an iron pickaxe; expanding to other objectives requires new labels and a
conditioned model. This model does not learn eating, navigation or combat skills.

## Training and evaluation

AdamW minimizes a weighted combination of preferred-goal cross entropy and soft
teacher-distribution cross entropy, plus binary blocked-state loss. The hard
target weight defaults to 0.5. Blocked rows have no goal loss. Checkpoint selection
and early stopping use validation loss; test and OOD metrics are computed only
after selecting the checkpoint. Seeds, split hashes, teacher source and feature
definitions are saved. The loader validates rows against the teacher and rejects
overlapping model inputs across splits. Changed teacher code requires a freshly
generated dataset, preventing training against mismatched rules.

Evaluation reports top-1/top-3 accuracy on non-blocked examples (including COMPLETE),
raw accuracy and invalid selections, masked invalid selections, independent
blocked accuracy/precision/recall, per-goal and per-family performance, defined-case
selection accuracy, a confusion matrix and warm single-example CPU latency.
Latency includes encoding, model execution and the rule mask; it excludes Python
startup, checkpoint loading and network/queue time. Empty test/OOD splits report
zero rows and null metrics rather than fabricated scores.

At prediction time, a frozen copy of the symbolic teacher masks illegal goals.
COMPLETE is a terminal outcome absent from the dataset's action-validity mask:
when an iron pickaxe is owned, the selection mask allows only COMPLETE. Otherwise
it allows the executable action goals. If none are valid, prediction returns
`goal: null`, `status: "blocked"` and zero goal probabilities. The learned blocked
probability is reported independently and does not suppress valid goals. Masked
accuracy therefore measures the combined model-and-rule system; raw accuracy
shows the model alone.

The random splits avoid exact input duplicates but can share equivalent teacher
decisions differing only in currently irrelevant vitals/daytime. These metrics
measure teacher imitation, not full-game planning or generalization to unseen
items. Stronger future evaluations should hold out resource/prerequisite
combinations and measure actual agent outcomes.

## Dashboard and saved artifacts

Each stage has a detail view; the Phase 1A view shows saved models, epoch loss curves, split metrics, goal/family breakdowns, training
logs, cancellation and reruns. **Fine-tune selected model** starts a new model from
the selected checkpoint, with a new optimizer and a reduced learning rate by default.
Architecture and feature mappings remain compatible, and the original checkpoint
is preserved. The starting weights are retained if no epoch improves validation
loss (reported as best epoch 0). **Reload selected checkpoint** reads the saved
weights back into the inference worker, without starting training or changing
model history. Select a completed model and an example from any
Phase 1A dataset to compare the predicted goal with its teacher label beside the
Minecraft inventory. The saved report includes additional metrics and confusion
data. One training process runs at a time, with a six-hour limit. Restarted
unfinished jobs become failed; reruns always create new models.

Fine-tuning records its parent model ID and checkpoint hash in the saved
configuration and displays the lineage in model history. CLI fine-tuning uses
`--parent-dir MODEL_DIRECTORY --parent-id MODEL_ID` with matching architecture
arguments.

**Continue training** starts additional epochs from the selected model using its
original dataset, learning rate and learning settings. It restores the optimizer
and random-number state paired with the selected checkpoint when available.
Older weights-only models use a fresh optimizer. Continuation creates a new model
and loss curve, preserving the original. CLI continuation adds
`--continue-training` to the parent arguments above.

Dashboard fine-tuning accepts the original dataset or one of its expansions,
which preserve split membership. This prevents earlier training examples from
silently becoming evaluation examples in an independently regenerated dataset.
The CLI accepts explicit directories; preserve split membership there as well.

Models are saved under `ARTIFACT_DIR/goal-models/<model-id>/output/`, normally
`data/runs/goal-models/<model-id>/output/`:

- `checkpoint.pt`: selected model weights, loaded with PyTorch's weights-only loader.
- `training-state.pt`: optimizer and random-number state for continuation, paired
  with the selected weights. Older models may not have this artifact.
- `config.json`: architecture, ordered item/goal mappings, feature encoding,
  objective, training parameters and source/dataset hashes.
- `evaluation.json`: final metrics and latency.
- `history.jsonl`: epoch metrics.
- `teacher.py`: frozen repository-owned validity rules.
- `dataset.json`: source dataset metadata.

All are downloadable. Model history is stored separately in `job.json`.

## CLI and agent interface

```powershell
python scripts/learning/phase1a.py train --dataset-dir data/runs/datasets/DATASET_ID/output --output-dir data/models/phase1a-v1 --epochs 30
python scripts/learning/phase1a.py predict --model-dir data/models/phase1a-v1 --example example.json
```

The output directory must be new. For Python agents, instantiate
`scripts.learning.phase1a.GoalPredictor(model_directory)` once and call
`predict({"inventory": ..., "context": ...})`. The control API exposes
`POST /goal-models/<model-id>/predict` with `{"example": {"inventory": ..., "context": ...}}`.
It reuses a persistent CPU inference worker caching up to two models, avoiding
checkpoint reloads for each prediction. Responses contain the objective, chosen
goal/ID, status, masked and raw probabilities, validity mask, ranked valid goals,
learned blocked probability and worker latency. Agent execution remains a later
integration step.
