"""Phase 1A supervised MLP, evaluation and reusable masked goal prediction.

Only inventory/context are inputs. Targets and diagnostics never enter features.
Run with --help. CPU is the default; CUDA must be explicitly selected.
"""
import argparse
from collections import Counter, OrderedDict
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import random
import shutil
import sys
import time

try:
    import numpy as np
    import torch
    from torch import nn
    from torch.nn import functional as F
except ImportError as exc:
    raise SystemExit("Install training dependencies on the control host: python -m pip install -r scripts/learning/requirements.txt --index-url https://download.pytorch.org/whl/cpu") from exc

ROOT = Path(__file__).resolve().parents[2]
TEACHER = ROOT / "scripts/datasets/phase1a.py"
VERSION = "1.0.0"
SPLITS = ["train", "validation", "test", "ood_test"]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_teacher(path):
    name = "phase1a_rules_" + digest(path)[:16]
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def emit(event, **values):
    print(json.dumps({"event": event, **values}, allow_nan=False), flush=True)


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf8")
    temporary.replace(path)


def selection_mask(teacher, state):
    # Dataset validity describes executable actions; COMPLETE is a terminal
    # objective outcome, so it is intentionally absent from that action mask.
    if teacher.has_iron_pickaxe(state):
        return [goal == teacher.Goal.COMPLETE for goal in teacher.GOALS]
    valid = teacher.valid_goals(state)
    return [valid.get(goal, False) for goal in teacher.GOALS]


class StateEncoder:
    """Totals baseline: invariant to slot order, arrangement and stack splitting."""
    def __init__(self, teacher, specification=None):
        self.teacher = teacher
        self.specification = specification or {
            "version": 1, "items": list(teacher.INVENTORY_ITEMS),
            "context": list(teacher.CONTEXT_FIELDS),
            "quantity_features": ["present", "total/64", "log1p(total)/log1p(2368)"],
            "objective": "obtain_iron_pickaxe",
        }
        self.size = 3 * len(self.specification["items"]) + len(self.specification["context"])

    def state(self, example):
        # Construct inputs independently of any supplied labels/diagnostics.
        context = example["context"]
        if set(context) != set(self.specification["context"]):
            raise ValueError("Context fields do not match this model")
        for key, value in context.items():
            if key in ["health", "hunger"]:
                if type(value) not in [int, float] or not math.isfinite(value) or not 0 <= value <= 20:
                    raise ValueError(f"Invalid {key}: expected 0..20")
            elif type(value) is not bool:
                raise ValueError(f"Invalid {key}: expected boolean")
        return self.teacher.state_from_example({"schema_version": 2, "inventory": example["inventory"], "context": context})

    def features(self, state):
        values = []
        for key in self.specification["items"]:
            total = getattr(state, key)
            values.extend([float(total > 0), total / 64, math.log1p(total) / math.log1p(2368)])
        values.extend(float(getattr(state, key)) / (20 if key in ["health", "hunger"] else 1) for key in self.specification["context"])
        return values


class GoalMLP(nn.Module):
    def __init__(self, input_size, goals, width=128, layers=3, dropout=.1):
        super().__init__()
        blocks = []
        for _ in range(layers):
            blocks.extend([nn.Linear(input_size, width), nn.ReLU(), nn.Dropout(dropout)])
            input_size = width
        self.encoder = nn.Sequential(*blocks)
        self.goal_head = nn.Linear(width, goals)
        self.blocked_head = nn.Linear(width, 1)

    def forward(self, inputs):
        hidden = self.encoder(inputs)
        return self.goal_head(hidden), self.blocked_head(hidden).squeeze(-1)


