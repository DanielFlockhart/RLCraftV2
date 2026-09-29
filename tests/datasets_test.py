"""Real generator checks, invoked by datasets.test.ts when Python is installed."""
import csv
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
SCRIPT = Path(__file__).resolve().parents[1] / "scripts/datasets/phase1a.py"
spec = importlib.util.spec_from_file_location("phase1a", SCRIPT)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class DatasetTests(unittest.TestCase):
    def run_generator(self, output, *extra):
        return subprocess.run([sys.executable, str(SCRIPT), "--output-dir", str(output),
                               "--train-size", "120", "--validation-size", "30",
                               "--test-size", "30", "--ood-size", "20", *extra],
                              text=True, capture_output=True)

    def test_teacher_labels_masks_and_probabilities(self):
        import random
        for i in range(400):
            state = module.random_state(random.Random(i))
            if module.preferred_goal(state) is None:
                continue
            row = module.encode_row(state, 5)
            probabilities = [row[f"prob_{goal.name.lower()}"] for goal in module.GOALS]
            self.assertAlmostEqual(sum(probabilities), 1)
            self.assertTrue(all(0 <= p <= 1 for p in probabilities))
            for goal, valid in module.valid_goals(state).items():
                if not valid:
                    self.assertEqual(row[f"prob_{goal.name.lower()}"], 0)
            target = module.Goal(row["preferred_goal"])
            if state.iron_pickaxe:
                self.assertEqual(target, module.Goal.COMPLETE)
            else:
                self.assertTrue(module.valid_goals(state)[target])

    def test_disjoint_reproducible_expansion_and_ood(self):
        with tempfile.TemporaryDirectory() as directory:
            first, repeat, expanded = [Path(directory) / name for name in ("first", "repeat", "expanded")]
            for output in [first, repeat]:
                result = self.run_generator(output)
                self.assertEqual(result.returncode, 0, result.stderr)
            result = self.run_generator(expanded, "--parent-dir", str(first), "--seed", "43")
            self.assertEqual(result.returncode, 0, result.stderr)
            seen = set()
            for split in module.SPLITS:
                self.assertEqual((first / f"{split}.csv").read_bytes(), (repeat / f"{split}.csv").read_bytes())
                with (expanded / f"{split}.csv").open(newline="") as handle:
                    for row in csv.DictReader(handle):
                        state = module.state_from_row(row)
                        self.assertNotIn(state, seen)
                        seen.add(state)
                        self.assertEqual(state.logs > 64, split == "ood_test")
            metadata = json.loads((expanded / "metadata.json").read_text())
            self.assertEqual(metadata["split_sizes"], dict(train=240, validation=60, test=60, ood_test=40))
            self.assertNotEqual(self.run_generator(first).returncode, 0)
            self.assertNotEqual(self.run_generator(Path(directory) / "incompatible", "--parent-dir", str(first), "--temperature", "2").returncode, 0)

    def test_cli_rejects_invalid_parameters(self):
        with tempfile.TemporaryDirectory() as directory:
            for extra in [("--train-size", "-1"), ("--temperature", "0"),
                          ("--temperature", "nan"), ("--boundary-fraction", "1.5")]:
                self.assertNotEqual(self.run_generator(Path(directory) / "invalid", *extra).returncode, 0)

if __name__ == "__main__":
    unittest.main()
