# Dataset generators

Open **Datasets** in the dashboard to configure and run Phase 1A. It uses Python
3.10 or newer and the standard library. Python runs on the **control host**; set
`PYTHON_PATH` in `.env` if its executable is not on PATH. The control Docker image
includes Python. One dataset generator runs at a time, separately from Minecraft.

The supplied draft ended mid-function. `scripts/datasets/phase1a.py` preserves its
state model, validity rules and utility teacher and completes boundary sampling,
CSV export and the CLI. These are high-level goal labels. The existing trainers
are not automatically connected to the generated files.

## Parameters and output

Configure split sizes, seed, boundary sampling fraction, teacher softmax
temperature and maximum sampling attempts. Zero produces a header-only split.
Each job requests 1–2,000,000 new rows and has a one-hour limit. Boundary sampling
uses values near crafting thresholds. OOD examples use 65–256 logs, outside
training's maximum of 64; other features use the configured sampling mixture.

Files live at `ARTIFACT_DIR/datasets/<job-id>/output/`: `train.csv`,
`validation.csv`, `test.csv`, `ood_test.csv` and `metadata.json`. Downloads appear
after successful completion. CSVs contain state fields, preferred goal ID/name,
diagnostic progression stage, goal validity masks and teacher probabilities.
Choose features deliberately: stage, validity masks and labels are teacher-derived.
Metadata includes goal counts, split sizes, sampling parameters and source hash.

Job records persist parameters, status and the last 100 log lines beside output.
Interrupted jobs become failed on restart. Cancelling or shutting down terminates
Python. Partial files remain for inspection but are unavailable as completed
datasets. Files use the local artifact volume; the training-run Firebase archive
does not currently upload datasets.

## Regenerate and expand

**Rerun** creates a separate version with the same parameters and original parent
for expansion jobs. **Use parameters** loads a job's values for editing before
generating a fresh dataset. Fixed parameters and script produce the same CSVs.

**Expand** copies the completed parent's rows into their original splits, then
adds the requested count to each split. It suggests the next seed and locks the
teacher temperature. Full state rows are unique within and across all splits,
including the parent. Expansion requires the same script hash and version.
Earlier files are preserved. CSV writing is streamed, but deduplication retains
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
