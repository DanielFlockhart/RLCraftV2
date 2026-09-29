# Dataset generators

Open **Datasets** in the dashboard to configure and run Phase 1A. It uses Python
3.10 or newer and the standard library. Python runs on the **control host**; set
`PYTHON_PATH` in `.env` if its executable is not on PATH. The control Docker image
includes Python. One dataset generator runs at a time, separately from Minecraft.

The supplied draft ended mid-function. `scripts/datasets/phase1a.py` preserves its
state model, validity rules and utility teacher and completes boundary sampling,
JSONL export and the CLI. These are high-level goal labels. The existing trainers
are not automatically connected to the generated files.

## Parameters and output

Configure split sizes, seed, additional edge-case fraction, boundary sampling fraction, teacher softmax
temperature and maximum sampling attempts. Zero produces an empty split file.
Each job requests 1–2,000,000 new rows and has a one-hour limit. Boundary sampling
uses values near crafting thresholds. OOD examples use 65–256 logs, outside
training's maximum of 64; other features use the configured sampling mixture.

## Representative sampling and edge cases

Generator 2.2 starts each ordinary split with a deterministic, defined matrix of
**970 cases**, covering every one of the 13 goal labels, empty inventories,
single-item inventories (including only furnaces, raw iron, ingots or pickaxes),
crafting quantities immediately below/at/above requirements, missing/owned/nearby
workstations, all supported fuel types and no fuel, tool tiers and resource
access, unusual knowledge flags, surplus inventories and slot arrangements.
Equivalent template states are collapsed rather than counted twice. All 128
combinations of the seven environment/day flags are crossed with health 1/20 and
hunger 0/20. These context cases use a varying coal count to keep splits disjoint
without altering their context cell. The OOD split has a separate 31-case matrix
for log overflow thresholds and inventory layouts.

The remaining rows mix family-balanced edge samples (default 60%) and broad
random samples (40%). The boundary fraction applies within the random portion.
The required matrix is always attempted first, even when the additional edge
fraction is zero. Sparse inventories, repeated tools, large item surpluses,
maximum stacks and 37 occupied storage/off-hand slots receive explicit sampling.
Armour slots remain empty because armour types are outside the current teacher.

Repeated-stack cases explicitly cover each supported item type: two partial
stacks (such as 4 + 4), many single-item stacks, full plus partial stacks
(64 + 1), multiple full stacks (64 + 64), repeated unstackable tools, and
inventories with several repeated item types. Matching stacks occupy both hotbar
and main inventory; examples with at least three matching stacks also use the
offhand. Counts are preserved per slot and summed across slots for the teacher.
Ordinary logs remain at most 64 total; larger log-stack cases belong to OOD.

`metadata.json` reports required/covered/missing cases, counts by sampling family,
goal counts and blocked-row counts for every split. The inspector shows this
report and lets you jump directly to a covered case. A split of at least 970 new
rows covers the ordinary matrix; OOD needs 31. Smaller splits report missing
cases. Expansion keeps the parent's coverage and fills its missing cases first.
Coverage is exhaustive for this defined matrix, not all possible combinations of
all Minecraft items, context, durability or future state variables.

Each split has protected, distinct matrix representatives. Random training rows
cannot consume them, including representatives for currently empty splits. This
keeps later validation/test generation and expansion possible even for small
families such as coal-only slot-layout examples. Matrix states are stable across
seeds; random examples and item placements vary with the selected seed.

States without any valid goal are retained, with `goal: null`, `goal_id: null`,
`label_status: "blocked"`, false validity masks and zero probabilities. They are
not relabelled as an invalid action or as completion. Other rows have
`label_status: "actionable"` or `"complete"`. A trainer must handle blocked rows
explicitly; their probability vector is not an ordinary softmax target.

Files live at `ARTIFACT_DIR/datasets/<job-id>/output/`: `train.jsonl`,
`validation.jsonl`, `test.jsonl`, `ood_test.jsonl` and `metadata.json`. Each line is
a complete JSON example. Inventory uses occupied stacks with namespaced item IDs,
counts and Java player-inventory slot positions; empty slots are omitted. Context
contains health, hunger, time and accessible resources/workstations. Targets
contain the goal ID/name, validity masks and probabilities. The teacher derives
inventory totals internally; aggregate resource columns are not exported.

