"""
Minecraft RL - Phase 1A Synthetic Dataset Generator
====================================================

Goal:
    Generate supervised training data for a Minecraft goal-selection model.

Target progression:
    gather wood
      -> craft planks
      -> craft crafting table
      -> craft sticks
      -> craft wooden pickaxe
      -> mine stone
      -> craft furnace / stone pickaxe
      -> find iron
      -> mine iron
      -> smelt iron
      -> craft iron pickaxe

The generated model target is NOT a low-level action.
It is the high-level progression goal that the agent should pursue.

Output:
    minecraft_phase1_dataset/
        train.csv
        validation.csv
        test.csv
        ood_test.csv
        metadata.json

No external dependencies are required.
"""

from __future__ import annotations

import csv
import json
import math
import random
from dataclasses import asdict, dataclass, fields, replace
from enum import IntEnum
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple


# ============================================================
# CONFIGURATION
# ============================================================

SEED = 42

OUTPUT_DIR = Path("minecraft_phase1_dataset")

TRAIN_SIZE = 100_000
VALIDATION_SIZE = 10_000
TEST_SIZE = 10_000
OOD_SIZE = 5_000

# How many candidate states to generate before giving up.
# Normally not reached.
MAX_GENERATION_MULTIPLIER = 50


# ============================================================
# GOALS
# ============================================================

class Goal(IntEnum):
    GATHER_WOOD = 0
    CRAFT_PLANKS = 1
    CRAFT_TABLE = 2
    CRAFT_STICKS = 3
    CRAFT_WOODEN_PICKAXE = 4
    MINE_STONE = 5
    CRAFT_FURNACE = 6
    CRAFT_STONE_PICKAXE = 7
    FIND_IRON = 8
    MINE_IRON = 9
    SMELT_IRON = 10
    CRAFT_IRON_PICKAXE = 11
    COMPLETE = 12


GOALS = list(Goal)
ACTION_GOALS = [g for g in GOALS if g != Goal.COMPLETE]


# ============================================================
# STATE
# ============================================================

@dataclass(frozen=True)
class MinecraftState:
    # --------------------------------------------------------
    # Inventory resources
    # --------------------------------------------------------

    logs: int = 0
    planks: int = 0
    sticks: int = 0

    cobblestone: int = 0

    raw_iron: int = 0
    iron_ingots: int = 0

    coal: int = 0
    charcoal: int = 0

    # --------------------------------------------------------
    # Utility blocks/items owned
    # --------------------------------------------------------

    crafting_table: int = 0
    furnace: int = 0

    # --------------------------------------------------------
    # Pickaxes
    # --------------------------------------------------------

    wooden_pickaxe: int = 0
    stone_pickaxe: int = 0
    iron_pickaxe: int = 0

    # --------------------------------------------------------
    # Environment / knowledge
    # --------------------------------------------------------

    wood_accessible: bool = True
    stone_accessible: bool = False

    iron_known: bool = False
    iron_accessible: bool = False

    crafting_table_accessible: bool = False
    furnace_accessible: bool = False

    # --------------------------------------------------------
    # Optional world context
    #
    # These aren't currently major progression signals,
    # but are deliberately present so the model begins seeing
    # state variables that may later matter.
    # --------------------------------------------------------

    health: int = 20
    hunger: int = 20

    daytime: bool = True


# ============================================================
# STATE HELPERS
# ============================================================

def has_wooden_or_better_pickaxe(s: MinecraftState) -> bool:
    return (
        s.wooden_pickaxe > 0
        or s.stone_pickaxe > 0
        or s.iron_pickaxe > 0
    )


def has_stone_or_better_pickaxe(s: MinecraftState) -> bool:
    return s.stone_pickaxe > 0 or s.iron_pickaxe > 0


def has_iron_pickaxe(s: MinecraftState) -> bool:
    return s.iron_pickaxe > 0


def has_crafting_table_available(s: MinecraftState) -> bool:
    return s.crafting_table > 0 or s.crafting_table_accessible


def has_furnace_available(s: MinecraftState) -> bool:
    return s.furnace > 0 or s.furnace_accessible


def has_fuel(s: MinecraftState) -> bool:
    # Simplification for Phase 1A.
    #
    # Logs/planks can also be used as furnace fuel in Minecraft.
    return (
        s.coal > 0
        or s.charcoal > 0
        or s.logs > 0
        or s.planks > 0
    )


# ============================================================
# GOAL VALIDITY
# ============================================================

