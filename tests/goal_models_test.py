"""Meaningful training/inference checks, invoked from the Node test suite."""
import importlib.util
import json
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/learning/phase1a.py"
spec = importlib.util.spec_from_file_location("goal_learning", SCRIPT)
learning = importlib.util.module_from_spec(spec)
spec.loader.exec_module(learning)
teacher = learning.load_teacher(learning.TEACHER)


class GoalModelTests(unittest.TestCase):
    def test_features_use_only_inputs_and_preserve_stack_equivalence(self):
        encoder = learning.StateEncoder(teacher)
        state = teacher.MinecraftState(cobblestone=8, sticks=2, crafting_table=1)
        original = teacher.encode_example(state, 5, random.Random(42))
        split = teacher.encode_example(state, 5, random.Random(43), "repeated_partial")
        split["target"] = {"goal": "garbage"}
        split["diagnostics"] = {"progression_stage": "leaked"}
        self.assertEqual(encoder.features(encoder.state(original)), encoder.features(encoder.state(split)))
        split["inventory"]["slots"].append(dict(split["inventory"]["slots"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            encoder.state(split)
        original["context"]["health"] = "20"
        with self.assertRaisesRegex(ValueError, "health"):
            encoder.state(original)

    def test_blocked_only_loss_is_finite_and_has_no_goal_gradient(self):
        torch = learning.torch
        logits = torch.randn(4, len(teacher.GOALS), requires_grad=True)
        blocked = torch.randn(4, requires_grad=True)
        loss = learning.objective_loss(logits, blocked, torch.full((4,), -1), torch.zeros_like(logits), .5)
        self.assertTrue(torch.isfinite(loss))
        loss.backward()
        self.assertEqual(float(logits.grad.abs().sum()), 0)
        self.assertGreater(float(blocked.grad.abs().sum()), 0)

    def test_training_improves_reloads_and_masks_predictions(self):
        with tempfile.TemporaryDirectory() as directory:
            dataset, model = Path(directory) / "dataset", Path(directory) / "model"
            generated = subprocess.run([sys.executable, str(learning.TEACHER), "--output-dir", str(dataset),
                "--train-size", "7000", "--validation-size", "1200", "--test-size", "1200", "--ood-size", "100"], capture_output=True, text=True)
            self.assertEqual(generated.returncode, 0, generated.stderr)
            trained = subprocess.run([sys.executable, str(SCRIPT), "train", "--dataset-dir", str(dataset), "--output-dir", str(model),
                "--epochs", "12", "--patience", "12", "--threads", "1"], capture_output=True, text=True)
            self.assertEqual(trained.returncode, 0, trained.stderr)
            report = json.loads((model / "evaluation.json").read_text())
            self.assertLess(report["splits"]["validation"]["loss"], report["baseline_validation"]["loss"])
            self.assertGreater(report["splits"]["test"]["top1"], .65)
            self.assertEqual(report["splits"]["test"]["masked_invalid_rate"], 0)
            self.assertEqual(report["splits"]["ood_test"]["rows"], 100)
            self.assertTrue(report["slot_order_invariant"])
            self.assertTrue(all(value == 0 for value in report["input_overlap"].values()))
            predictor = learning.GoalPredictor(model)
            second = learning.GoalPredictor(model)
            for state in [teacher.MinecraftState(wood_accessible=False), teacher.MinecraftState(logs=128),
                          teacher.MinecraftState(iron_pickaxe=3), teacher.MinecraftState(furnace=1)]:
                example = teacher.encode_example(state, 5, random.Random(17))
                prediction = predictor.predict(example)
                self.assertEqual(prediction["probabilities"], second.predict(example)["probabilities"])
                self.assertTrue(all(prediction["valid_goals"][goal["goal"]] for goal in prediction["ranked_goals"]))
                self.assertTrue(all(value == 0 for name, value in prediction["probabilities"].items() if not prediction["valid_goals"][name]))
                if not any(prediction["valid_goals"].values()):
                    self.assertIsNone(prediction["goal"])
                    self.assertEqual(prediction["status"], "blocked")
                else:
                    self.assertAlmostEqual(sum(prediction["probabilities"].values()), 1, places=6)
            state = teacher.MinecraftState(cobblestone=8)
            first = teacher.encode_example(state, 5, random.Random(5))
            rearranged = teacher.encode_example(state, 5, random.Random(6), "repeated_single")
            self.assertEqual(predictor.predict(first)["probabilities"], predictor.predict(rearranged)["probabilities"])
            # The CLI's standalone prediction has the same contract.
            example_path = Path(directory) / "example.json"
            example_path.write_text(json.dumps(first))
            result = subprocess.run([sys.executable, str(SCRIPT), "predict", "--model-dir", str(model), "--example", str(example_path)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["probabilities"], predictor.predict(first)["probabilities"])
            fine = Path(directory) / "fine"
            result = subprocess.run([sys.executable, str(SCRIPT), "train", "--dataset-dir", str(dataset), "--output-dir", str(fine),
                "--parent-dir", str(model), "--parent-id", "parent-test", "--epochs", "2", "--learning-rate", "0.0001", "--threads", "1"], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = json.loads((fine / "config.json").read_text())
            fine_report = json.loads((fine / "evaluation.json").read_text())
            self.assertEqual(config["parent_checkpoint_hash"], learning.digest(model / "checkpoint.pt"))
            self.assertEqual(config["parent_model_id"], "parent-test")
            self.assertEqual(config["training_mode"], "fine_tune")
            self.assertAlmostEqual(fine_report["baseline_validation"]["loss"], report["splits"]["validation"]["loss"], places=6)
            self.assertLessEqual(fine_report["splits"]["validation"]["loss"], fine_report["baseline_validation"]["loss"] + 1e-6)
            learning.GoalPredictor(fine).predict(first)
            continued = Path(directory) / "continued"
            result = subprocess.run([sys.executable, str(SCRIPT), "train", "--dataset-dir", str(dataset), "--output-dir", str(continued),
                "--parent-dir", str(model), "--parent-id", "resume-test", "--continue-training", "--epochs", "2", "--threads", "1"], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = json.loads((continued / "config.json").read_text())
            self.assertEqual(config["training_mode"], "continue")
            self.assertTrue(config["optimizer_restored"])
            old_state = learning.torch.load(model / "training-state.pt", weights_only=True)
            new_state = learning.torch.load(continued / "training-state.pt", weights_only=True)
            old_step = next(iter(old_state["optimizer"]["state"].values()))["step"]
            new_step = next(iter(new_state["optimizer"]["state"].values()))["step"]
            selected_epoch = json.loads((continued / "evaluation.json").read_text())["best_epoch"]
            self.assertEqual(new_step, old_step + selected_epoch * 28)
            self.assertEqual(new_state["checkpoint_hash"], learning.digest(continued / "checkpoint.pt"))
            import shutil
            legacy = Path(directory) / "legacy"
            shutil.copytree(model, legacy)
            (legacy / "training-state.pt").unlink()
            fallback = Path(directory) / "fallback"
            result = subprocess.run([sys.executable, str(SCRIPT), "train", "--dataset-dir", str(dataset), "--output-dir", str(fallback),
                "--parent-dir", str(legacy), "--parent-id", "legacy-test", "--continue-training", "--epochs", "1", "--threads", "1"], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads((fallback / "config.json").read_text())["optimizer_restored"])
            learning.GoalPredictor(fallback).predict(first)


if __name__ == "__main__":
    unittest.main()