def load_split(path, encoder, names, temperature, expected_rows):
    """Preallocated tensors; no list of full JSON records retained in memory."""
    size = expected_rows
    x = torch.empty((size, encoder.size), dtype=torch.float32)
    labels = torch.empty(size, dtype=torch.long)
    probabilities = torch.empty((size, len(names)), dtype=torch.float32)
    masks = torch.empty((size, len(names)), dtype=torch.bool)
    families, cases = [], []
    hasher = hashlib.sha256()
    rows = 0
    with Path(path).open("rb") as handle:
        for raw in handle:
            hasher.update(raw)
            if rows >= size:
                raise ValueError(f"{path.name}: more rows than metadata declares")
            try:
                example = json.loads(raw)
                if example.get("schema_version") != 2:
                    raise ValueError("Expected schema_version 2")
                state = encoder.state(example)
                target = example["target"]
                valid = encoder.teacher.valid_goals(state)
                expected = encoder.teacher.teacher_scores(state, temperature)
                values = [target["probabilities"][name] for name in names]
                validity = [target["valid_goals"][goal.name] for goal in encoder.teacher.ACTION_GOALS]
                if any(type(value) not in [int, float] or not math.isfinite(value) or value < 0 for value in values):
                    raise ValueError("Invalid target probabilities")
                if any(type(value) is not bool for value in validity):
                    raise ValueError("Invalid validity mask")
                if validity != [valid[goal] for goal in encoder.teacher.ACTION_GOALS]:
                    raise ValueError("Validity labels do not match the recorded teacher")
                if any(abs(value - expected[goal]) > 1e-6 for value, goal in zip(values, encoder.teacher.GOALS)):
                    raise ValueError("Probability labels do not match the recorded teacher")
                goal = max(expected, key=expected.get) if any(expected.values()) else None
                if target["goal"] != (goal.name if goal is not None else None) or target["goal_id"] != (int(goal) if goal is not None else None):
                    raise ValueError("Preferred goal does not match the teacher")
                x[rows] = torch.tensor(encoder.features(state))
                labels[rows] = names.index(goal.name) if goal is not None else -1
                probabilities[rows] = torch.tensor(values)
                masks[rows] = torch.tensor(selection_mask(encoder.teacher, state))
                families.append(example.get("diagnostics", {}).get("sampling_family", "unspecified"))
                cases.append(example.get("diagnostics", {}).get("coverage_case"))
                rows += 1
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError(f"{path.name} row {rows + 1}: {exc}") from exc
    if rows != size:
        raise ValueError(f"{path.name}: expected {size} rows, found {rows}")
    return {"x": x, "labels": labels, "probabilities": probabilities, "masks": masks,
            "families": families, "cases": cases, "sha256": hasher.hexdigest()}


def objective_loss(logits, blocked_logits, labels, soft_targets, hard_weight):
    active = labels >= 0
    goal_loss = logits.sum() * 0
    if active.any():
        hard = F.cross_entropy(logits[active], labels[active])
        soft = -(soft_targets[active] * F.log_softmax(logits[active], dim=-1)).sum(-1).mean()
        goal_loss = hard_weight * hard + (1 - hard_weight) * soft
    blocked = F.binary_cross_entropy_with_logits(blocked_logits, (~active).float())
    return goal_loss + blocked