```json
{
  "schema_version": 2,
  "inventory": {
    "size": 41,
    "selected_hotbar_slot": 0,
    "slots": [{ "item": "minecraft:oak_log", "count": 12, "slot": 4 }]
  }
}
```

This snippet shows only the inventory portion; full records also include
`context`, `target` and `diagnostics`. Slots 0–8 are the hotbar, 9–35 main storage,
36 boots, 37 leggings, 38 chestplate, 39 helmet and 40 off-hand. These are player
storage indices, not network inventory-window slot IDs. Crafting slots are
transient and are not part of the 41-slot schema. Phase 1A leaves armour empty.
Stack limits are respected (64 for resources, 1 for pickaxes); large OOD resource
amounts span multiple slots. Some quantities are divided into smaller stacks.
Layouts are synthetic, deterministic for a seed, and do not affect teacher labels.

Metadata includes coverage, goal counts, split sizes, sampling parameters, slot conventions,
stack limits and source hash. Internal `*.index.json` files enable bounded random
access without loading the full dataset. Choose training features deliberately:
targets and diagnostic progression stage are derived by the teacher.

## Inspect examples

Click **Inspect examples** beside a completed job to open `/datasets/<job-id>`.
Choose a split, go to an example number, step through records or select a random
example. The left panel reproduces the vanilla Java 1.18.1 inventory interface
with original textures, slot positions, item sprites and stack counts. Hover or
focus a slot for details and click it to inspect its stored stack. The right panel
shows the complete stored record and supports copying JSON. Context and teacher
probabilities appear below the inventory. The default Steve and empty crafting
preview are decorative, not sampled features. Assets are served locally.

Older version 1 CSV datasets remain downloadable. Regenerate them to obtain slot
inventories: original slot positions cannot be recovered from aggregate columns.
Version 1 datasets cannot be expanded into the version 2 schema.

Job records persist parameters, status and the last 100 log lines beside output.
Interrupted jobs become failed on restart. Cancelling or shutting down terminates
Python. Partial files remain for inspection but are unavailable as completed
datasets. Files use the local artifact volume; the training-run Firebase archive
does not currently upload datasets.

## Regenerate and expand

**Rerun** creates a separate version with the same parameters and original parent
for expansion jobs. **Use parameters** loads a job's values for editing before
generating a fresh dataset. Fixed parameters and script produce the same JSONL.

**Expand** copies the completed parent's rows into their original splits, then
adds the requested count to each split. It suggests the next seed and locks the
teacher temperature. Teacher states are unique within and across all splits,
including the parent: rearranging identical amounts into different slots cannot
place the same teacher state in both train and test. Expansion requires the same
script hash and version. Earlier records, including their layouts, are preserved
byte-for-byte. JSONL writing is streamed, but deduplication retains
all states in memory; large datasets and expansion chains need more memory.

The teacher remains the draft's utility prior. Random inventories can be unusual;
labels are valid under its rules but do not establish optimal planning. Health
and hunger are present but do not affect utility. Inspect per-goal counts for
class balance and coverage before training.

The CLI also works; choose an output directory that does not already exist:

```powershell
python scripts/datasets/phase1a.py --output-dir data/datasets/manual-v1 --seed 42 --train-size 100000 --validation-size 10000 --test-size 10000 --ood-size 5000
python scripts/datasets/phase1a.py --output-dir data/datasets/manual-v2 --parent-dir data/datasets/manual-v1 --seed 43 --train-size 10000 --validation-size 1000 --test-size 1000 --ood-size 500
```

## Register future scripts

Add a trusted descriptor to `datasetRegistry` in `apps/control/src/datasets.ts`:
ID, version, repository-relative Python script, numeric parameter definitions and
CLI flags, artifact filenames and whether expansion is supported. Forms are
generated from this registry. Browser requests cannot supply scripts or commands.

Scripts receive `--output-dir` and registered flags. They create that directory
and all registered files and exit nonzero on failure. Expansion-capable scripts
accept `--parent-dir`. For progress, print and flush JSON lines such as
`{"split":"train","rows":1000,"total":100000}`. Other output becomes log lines.
Extend the dashboard proxy's artifact allowlist for new filenames and add any
generator-specific validation. Increment versions when changing data contracts.

`npm test` runs the dataset lifecycle and data-property checks when Python is
available. `python tests/datasets_test.py` runs standalone data checks.
