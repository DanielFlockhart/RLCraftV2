"""Real generator checks, invoked by datasets.test.ts when Python is installed."""
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
            row = module.encode_example(state, 5, random.Random(i + 1000))
            self.assertEqual(module.state_from_example(row), state)
            self.assertEqual(set(row), {"schema_version", "inventory", "context", "target", "diagnostics"})
            self.assertNotIn("logs", row["context"])
            slots = row["inventory"]["slots"]
            self.assertEqual(len({stack["slot"] for stack in slots}), len(slots))
            for stack in slots:
                self.assertTrue(stack["item"].startswith("minecraft:"))
                self.assertTrue(1 <= stack["count"] <= (1 if stack["item"].endswith("pickaxe") else 64))
            probabilities = list(row["target"]["probabilities"].values())
            self.assertAlmostEqual(sum(probabilities), 1)
            self.assertTrue(all(0 <= p <= 1 for p in probabilities))
            for goal, valid in module.valid_goals(state).items():
                if not valid:
                    self.assertEqual(row["target"]["probabilities"][goal.name], 0)
            target = module.Goal(row["target"]["goal_id"])
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
                self.assertEqual((first / f"{split}.jsonl").read_bytes(), (repeat / f"{split}.jsonl").read_bytes())
                self.assertTrue((expanded / f"{split}.jsonl").read_bytes().startswith((first / f"{split}.jsonl").read_bytes()))
                with (expanded / f"{split}.jsonl").open() as handle:
                    for line in handle:
                        row = json.loads(line)
                        state = module.state_from_example(row)
                        self.assertNotIn(state, seen)
                        seen.add(state)
                        self.assertEqual(state.logs > 64, split == "ood_test")
                        if split == "ood_test":
                            logs = [stack for stack in row["inventory"]["slots"] if stack["item"] == "minecraft:oak_log"]
                            self.assertGreaterEqual(len(logs), 2)
                            self.assertTrue(all(stack["count"] <= 64 for stack in logs))
            metadata = json.loads((expanded / "metadata.json").read_text())
            self.assertEqual(metadata["split_sizes"], dict(train=240, validation=60, test=60, ood_test=40))
            self.assertEqual(metadata["schema_version"], 2)
            self.assertNotEqual(self.run_generator(first).returncode, 0)
            self.assertNotEqual(self.run_generator(Path(directory) / "incompatible", "--parent-dir", str(first), "--temperature", "2").returncode, 0)

    def test_cli_rejects_invalid_parameters(self):
        with tempfile.TemporaryDirectory() as directory:
            for extra in [("--train-size", "-1"), ("--temperature", "0"),
                          ("--temperature", "nan"), ("--boundary-fraction", "1.5")]:
                self.assertNotEqual(self.run_generator(Path(directory) / "invalid", *extra).returncode, 0)

    def test_empty_split_and_indexed_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "data"
            result = self.run_generator(output, "--train-size", "520", "--validation-size", "0")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((output / "validation.jsonl").read_bytes(), b"")
            index = json.loads((output / "train.index.json").read_text())
            rows = (output / "train.jsonl").read_bytes().splitlines(keepends=True)
            self.assertEqual(index["rows"], 520)
            self.assertEqual(index["offsets"], [0, sum(map(len, rows[:256])), sum(map(len, rows[:512]))])

    def test_required_matrix_blocked_labels_and_coverage_report(self):
        from collections import Counter
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "data"
            size = len(module.coverage_catalog()) + 600
            result = self.run_generator(output, "--train-size", str(size), "--validation-size", str(size),
                                        "--test-size", str(size), "--ood-size", "80")
            self.assertEqual(result.returncode, 0, result.stderr)
            metadata = json.loads((output / "metadata.json").read_text())
            all_states = set()
            for split in module.SPLITS:
                rows = [json.loads(line) for line in (output / f"{split}.jsonl").read_text().splitlines()]
                report = metadata["coverage"][split]
                self.assertTrue(report["complete"], report["missing_cases"])
                self.assertEqual(report["covered_cases"], len(module.coverage_catalog(split == "ood_test")))
                tagged = Counter(row["diagnostics"].get("coverage_case") for row in rows)
                families = Counter(row["diagnostics"]["sampling_family"] for row in rows)
                self.assertEqual(report["families"], dict(families))
                for case in report["cases"]:
                    self.assertGreater(case["count"], 0)
                    self.assertEqual(case["count"], tagged[case["id"]])
                    self.assertEqual(rows[case["first_index"]]["diagnostics"]["coverage_case"], case["id"])
                blocked = 0
                for row in rows:
                    state = module.state_from_example(row)
                    self.assertNotIn(state, all_states)
                    all_states.add(state)
                    target = row["target"]
                    if target["label_status"] == "blocked":
                        blocked += 1
                        self.assertIsNone(target["goal"])
                        self.assertIsNone(target["goal_id"])
                        self.assertFalse(any(target["valid_goals"].values()))
                        self.assertEqual(sum(target["probabilities"].values()), 0)
                    else:
                        self.assertAlmostEqual(sum(target["probabilities"].values()), 1)
                        self.assertEqual(target["goal_id"], int(module.preferred_goal(state)))
                    if row["diagnostics"]["sampling_family"] == "full":
                        self.assertEqual(len(row["inventory"]["slots"]), 37)
                    layout = row["diagnostics"].get("inventory_layout")
                    slots = {stack["slot"] for stack in row["inventory"]["slots"]}
                    if layout == "hotbar_only": self.assertTrue(all(slot < 9 for slot in slots))
                    if layout == "main_only": self.assertTrue(all(9 <= slot <= 35 for slot in slots))
                    if layout == "offhand_only": self.assertEqual(slots, {40})
                    if layout == "selected_empty": self.assertNotIn(row["inventory"]["selected_hotbar_slot"], slots)
                    if layout == "selected_occupied": self.assertIn(row["inventory"]["selected_hotbar_slot"], slots)
                    if layout.startswith("repeated_"):
                        stacks = row["inventory"]["slots"]
                        counts = Counter(stack["item"] for stack in stacks)
                        repeated = {item for item, count in counts.items() if count > 1}
                        self.assertTrue(repeated)
                        self.assertTrue(any(any(stack["slot"] < 9 for stack in stacks if stack["item"] == item)
                                            and any(9 <= stack["slot"] <= 35 for stack in stacks if stack["item"] == item)
                                            for item in repeated))
                self.assertEqual(report["blocked_rows"], blocked)
                if split != "ood_test":
                    self.assertGreater(blocked, 0)
                    self.assertEqual({row["target"]["goal"] for row in rows if row["target"]["goal"]}, {goal.name for goal in module.GOALS})
                    self.assertTrue(any(not row["inventory"]["slots"] for row in rows))
                    for name in ["furnace", "raw_iron", "iron_ingots"]:
                        item = module.INVENTORY_ITEMS[name][0]
                        self.assertTrue(any({stack["item"] for stack in row["inventory"]["slots"]} == {item} for row in rows))

    def test_repeated_stacks_preserve_totals_and_teacher_labels(self):
        import random
        patterns = {"repeated_partial": (8, [4,4]), "repeated_single": (8, [1]*8),
                    "repeated_full_partial": (65, [1,64]), "repeated_full": (128, [64,64])}
        for layout, (total, expected) in patterns.items():
            state = module.MinecraftState(cobblestone=total)
            for seed in range(10):
                row = module.encode_example(state, 1.0, random.Random(seed), layout)
                self.assertEqual(sorted(stack["count"] for stack in row["inventory"]["slots"]), expected)
                self.assertEqual(module.state_from_example(row), state)
                self.assertEqual(row["target"], module.encode_example(state, 1.0, random.Random(seed))["target"])
                if len(expected) > 2:
                    self.assertIn(40, {stack["slot"] for stack in row["inventory"]["slots"]})
        state = module.MinecraftState(iron_pickaxe=3)
        row = module.encode_example(state, 1.0, random.Random(42), "repeated_tools")
        self.assertEqual([stack["count"] for stack in row["inventory"]["slots"]], [1,1,1])
        self.assertEqual(module.state_from_example(row), state)

    def test_small_splits_report_missing_cases_and_layout_constraints(self):
        import random
        for layout in ["hotbar_only", "main_only", "offhand_only", "selected_empty", "selected_occupied"]:
            inventory = module.inventory_from_state(module.MinecraftState(coal=8), random.Random(42), layout)
            slots = {stack["slot"] for stack in inventory["slots"]}
            if layout == "hotbar_only": self.assertTrue(all(slot < 9 for slot in slots))
            if layout == "main_only": self.assertTrue(all(9 <= slot <= 35 for slot in slots))
            if layout == "offhand_only": self.assertEqual(slots, {40})
            if layout == "selected_empty": self.assertNotIn(inventory["selected_hotbar_slot"], slots)
            if layout == "selected_occupied": self.assertIn(inventory["selected_hotbar_slot"], slots)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "small"
            result = self.run_generator(output, "--train-size", "1")
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((output / "metadata.json").read_text())["coverage"]["train"]
            self.assertFalse(report["complete"])
            self.assertEqual(report["covered_cases"], 1)
            self.assertEqual(len(report["missing_cases"]), report["required_cases"] - 1)

    def test_expansion_fills_parent_coverage_before_random_sampling(self):
        with tempfile.TemporaryDirectory() as directory:
            parent, output = Path(directory) / "parent", Path(directory) / "expanded"
            result = self.run_generator(parent, "--train-size", "600", "--validation-size", "0", "--test-size", "0", "--ood-size", "0")
            self.assertEqual(result.returncode, 0, result.stderr)
            result = self.run_generator(output, "--parent-dir", str(parent), "--seed", "43", "--train-size", "400", "--validation-size", "0", "--test-size", "0", "--ood-size", "0")
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((output / "metadata.json").read_text())["coverage"]["train"]
            self.assertTrue(report["complete"], report["missing_cases"])
            self.assertEqual(sum(report["families"].values()), 1000)
            self.assertTrue((output / "train.jsonl").read_bytes().startswith((parent / "train.jsonl").read_bytes()))

    def test_empty_splits_keep_their_reserved_cases_for_future_expansion(self):
        with tempfile.TemporaryDirectory() as directory:
            parent, output = Path(directory) / "parent", Path(directory) / "expanded"
            result = self.run_generator(parent, "--train-size", "5000", "--validation-size", "0", "--test-size", "0", "--ood-size", "0", "--edge-fraction", "1")
            self.assertEqual(result.returncode, 0, result.stderr)
            states = {module.state_from_example(json.loads(line)) for line in (parent / "train.jsonl").read_text().splitlines()}
            reserved, _ = module.reserved_cases()
            self.assertTrue(states.isdisjoint(set(reserved["validation"].values())))
            result = self.run_generator(output, "--parent-dir", str(parent), "--seed", "43", "--train-size", "0", "--validation-size", str(len(module.coverage_catalog())), "--test-size", "0", "--ood-size", "0")
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((output / "metadata.json").read_text())["coverage"]["validation"]
            self.assertTrue(report["complete"], report["missing_cases"])

if __name__ == "__main__":
    unittest.main()