def evaluate(model, data, names, batch_size, device, hard_weight, details=True):
    size = len(data["labels"])
    if size == 0:
        return {"rows": 0, "loss": None, "top1": None, "top3": None, "raw_top1": None,
                "raw_invalid_rate": None, "masked_invalid_rate": None, "blocked_accuracy": None,
                "blocked_precision": None, "blocked_recall": None}
    model.eval()
    results, ranked, unmasked, blocked_scores = [], [], [], []
    loss = 0.0
    with torch.inference_mode():
        for offset in range(0, size, batch_size):
            end = min(offset + batch_size, size)
            logits, blocked = model(data["x"][offset:end].to(device))
            labels = data["labels"][offset:end].to(device)
            loss += float(objective_loss(logits, blocked, labels, data["probabilities"][offset:end].to(device), hard_weight)) * (end - offset)
            raw = logits.argmax(-1).cpu()
            masks = data["masks"][offset:end].to(device)
            scores = logits.masked_fill(~masks, -torch.inf)
            order = scores.argsort(-1, descending=True).cpu()
            prediction = order[:, 0].clone()
            prediction[~masks.any(-1).cpu()] = -1
            results.append(prediction)
            ranked.append(order[:, :min(3, len(names))])
            unmasked.append(raw)
            blocked_scores.append(blocked.sigmoid().cpu())
    predictions = torch.cat(results)
    top3 = torch.cat(ranked)
    raw = torch.cat(unmasked)
    blocked = torch.cat(blocked_scores) >= .5
    labels = data["labels"]
    active = labels >= 0
    actual_blocked = ~active
    correct = predictions == labels
    invalid = ~data["masks"].gather(1, raw[:, None]).squeeze(1)
    tp = int((blocked & actual_blocked).sum())
    def average(values, selection):
        return float(values[selection].float().mean()) if selection.any() else None
    report = {
        "rows": size, "actionable_rows": int(active.sum()), "blocked_rows": int(actual_blocked.sum()),
        "loss": loss / size, "top1": average(correct, active),
        "top3": average((top3 == labels[:, None]).any(-1), active),
        "raw_top1": average(raw == labels, active), "raw_invalid_rate": average(invalid, active),
        "masked_invalid_rate": average(~data["masks"].gather(1, predictions.clamp_min(0)[:, None]).squeeze(1), active),
        "blocked_accuracy": float((blocked == actual_blocked).float().mean()),
        "blocked_precision": tp / int(blocked.sum()) if blocked.any() else None,
        "blocked_recall": tp / int(actual_blocked.sum()) if actual_blocked.any() else None,
    }
    if details:
        report["per_goal"] = {name: {"rows": int((labels == index).sum()), "accuracy": average(correct, labels == index)} for index, name in enumerate(names)}
        report["per_family"] = {}
        for family in sorted(set(data["families"])):
            selection = torch.tensor([value == family for value in data["families"]])
            report["per_family"][family] = {"rows": int(selection.sum()), "goal_accuracy": average(correct, selection & active), "selection_accuracy": average(correct, selection)}
        report["confusion_matrix"] = [[0 for _ in range(len(names) + 1)] for _ in range(len(names) + 1)]
        report["confusion_labels"] = names + ["BLOCKED"]
        for truth, prediction in zip(labels.tolist(), predictions.tolist()):
            report["confusion_matrix"][truth if truth >= 0 else len(names)][prediction if prediction >= 0 else len(names)] += 1
        selected = torch.tensor([bool(value) for value in data["cases"]])
        report["defined_case_selection_accuracy"] = average(correct, selected)
    return report


class GoalPredictor:
    """Load once and reuse. Returns a stable, JSON-serializable agent interface."""
    def __init__(self, model_dir):
        directory = Path(model_dir)
        self.config = json.loads((directory / "config.json").read_text(encoding="utf8"))
        if self.config["model_version"] != VERSION:
            raise ValueError("Unsupported goal model version")
        if digest(directory / "teacher.py") != self.config["teacher_hash"]:
            raise ValueError("Saved teacher hash mismatch")
        self.teacher = load_teacher(directory / "teacher.py")
        self.encoder = StateEncoder(self.teacher, self.config["features"])
        self.names = self.config["goals"]
        self.model = GoalMLP(self.encoder.size, len(self.names), **self.config["architecture"])
        self.model.load_state_dict(torch.load(directory / "checkpoint.pt", map_location="cpu", weights_only=True))
        self.model.eval()

    def predict(self, example):
        started = time.perf_counter()
        state = self.encoder.state(example)
        valid = torch.tensor(selection_mask(self.teacher, state))
        with torch.inference_mode():
            logits, blocked = self.model(torch.tensor([self.encoder.features(state)], dtype=torch.float32))
            raw = logits[0].softmax(-1)
            probabilities = logits[0].masked_fill(~valid, -torch.inf).softmax(-1) if valid.any() else torch.zeros(len(valid))
            order = probabilities.argsort(descending=True)
        ranked = [{"goal": self.names[index], "goal_id": int(self.teacher.GOALS[index]),
                   "probability": float(probabilities[index])} for index in order.tolist() if valid[index]]
        return {
            "model_version": VERSION, "objective": self.config["features"]["objective"],
            "goal": ranked[0]["goal"] if ranked else None,
            "goal_id": ranked[0]["goal_id"] if ranked else None,
            "status": "blocked" if not ranked else "complete" if ranked[0]["goal"] == "COMPLETE" else "actionable",
            "blocked_probability": float(blocked.sigmoid()[0]),
            "probabilities": {name: float(probabilities[index]) for index, name in enumerate(self.names)},
            "raw_probabilities": {name: float(raw[index]) for index, name in enumerate(self.names)},
            "valid_goals": {name: bool(valid[index]) for index, name in enumerate(self.names)},
            "ranked_goals": ranked, "latency_ms": (time.perf_counter() - started) * 1000,
        }