def can_gather_wood(s: MinecraftState) -> bool:
    return s.wood_accessible


def can_craft_planks(s: MinecraftState) -> bool:
    return s.logs >= 1


def can_craft_table(s: MinecraftState) -> bool:
    return s.planks >= 4


def can_craft_sticks(s: MinecraftState) -> bool:
    return s.planks >= 2


def can_craft_wooden_pickaxe(s: MinecraftState) -> bool:
    return (
        s.planks >= 3
        and s.sticks >= 2
        and has_crafting_table_available(s)
    )


def can_mine_stone(s: MinecraftState) -> bool:
    return (
        has_wooden_or_better_pickaxe(s)
        and s.stone_accessible
    )


def can_craft_furnace(s: MinecraftState) -> bool:
    return (
        s.cobblestone >= 8
        and has_crafting_table_available(s)
    )


def can_craft_stone_pickaxe(s: MinecraftState) -> bool:
    return (
        s.cobblestone >= 3
        and s.sticks >= 2
        and has_crafting_table_available(s)
    )


def can_find_iron(s: MinecraftState) -> bool:
    # "Find iron" is treated as an exploration/search objective.
    #
    # Once iron is known, there is no reason to "find" it again.
    return (
        has_stone_or_better_pickaxe(s)
        and not s.iron_known
    )


def can_mine_iron(s: MinecraftState) -> bool:
    return (
        has_stone_or_better_pickaxe(s)
        and s.iron_known
        and s.iron_accessible
    )


def can_smelt_iron(s: MinecraftState) -> bool:
    return (
        s.raw_iron > 0
        and has_furnace_available(s)
        and has_fuel(s)
    )


def can_craft_iron_pickaxe(s: MinecraftState) -> bool:
    return (
        s.iron_ingots >= 3
        and s.sticks >= 2
        and has_crafting_table_available(s)
    )


VALIDITY_FUNCTIONS = {
    Goal.GATHER_WOOD: can_gather_wood,
    Goal.CRAFT_PLANKS: can_craft_planks,
    Goal.CRAFT_TABLE: can_craft_table,
    Goal.CRAFT_STICKS: can_craft_sticks,
    Goal.CRAFT_WOODEN_PICKAXE: can_craft_wooden_pickaxe,
    Goal.MINE_STONE: can_mine_stone,
    Goal.CRAFT_FURNACE: can_craft_furnace,
    Goal.CRAFT_STONE_PICKAXE: can_craft_stone_pickaxe,
    Goal.FIND_IRON: can_find_iron,
    Goal.MINE_IRON: can_mine_iron,
    Goal.SMELT_IRON: can_smelt_iron,
    Goal.CRAFT_IRON_PICKAXE: can_craft_iron_pickaxe,
}


def valid_goals(s: MinecraftState) -> Dict[Goal, bool]:
    return {
        goal: fn(s)
        for goal, fn in VALIDITY_FUNCTIONS.items()
    }


# ============================================================
# PROGRESSION FEATURES
# ============================================================

def progression_stage(s: MinecraftState) -> int:
    """
    Human-readable diagnostic stage.

    This is NOT required as a model input.

    It is useful for:
        - dataset analysis
        - stratification
        - debugging
    """

    if has_iron_pickaxe(s):
        return 11

    if s.iron_ingots >= 3:
        return 10

    if s.raw_iron > 0:
        return 9

    if s.iron_known:
        return 8

    if has_stone_or_better_pickaxe(s):
        return 7

    if s.cobblestone >= 3:
        return 6

    if has_wooden_or_better_pickaxe(s):
        return 5

    if has_crafting_table_available(s) and s.sticks >= 2:
        return 4

    if s.sticks >= 2:
        return 3

    if has_crafting_table_available(s):
        return 2

    if s.planks > 0:
        return 1

    return 0


# ============================================================
# TEACHER
# ============================================================