def train(args):
    torch.set_num_threads(args.threads)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = torch.device(args.device)
    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA requested but unavailable. Select CPU or install a CUDA-enabled PyTorch build.")
    directory, output = Path(args.dataset_dir), Path(args.output_dir)
    metadata = json.loads((directory / "metadata.json").read_text(encoding="utf8"))
    teacher = load_teacher(TEACHER)
    if metadata.get("schema_version") != 2 or metadata.get("generator") != "phase1a":
        raise ValueError("Choose a Phase 1A schema-2 JSONL dataset")
    if metadata.get("source_hash") != digest(TEACHER):
        raise ValueError("Dataset teacher source differs from the current generator. Generate a new dataset before training.")
    names = [goal.name for goal in teacher.GOALS]
    if metadata["goals"] != {goal.name: int(goal) for goal in teacher.GOALS}:
        raise ValueError("Unsupported goal mapping")
    encoder = StateEncoder(teacher)
    parent = None
    if args.parent_dir:
        parent = GoalPredictor(args.parent_dir)
        if parent.config["teacher_hash"] != metadata["source_hash"] or parent.config["features"] != encoder.specification or parent.names != names:
            raise ValueError("Fine-tuning requires matching teacher, item/goal mappings and feature definitions")
        if parent.config["architecture"] != {"width": args.width, "layers": args.layers, "dropout": args.dropout}:
            raise ValueError("Fine-tuning must preserve the checkpoint architecture")
    if args.continue_training and not parent:
        raise ValueError("Continuation requires a parent checkpoint")
    training_state = None
    if args.continue_training:
        if parent.config["dataset_metadata_hash"] != digest(directory / "metadata.json"):
            raise ValueError("Continue training on the same dataset; use fine-tuning for expanded datasets")
        for key in ["batch_size", "learning_rate", "hard_weight", "seed"]:
            if parent.config["training"][key] != getattr(args, key):
                raise ValueError(f"Continuation preserves {key}; use fine-tuning to change it")
        state_path = Path(args.parent_dir) / "training-state.pt"
        if state_path.exists():
            training_state = torch.load(state_path, map_location="cpu", weights_only=True)
            if training_state["checkpoint_hash"] != digest(Path(args.parent_dir) / "checkpoint.pt"):
                raise ValueError("Optimizer state does not match the selected checkpoint")
    datasets = {}
    for split in SPLITS:
        emit("loading", split=split)
        datasets[split] = load_split(directory / f"{split}.jsonl", encoder, names, metadata["temperature"], metadata["split_sizes"][split])
    if not len(datasets["train"]["x"]) or not len(datasets["validation"]["x"]):
        raise ValueError("Training requires non-empty train and validation splits")
    # Detect exact feature leakage, including identical teacher states whose
    # stacks have merely been rearranged. Report overlap rather than hiding it.
    feature_sets = {split: {row.numpy().tobytes() for row in data["x"]} for split, data in datasets.items()}
    overlap = {f"{left}/{right}": len(feature_sets[left] & feature_sets[right]) for index, left in enumerate(SPLITS) for right in SPLITS[index + 1:]}
    if any(overlap.values()):
        raise ValueError(f"Overlapping input states across splits: {overlap}")
    del feature_sets
    output.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(TEACHER, output / "teacher.py")
    shutil.copyfile(directory / "metadata.json", output / "dataset.json")
    config = {
        "model_version": VERSION, "dataset_id": args.dataset_id, "dataset_metadata_hash": digest(directory / "metadata.json"),
        "dataset_source_hash": metadata["source_hash"], "teacher_hash": digest(TEACHER),
        "trainer_hash": digest(__file__), "torch_version": str(torch.__version__),
        "parent_model_id": args.parent_id,
        "parent_checkpoint_hash": digest(Path(args.parent_dir) / "checkpoint.pt") if parent else None,
        "training_mode": "continue" if args.continue_training else "fine_tune" if parent else "from_scratch",
        "optimizer_restored": training_state is not None,
        "features": encoder.specification, "goals": names,
        "architecture": {"width": args.width, "layers": args.layers, "dropout": args.dropout},
        "training": {key: getattr(args, key) for key in ["epochs", "batch_size", "learning_rate", "hard_weight", "patience", "seed", "device", "threads"]},
        "split_hashes": {split: data["sha256"] for split, data in datasets.items()},
        "selection": "minimum validation loss; test and OOD are evaluated only after checkpoint selection",
        "validity": "frozen symbolic teacher; learned blocked score is diagnostic and does not override legal goals",
    }
    write_json(output / "config.json", config)
    model = GoalMLP(encoder.size, len(names), **config["architecture"]).to(device)
    if parent:
        model.load_state_dict(parent.model.state_dict())
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    if training_state:
        optimizer.load_state_dict(training_state["optimizer"])
        torch.set_rng_state(training_state["rng_state"])
        if args.device == "cuda" and training_state.get("cuda_rng_state"):
            torch.cuda.set_rng_state_all(training_state["cuda_rng_state"])
    def save_training_state():
        torch.save({"optimizer": optimizer.state_dict(), "rng_state": torch.get_rng_state(),
                    "cuda_rng_state": torch.cuda.get_rng_state_all() if args.device == "cuda" else None,
                    "checkpoint_hash": digest(output / "checkpoint.pt")}, output / "training-state.pt.tmp")
        (output / "training-state.pt.tmp").replace(output / "training-state.pt")
    baseline = evaluate(model, datasets["validation"], names, args.batch_size, device, args.hard_weight, False)
    emit("baseline", validation=baseline)
    best, stale, best_epoch = baseline["loss"] if parent else float("inf"), 0, 0
    if parent:
        # Retain the starting checkpoint if no fine-tuning epoch improves it.
        torch.save({key: value.detach().cpu() for key, value in model.state_dict().items()}, output / "checkpoint.pt")
        save_training_state()
    history = []
    started = time.perf_counter()
    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = 0.0
        data = datasets["train"]
        order = torch.randperm(len(data["x"]))
        for offset in range(0, len(order), args.batch_size):
            indices = order[offset:offset + args.batch_size]
            optimizer.zero_grad(set_to_none=True)
            logits, blocked = model(data["x"][indices].to(device))
            loss = objective_loss(logits, blocked, data["labels"][indices].to(device), data["probabilities"][indices].to(device), args.hard_weight)
            if not torch.isfinite(loss):
                raise ValueError("Non-finite training loss")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5)
            optimizer.step()
            total_loss += float(loss.detach()) * len(indices)
        validation = evaluate(model, datasets["validation"], names, args.batch_size, device, args.hard_weight, False)
        metric = {"epoch": epoch, "train_loss": total_loss / len(order), "validation_loss": validation["loss"],
                  "validation_top1": validation["top1"], "validation_top3": validation["top3"],
                  "validation_blocked_accuracy": validation["blocked_accuracy"], "elapsed_seconds": time.perf_counter() - started}
        history.append(metric)
        with (output / "history.jsonl").open("a", encoding="utf8") as handle:
            handle.write(json.dumps(metric, allow_nan=False) + "\n")
        if validation["loss"] < best - 1e-6:
            best, stale, best_epoch = validation["loss"], 0, epoch
            torch.save({key: value.detach().cpu() for key, value in model.state_dict().items()}, output / "checkpoint.pt.tmp")
            (output / "checkpoint.pt.tmp").replace(output / "checkpoint.pt")
            save_training_state()
        else:
            stale += 1
        emit("epoch", **metric, best_epoch=best_epoch)
        if stale >= args.patience:
            break
    model.load_state_dict(torch.load(output / "checkpoint.pt", map_location=device, weights_only=True))
    reports = {split: evaluate(model, data, names, args.batch_size, device, args.hard_weight) for split, data in datasets.items()}
    predictor = GoalPredictor(output)
    # Single-example, warm CPU end-to-end latency including features/rule mask;
    # import, checkpoint loading, network transport and queue time are excluded.
    example = json.loads((directory / "validation.jsonl").open(encoding="utf8").readline())
    for _ in range(10):
        predictor.predict(example)
    latencies = [predictor.predict(example)["latency_ms"] for _ in range(100)]
    invariant = json.loads(json.dumps(example))
    invariant["inventory"]["slots"].reverse()
    invariance = predictor.predict(example)["probabilities"] == predictor.predict(invariant)["probabilities"]
    report = {"best_epoch": best_epoch, "epochs_completed": len(history), "parameter_count": sum(parameter.numel() for parameter in model.parameters()),
              "training_seconds": time.perf_counter() - started, "baseline_validation": baseline,
              "splits": reports, "input_overlap": overlap, "slot_order_invariant": invariance,
              "latency": {"device": "cpu", "samples": 100, "median_ms": float(np.median(latencies)), "p95_ms": float(np.percentile(latencies, 95)), "includes": "features + model + rule mask; warm process"}}
    write_json(output / "evaluation.json", report)
    emit("completed", best_epoch=best_epoch)


def serve():
    torch.set_num_threads(1)
    cache = OrderedDict()
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            key = request["model_dir"]
            if request.get("reload"):
                replacement = GoalPredictor(key)
                cache[key] = replacement
                cache.move_to_end(key)
                if len(cache) > 2:
                    cache.popitem(last=False)
                emit("prediction", id=request["id"], result={"loaded": True})
                continue
            if key not in cache:
                cache[key] = GoalPredictor(key)
                if len(cache) > 2:
                    cache.popitem(last=False)
            cache.move_to_end(key)
            result = cache[key].predict(request["example"])
            emit("prediction", id=request["id"], result=result)
        except Exception as exc:
            emit("prediction", id=request.get("id"), error=str(exc))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    training = subparsers.add_parser("train")
    training.add_argument("--dataset-dir", required=True)
    training.add_argument("--output-dir", required=True)
    training.add_argument("--dataset-id", default="manual")
    training.add_argument("--parent-dir", help="Completed compatible model to fine-tune")
    training.add_argument("--parent-id")
    training.add_argument("--continue-training", action="store_true", help="Continue with unchanged data/settings and restore optimizer state when available")
    for name, default in [("epochs", 30), ("batch-size", 256), ("width", 128), ("layers", 3), ("patience", 5), ("seed", 42), ("threads", 2)]:
        training.add_argument("--" + name, type=int, default=default)
    for name, default in [("learning-rate", .001), ("dropout", .1), ("hard-weight", .5)]:
        training.add_argument("--" + name, type=float, default=default)
    training.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    prediction = subparsers.add_parser("predict")
    prediction.add_argument("--model-dir", required=True)
    prediction.add_argument("--example", required=True, help="JSON file containing inventory and context")
    subparsers.add_parser("serve")
    args = parser.parse_args()
    if args.command == "train":
        bounds = {"epochs": (1,1000), "batch_size": (8,8192), "width": (16,1024), "layers": (1,8), "patience": (1,100), "seed": (0,2147483647), "threads": (1,16), "learning_rate": (1e-6,.1), "dropout": (0,.8), "hard_weight": (0,1)}
        for name, (low, high) in bounds.items():
            if not low <= getattr(args, name) <= high:
                parser.error(f"{name} must be in {low}..{high}")
        train(args)
    elif args.command == "predict":
        torch.set_num_threads(1)
        print(json.dumps(GoalPredictor(args.model_dir).predict(json.loads(Path(args.example).read_text(encoding="utf8"))), allow_nan=False))
    else:
        serve()


if __name__ == "__main__":
    main()