def teacher_utility(s: MinecraftState, goal: Goal) -> float:
    """
    Returns an unnormalised utility for a goal.

    IMPORTANT:
    ---------
    This teacher is deliberately explicit and interpretable.

    It should eventually be replaced/refined by:
        - better planning logic
        - real player demonstrations
        - RL-derived values
        - learned world models

    For Phase 1A it gives us a strong supervised prior.
    """

    if goal == Goal.COMPLETE:
        return 100.0 if has_iron_pickaxe(s) else -100.0

    validity = valid_goals(s)

    if not validity.get(goal, False):
        return -100.0

    score = 0.0

    # --------------------------------------------------------
    # Final objective
    # --------------------------------------------------------

    if goal == Goal.CRAFT_IRON_PICKAXE:
        score += 100.0

    # --------------------------------------------------------
    # Iron stage
    # --------------------------------------------------------

    elif goal == Goal.SMELT_IRON:
        score += 85.0

        # More raw iron makes smelting increasingly useful.
        score += min(s.raw_iron, 8) * 1.0

    elif goal == Goal.MINE_IRON:
        score += 75.0

        # Stop massively over-mining for this tiny objective.
        if s.raw_iron >= 3:
            score -= 25.0

    elif goal == Goal.FIND_IRON:
        score += 65.0

    # --------------------------------------------------------
    # Stone stage
    # --------------------------------------------------------

    elif goal == Goal.CRAFT_STONE_PICKAXE:
        score += 60.0

        if s.stone_pickaxe > 0 or s.iron_pickaxe > 0:
            score -= 100.0

    elif goal == Goal.CRAFT_FURNACE:
        score += 52.0

        # Furnace is especially valuable if iron is already owned.
        if s.raw_iron > 0:
            score += 20.0

        if has_furnace_available(s):
            score -= 100.0

    elif goal == Goal.MINE_STONE:
        score += 45.0

        # Need 3 for stone pickaxe and 8 for furnace.
        if s.cobblestone < 3:
            score += 12.0
        elif s.cobblestone < 8:
            score += 6.0
        else:
            score -= 15.0

    # --------------------------------------------------------
    # Wooden stage
    # --------------------------------------------------------

    elif goal == Goal.CRAFT_WOODEN_PICKAXE:
        score += 40.0

        if has_wooden_or_better_pickaxe(s):
            score -= 100.0

    elif goal == Goal.CRAFT_STICKS:
        score += 30.0

        if s.sticks < 2:
            score += 12.0

        elif s.sticks < 4:
            score += 3.0

        else:
            score -= 15.0

    elif goal == Goal.CRAFT_TABLE:
        score += 28.0

        if not has_crafting_table_available(s):
            score += 10.0
        else:
            score -= 100.0

    elif goal == Goal.CRAFT_PLANKS:
        score += 20.0

        if s.planks < 4:
            score += 10.0

        if s.planks >= 16:
            score -= 15.0

    elif goal == Goal.GATHER_WOOD:
        score += 10.0

        total_wood_value = s.logs * 4 + s.planks

        if total_wood_value == 0:
            score += 25.0

        elif total_wood_value < 8:
            score += 15.0

        elif total_wood_value < 16:
            score += 5.0

        else:
            score -= 10.0

    # --------------------------------------------------------
    # Context-sensitive modifications
    # --------------------------------------------------------

    # If we already have an iron pickaxe, everything else is
    # irrelevant for the current Phase 1A objective.
    if has_iron_pickaxe(s):
        score -= 100.0

    return score


def softmax(scores: Sequence[float], temperature: float = 5.0) -> List[float]:
    """
    Convert teacher utilities to probabilities.
    """

    scaled = [x / temperature for x in scores]

    max_score = max(scaled)

    exps = [
        math.exp(x - max_score)
        for x in scaled
    ]

    total = sum(exps)

    return [x / total for x in exps]


def teacher_scores(s: MinecraftState, temperature: float = 5.0) -> Dict[Goal, float]:
    """
    Produce a probability distribution over goals.

    Invalid goals receive probability 0.
    """

    if has_iron_pickaxe(s):
        return {
            goal: 1.0 if goal == Goal.COMPLETE else 0.0
            for goal in GOALS
        }

    valid = valid_goals(s)

    candidate_goals = [
        goal
        for goal in ACTION_GOALS
        if valid[goal]
    ]

    # This should be rare, but malformed states shouldn't crash
    # the generator.
    if not candidate_goals:
        return {
            goal: 0.0
            for goal in GOALS
        }

    utilities = [
        teacher_utility(s, goal)
        for goal in candidate_goals
    ]

    probabilities = softmax(utilities, temperature)

    output = {
        goal: 0.0
        for goal in GOALS
    }

    for goal, probability in zip(candidate_goals, probabilities):
        output[goal] = probability

    return output


def preferred_goal(s: MinecraftState) -> Goal | None:
    scores = teacher_scores(s)

    if not scores or max(scores.values()) == 0:
        return None

    return max(scores, key=scores.get)


# ============================================================
# STATE SAMPLING
# ============================================================

RESOURCE_VALUES = [
    0, 0, 0, 0,
    1, 1,
    2, 2,
    3, 3,
    4, 4,
    5,
    7,
    8, 8,
    9,
    12,
    16,
    24,
    32,
    48,
    64,
]


def sample_resource(rng: random.Random) -> int:
    return rng.choice(RESOURCE_VALUES)


def sample_binary_count(rng: random.Random, probability: float = 0.5) -> int:
    return int(rng.random() < probability)


def random_state(rng: random.Random) -> MinecraftState:
    """
    Broad/random state generator.

    This deliberately creates strange combinations.
    """

    iron_known = rng.random() < 0.5

    return MinecraftState(
        logs=sample_resource(rng),
        planks=sample_resource(rng),
        sticks=sample_resource(rng),
        cobblestone=sample_resource(rng),
        raw_iron=sample_resource(rng),
        iron_ingots=sample_resource(rng),
        coal=sample_resource(rng),
        charcoal=sample_resource(rng),

        crafting_table=sample_binary_count(rng, 0.45),
        furnace=sample_binary_count(rng, 0.35),

        wooden_pickaxe=sample_binary_count(rng, 0.30),
        stone_pickaxe=sample_binary_count(rng, 0.25),
        iron_pickaxe=sample_binary_count(rng, 0.10),

        wood_accessible=rng.random() < 0.90,
        stone_accessible=rng.random() < 0.70,

        iron_known=iron_known,
        iron_accessible=iron_known and rng.random() < 0.70,

        crafting_table_accessible=rng.random() < 0.15,
        furnace_accessible=rng.random() < 0.10,

        health=rng.randint(1, 20),
        hunger=rng.randint(0, 20),

        daytime=rng.random() < 0.5,
    )


# ============================================================
# BOUNDARY STATE GENERATOR
# ============================================================

# The supplied draft ended here. Sampling, CLI and export below complete it.
def boundary_state(rng: random.Random) -> MinecraftState:
    thresholds = {
        "logs": [0, 1, 2],
        "planks": [0, 1, 2, 3, 4, 5],
        "sticks": [0, 1, 2, 3],
        "cobblestone": [0, 2, 3, 4, 7, 8, 9],
        "raw_iron": [0, 1, 2, 3, 4],
        "iron_ingots": [0, 1, 2, 3, 4],
    }
    return replace(random_state(rng), **{
        key: rng.choice(values) for key, values in thresholds.items()
    })


SPLITS = ("train", "validation", "test", "ood_test")
STATE_FIELDS = [field.name for field in fields(MinecraftState)]
BOOL_FIELDS = {field.name for field in fields(MinecraftState) if field.type == "bool"}
CSV_FIELDS = STATE_FIELDS + ["progression_stage", "preferred_goal", "preferred_goal_name"] + [
    f"valid_{goal.name.lower()}" for goal in ACTION_GOALS
] + [f"prob_{goal.name.lower()}" for goal in GOALS]
GENERATOR_VERSION = "1.0.0"


def state_from_row(row: dict) -> MinecraftState:
    return MinecraftState(**{
        key: bool(int(row[key])) if key in BOOL_FIELDS else int(row[key])
        for key in STATE_FIELDS
    })


def encode_row(state: MinecraftState, temperature: float) -> dict:
    scores = teacher_scores(state, temperature)
    goal = max(scores, key=scores.get)
    return {
        **{key: int(value) for key, value in asdict(state).items()},
        "progression_stage": progression_stage(state),
        "preferred_goal": int(goal),
        "preferred_goal_name": goal.name,
        **{f"valid_{g.name.lower()}": int(valid) for g, valid in valid_goals(state).items()},
        **{f"prob_{g.name.lower()}": probability for g, probability in scores.items()},
    }


def generate(args) -> dict:
    import hashlib
    from collections import Counter

    output = Path(args.output_dir).resolve()
    # A job is always a new version. Never overwrite an earlier dataset.
    output.mkdir(parents=True, exist_ok=False)
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    parent = Path(args.parent_dir).resolve() if args.parent_dir else None
    if parent:
        parent_meta = json.loads((parent / "metadata.json").read_text())
        if (parent_meta.get("generator_version") != GENERATOR_VERSION
                or parent_meta.get("source_hash") != source_hash
                or parent_meta.get("temperature") != args.temperature):
            raise ValueError("Expansion requires matching generator source and teacher temperature")
    seen: set[MinecraftState] = set()
    parent_counts = {split: 0 for split in SPLITS}
    histograms = {split: Counter() for split in SPLITS}
    if parent:
        # Load all splits before sampling to prevent cross-split duplicates.
        for split in SPLITS:
            with (parent / f"{split}.csv").open(newline="") as source:
                reader = csv.DictReader(source)
                if reader.fieldnames != CSV_FIELDS:
                    raise ValueError("Parent dataset columns do not match the current generator")
                for row in reader:
                    state = state_from_row(row)
                    if state in seen:
                        raise ValueError("Parent contains duplicate states across or within splits")
                    seen.add(state)
                    parent_counts[split] += 1
    requested = dict(zip(SPLITS, [args.train_size, args.validation_size, args.test_size, args.ood_size]))
    for index, split in enumerate(SPLITS):
        # Separate RNG streams keep splits reproducible when other sizes change.
        rng = random.Random(args.seed + index * 1_000_003)
        size = requested[split]
        count = 0
        attempts = 0
        with (output / f"{split}.csv").open("w", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=CSV_FIELDS)
            writer.writeheader()
            if parent:
                with (parent / f"{split}.csv").open(newline="") as source:
                    for row in csv.DictReader(source):
                        writer.writerow(row)
                        histograms[split][row["preferred_goal_name"]] += 1
            print(json.dumps({"split": split, "rows": 0, "total": size}), flush=True)
            while count < size:
                attempts += 1
                if attempts > max(1, size) * args.max_generation_multiplier:
                    raise RuntimeError(f"Could not generate {size} unique labelled states for {split}")
                state = boundary_state(rng) if rng.random() < args.boundary_fraction else random_state(rng)
                if split == "ood_test":
                    # Training resources are at most 64; OOD tests larger inventories.
                    state = replace(state, logs=rng.randint(65, 256))
                if state in seen or preferred_goal(state) is None:
                    continue
                seen.add(state)
                row = encode_row(state, args.temperature)
                writer.writerow(row)
                histograms[split][row["preferred_goal_name"]] += 1
                count += 1
                if count % 1000 == 0 or count == size:
                    print(json.dumps({"split": split, "rows": count, "total": size}), flush=True)
        print(f"Wrote {split}: {parent_counts[split] + count} rows ({count} new)", flush=True)
    metadata = {
        "generator": "phase1a", "generator_version": GENERATOR_VERSION,
        "source_hash": source_hash, "seed": args.seed,
        "temperature": args.temperature, "boundary_fraction": args.boundary_fraction,
        "max_generation_multiplier": args.max_generation_multiplier,
        "requested_new_rows": requested,
        "split_sizes": {split: parent_counts[split] + requested[split] for split in SPLITS},
        "goal_counts": histograms,
        "state_fields": STATE_FIELDS,
        "goals": {goal.name: int(goal) for goal in GOALS},
        "ood_definition": "logs 65..256; other features use the configured sampling mixture",
        "parent": str(parent) if parent else None,
        "target": "high-level progression goal; not a low-level action",
        "teacher": "Interpretable synthetic utility prior; not a validated optimal planner",
        "diagnostic_columns": ["progression_stage", "preferred_goal_name"],
    }
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    return metadata


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR))
    parser.add_argument("--parent-dir", help="Completed dataset to expand; output must be a new directory")
    parser.add_argument("--seed", type=int, default=SEED)
    for flag, default in [("train-size", TRAIN_SIZE), ("validation-size", VALIDATION_SIZE),
                          ("test-size", TEST_SIZE), ("ood-size", OOD_SIZE)]:
        parser.add_argument(f"--{flag}", type=int, default=default)
    parser.add_argument("--boundary-fraction", type=float, default=0.3)
    parser.add_argument("--temperature", type=float, default=5.0)
    parser.add_argument("--max-generation-multiplier", type=int, default=MAX_GENERATION_MULTIPLIER)
    args = parser.parse_args()
    sizes = [args.train_size, args.validation_size, args.test_size, args.ood_size]
    if any(size < 0 for size in sizes) or not 0 < sum(sizes) <= 2_000_000:
        parser.error("Request 1..2,000,000 total new rows with nonnegative split sizes")
    if not 0 <= args.seed <= 2_147_483_647:
        parser.error("seed must be 0..2147483647")
    if not math.isfinite(args.temperature) or not 0.1 <= args.temperature <= 100:
        parser.error("temperature must be 0.1..100")
    if not 0 <= args.boundary_fraction <= 1 or not 1 <= args.max_generation_multiplier <= 1000:
        parser.error("boundary fraction must be 0..1 and generation multiplier 1..1000")
    generate(args)


if __name__ == "__main__":
    main()

