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
        train.jsonl
        validation.jsonl
        test.jsonl
        ood_test.jsonl
        metadata.json

No external dependencies are required.
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, fields, replace
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
GENERATOR_VERSION = "2.2.0"
SCHEMA_VERSION = 2
INDEX_STRIDE = 256
INVENTORY_ITEMS = {
    "logs": ("minecraft:oak_log", 64), "planks": ("minecraft:oak_planks", 64),
    "sticks": ("minecraft:stick", 64), "cobblestone": ("minecraft:cobblestone", 64),
    "raw_iron": ("minecraft:raw_iron", 64), "iron_ingots": ("minecraft:iron_ingot", 64),
    "coal": ("minecraft:coal", 64), "charcoal": ("minecraft:charcoal", 64),
    "crafting_table": ("minecraft:crafting_table", 64), "furnace": ("minecraft:furnace", 64),
    "wooden_pickaxe": ("minecraft:wooden_pickaxe", 1),
    "stone_pickaxe": ("minecraft:stone_pickaxe", 1), "iron_pickaxe": ("minecraft:iron_pickaxe", 1),
}
CONTEXT_FIELDS = [key for key in STATE_FIELDS if key not in INVENTORY_ITEMS]


@dataclass(frozen=True)
class CoverageCase:
    id: str
    family: str
    description: str
    state: MinecraftState
    layout: str = "random"


def coverage_catalog(ood: bool = False) -> list[CoverageCase]:
    """Finite, reviewable decision-boundary matrix, independent of random chance."""
    from itertools import product
    cases = []
    def add(key, family, description, layout="random", **values):
        cases.append(CoverageCase(key, family, description, MinecraftState(**values), layout))
    if ood:
        for amount in [65, 127, 128, 129, 255, 256]:
            for wood, table in product([False, True], repeat=2):
                add(f"ood_logs_{amount}_{int(wood)}_{int(table)}", "overflow", f"{amount} logs; wood access {wood}; table access {table}", logs=amount, wood_accessible=wood, crafting_table_accessible=table)
        for layout in ["random", "full", "main_only", "selected_empty", "selected_occupied"]:
            add(f"ood_layout_{layout}", "slot_layout", f"Overflow logs with {layout.replace('_', ' ')} layout", layout, logs=256, planks=64, sticks=64)
        for layout, amount in [("repeated_full_partial", 65), ("repeated_full", 128)]:
            add(f"ood_{layout}", "repeated_stacks", f"Overflow logs: {layout.replace('_', ' ')}", layout, logs=amount)
        return cases

    progression = [
        ("gather_wood", {}), ("craft_planks", {"logs": 1}),
        ("craft_table", {"planks": 4, "sticks": 2}), ("craft_sticks", {"planks": 2}),
        ("craft_wooden_pickaxe", {"planks": 3, "sticks": 2, "crafting_table": 1}),
        ("mine_stone", {"wooden_pickaxe": 1, "stone_accessible": True}),
        ("craft_furnace", {"wooden_pickaxe": 1, "cobblestone": 8, "crafting_table": 1}),
        ("craft_stone_pickaxe", {"cobblestone": 3, "sticks": 2, "crafting_table": 1}),
        ("find_iron", {"stone_pickaxe": 1, "wood_accessible": False}),
        ("mine_iron", {"stone_pickaxe": 1, "iron_known": True, "iron_accessible": True, "wood_accessible": False}),
        ("smelt_iron", {"raw_iron": 3, "furnace": 1, "coal": 1, "wood_accessible": False}),
        ("craft_iron_pickaxe", {"iron_ingots": 3, "sticks": 2, "crafting_table": 1}),
        ("complete", {"iron_pickaxe": 1}),
    ]
    for name, values in progression:
        add(f"goal_{name}", "progression", f"Progression: {name.replace('_', ' ')}", **values)
    add("empty_blocked", "empty", "No items and no accessible wood", wood_accessible=False)
    add("empty_world_workstations", "empty", "No items; nearby crafting table and furnace", crafting_table_accessible=True, furnace_accessible=True)
    for key, (_, maximum) in INVENTORY_ITEMS.items():
        amounts = [1, 2, 3, 4, 7, 8, 63, 64] if maximum > 1 else [1, 2, 8]
        for amount, wood in product(amounts, [False, True]):
            add(f"only_{key}_{amount}_{int(wood)}", "single_item", f"Only {amount} {key.replace('_', ' ')}; wood access {wood}", **{key: amount, "wood_accessible": wood})
    table_modes = [("missing", {}), ("owned", {"crafting_table": 1}), ("nearby", {"crafting_table_accessible": True})]
    for recipe, resource, values in [("table", "planks", [3,4,5]), ("sticks", "planks", [1,2,3]),
                                     ("wooden_pickaxe", "planks", [2,3,4]), ("stone_pickaxe", "cobblestone", [2,3,4]),
                                     ("furnace", "cobblestone", [7,8,9]), ("iron_pickaxe", "iron_ingots", [2,3,4])]:
        for amount, sticks, (mode, table) in product(values, [1,2,3], table_modes):
            add(f"recipe_{recipe}_{amount}_{sticks}_{mode}", "crafting_boundary", f"{recipe.replace('_',' ')}: {amount} {resource}, {sticks} sticks, table {mode}", **{resource: amount, "sticks": sticks, **table})
    for raw, furnace, fuel in product([0,1,2,3], ["missing", "owned", "nearby"], ["none", "logs", "planks", "coal", "charcoal"]):
        values = {"raw_iron": raw, "wood_accessible": False}
        if furnace == "owned": values["furnace"] = 1
        if furnace == "nearby": values["furnace_accessible"] = True
        if fuel != "none": values[fuel] = 1
        add(f"smelting_{raw}_{furnace}_{fuel}", "smelting", f"Smelting: {raw} raw iron, furnace {furnace}, fuel {fuel}", **values)
    for tool, stone, known, iron in product(["none", "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe"], [False,True], [False,True], [False,True]):
        values = {"stone_accessible": stone, "iron_known": known, "iron_accessible": iron, "wood_accessible": False}
        if tool != "none": values[tool] = 1
        add(f"mining_{tool}_{int(stone)}_{int(known)}_{int(iron)}", "mining", f"Mining: {tool}, stone {stone}, iron known {known}, iron accessible {iron}", **values)
    for layout in ["hotbar_only", "main_only", "offhand_only", "selected_empty", "selected_occupied"]:
        add(f"slots_{layout}", "slot_layout", f"Slot arrangement: {layout.replace('_', ' ')}", layout, coal=8)
    for key, (_, maximum) in INVENTORY_ITEMS.items():
        patterns = [("repeated_partial", 8), ("repeated_single", 8)] if maximum > 1 else [("repeated_tools", 3)]
        if maximum > 1 and key != "logs":
            patterns += [("repeated_full_partial", 65), ("repeated_full", 128)]
        for layout, amount in patterns:
            add(f"stacks_{key}_{layout}", "repeated_stacks", f"{key.replace('_', ' ')}: {layout.replace('_', ' ')} across inventory regions", layout, **{key: amount})
    add("stacks_mixed", "repeated_stacks", "Repeated stacks of multiple item types, including duplicate tools", "repeated_partial", cobblestone=65, coal=8, iron_pickaxe=2)
    for amount in [63,64,65,127,128,129,512,2304,2368]:
        for key in ["cobblestone", "iron_ingots", "furnace"]:
            add(f"surplus_{key}_{amount}", "surplus", f"Surplus: only {amount} {key.replace('_', ' ')}", **{key: amount})
    add("full_mixed", "full", "All 37 storage/off-hand slots occupied by mixed items", "full", **{key: (1 if maximum == 1 else 64) for key, (_,maximum) in INVENTORY_ITEMS.items()})
    add("full_maximum", "full", "All 37 storage/off-hand slots contain 64 cobblestone", "full", cobblestone=37*64)
    # All 2^7 environment/day combinations at the four vital extremes. Coal can
    # vary without altering these context cells or introducing another action.
    flags = ["wood_accessible", "stone_accessible", "iron_known", "iron_accessible", "crafting_table_accessible", "furnace_accessible", "daytime"]
    for bits, health, hunger in product(product([False,True], repeat=len(flags)), [1,20], [0,20]):
        mask = "".join(str(int(bit)) for bit in bits)
        add(f"context_{mask}_{health}_{hunger}", "context_limits", f"Context {mask}: health {health}, hunger {hunger}", **dict(zip(flags,bits)), health=health, hunger=hunger)
    # Identical teacher states have one representative case, avoiding inflated
    # coverage claims from equivalent recipe-table rows and single-item states.
    unique = {}
    for case in cases:
        unique.setdefault((case.state, case.layout, case.family == "context_limits"), case)
    return list(unique.values())


def case_state(case: CoverageCase, rng: random.Random) -> MinecraftState:
    if case.family == "context_limits":
        return replace(case.state, coal=rng.randint(1,64))
    return replace(case.state, health=rng.randint(1,20), hunger=rng.randint(0,20))


def reserved_cases():
    """Protect a distinct representative of every cell in every split.

    Training must not consume every variant of a small state family before
    validation/test (or a future expansion of an empty split) can cover it.
    These representatives are stable across seeds; random rows and layouts vary.
    """
    occupied = set()
    result = {}
    for index, split in enumerate(SPLITS):
        rng = random.Random(19_731 + index * 1_000_003)
        result[split] = {}
        for case in coverage_catalog(split == "ood_test"):
            for _ in range(10000):
                state = case_state(case, rng)
                if state not in occupied:
                    occupied.add(state)
                    result[split][case.id] = state
                    break
            else:
                raise RuntimeError(f"Cannot reserve a unique representative for {split}/{case.id}")
    return result, occupied


EDGE_FAMILIES = ["empty", "single_item", "sparse", "surplus", "full", "progression", "crafting_boundary", "smelting", "mining", "slot_layout", "repeated_stacks", "context_limits"]


def edge_state(rng: random.Random, family: str, catalog: list[CoverageCase]):
    if family in ["progression", "crafting_boundary", "smelting", "mining"]:
        case = rng.choice(catalog)
        state = case_state(case, rng)
        if family == "progression":
            # Vary harmless fuel reserves while preserving the intended next
            # goal, so progression examples are not limited to 420 vital pairs.
            state = replace(state, coal=rng.randint(1 if state.coal else 0,64))
        return state, case.layout, case.id
    context = random_state(rng)
    context = replace(context, **{key: 0 for key in INVENTORY_ITEMS}, wood_accessible=rng.random() < .5)
    if family == "repeated_stacks":
        case = rng.choice(catalog)
        return replace(context, **{key: getattr(case.state, key) for key in INVENTORY_ITEMS}), case.layout, case.id
    if family == "slot_layout":
        layout = rng.choice(["hotbar_only", "main_only", "offhand_only", "selected_empty", "selected_occupied"])
        chosen = rng.sample(list(INVENTORY_ITEMS), 1 if layout == "offhand_only" else rng.randint(1,3))
        amounts = {key: rng.choice([1,2,3,8,63,64]) if INVENTORY_ITEMS[key][1] > 1 else (1 if layout == "offhand_only" else rng.randint(1,3)) for key in chosen}
        return replace(context, **amounts), layout, None
    if family == "empty": return context, "random", None
    if family in ["single_item", "sparse"]:
        chosen = rng.sample(list(INVENTORY_ITEMS), 1 if family == "single_item" else rng.randint(2,3))
        values = {key: rng.choice([1,2,3,4,7,8,63,64]) if INVENTORY_ITEMS[key][1] > 1 else rng.choice([1,2,8]) for key in chosen}
        return replace(context, **values), "random", None
    if family == "surplus":
        chosen = rng.sample([key for key, (_,maximum) in INVENTORY_ITEMS.items() if maximum > 1], rng.randint(1,3))
        return replace(context, **{key: rng.choice([64,128,256,512]) if key != "logs" else 64 for key in chosen}), "random", None
    if family == "full":
        if rng.random() < .5:
            return replace(context, cobblestone=37*64), "full", "full_maximum"
        return replace(context, **{key: (1 if maximum == 1 else rng.choice([32,63,64])) for key, (_,maximum) in INVENTORY_ITEMS.items()}), "full", None
    return replace(random_state(rng), health=rng.choice([1,20]), hunger=rng.choice([0,20]), wood_accessible=rng.random() < .5), "random", None


def inventory_from_state(state: MinecraftState, rng: random.Random, layout: str = "random") -> dict:
    stacks = []
    for field, (item, maximum) in INVENTORY_ITEMS.items():
        remaining = getattr(state, field)
        while remaining:
            limit = 1 if layout == "repeated_single" else (maximum // 2 if layout == "repeated_partial" and maximum > 1 else maximum)
            amount = min(remaining, limit)
            stacks.append({"item": item, "count": amount})
            remaining -= amount
    if layout == "repeated_partial":
        # Guarantee fragmentation even when the total fits a single partial stack.
        for stack in list(stacks):
            if stack["count"] > 1 and sum(other["item"] == stack["item"] for other in stacks) == 1:
                amount = stack["count"] // 2
                stack["count"] -= amount
                stacks.append({"item": stack["item"], "count": amount})
    available = list(range(36)) + [40]
    if layout == "hotbar_only": available = list(range(9))
    if layout == "main_only": available = list(range(9,36))
    if layout == "offhand_only": available = [40]
    if len(stacks) > len(available):
        raise ValueError("Sampled inventory does not fit the player's storage slots")
    if layout == "full":
        while len(stacks) < len(available):
            candidates = [index for index, stack in enumerate(stacks) if stack["count"] > 1]
            if not candidates: raise ValueError("Not enough items for a full inventory")
            stack = stacks[rng.choice(candidates)]
            amount = rng.randint(1, stack["count"] - 1)
            stack["count"] -= amount
            stacks.append({"item": stack["item"], "count": amount})
    elif not layout.startswith("repeated_"):
        # Pack first, then fragment only when an extra slot is available. A
        # capacity-edge inventory must never become unrepresentable at random.
        for stack in list(stacks):
            if len(stacks) < len(available) and stack["count"] > 1 and rng.random() < .25:
                amount = rng.randint(1, stack["count"] - 1)
                stack["count"] -= amount
                stacks.append({"item": stack["item"], "count": amount})
    if len(stacks) > len(available):
        raise ValueError("Sampled inventory does not fit the player's storage slots")
    assigned = rng.sample(available, len(stacks))
    if layout.startswith("repeated_"):
        # Put matching stacks in different inventory regions, rather than
        # relying on random placement to exercise cross-region aggregation.
        repeated_item = next(stack["item"] for stack in stacks if sum(other["item"] == stack["item"] for other in stacks) > 1)
        indices = [index for index, stack in enumerate(stacks) if stack["item"] == repeated_item][:3]
        pinned = dict(zip(indices, [rng.randrange(9), rng.randrange(9,36), 40]))
        remaining_slots = rng.sample([slot for slot in available if slot not in pinned.values()], len(stacks) - len(pinned))
        assigned = [pinned[index] if index in pinned else remaining_slots.pop() for index in range(len(stacks))]
    if layout == "selected_occupied" and stacks and not any(slot < 9 for slot in assigned):
        assigned[0] = rng.randrange(9)
    selected = rng.randrange(9)
    if layout == "selected_occupied": selected = rng.choice([slot for slot in assigned if slot < 9])
    if layout == "selected_empty":
        empty_hotbar = [slot for slot in range(9) if slot not in assigned]
        if not empty_hotbar: raise ValueError("No empty hotbar slot")
        selected = rng.choice(empty_hotbar)
    return {
        "size": 41, "selected_hotbar_slot": selected,
        "slots": sorted([dict(stack, slot=slot) for stack, slot in zip(stacks, assigned)], key=lambda stack: stack["slot"]),
    }


def state_from_example(example: dict) -> MinecraftState:
    if example.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Dataset does not use the current inventory schema")
    counts = {key: 0 for key in INVENTORY_ITEMS}
    by_item = {item: (key, maximum) for key, (item, maximum) in INVENTORY_ITEMS.items()}
    occupied = set()
    inventory = example["inventory"]
    if inventory["size"] != 41 or not 0 <= inventory["selected_hotbar_slot"] <= 8:
        raise ValueError("Invalid player inventory layout")
    for stack in inventory["slots"]:
        slot, item, count = stack["slot"], stack["item"], stack["count"]
        if type(slot) is not int or slot in occupied or slot not in list(range(36)) + [40] or item not in by_item:
            raise ValueError("Invalid or duplicate Phase 1A inventory slot/item")
        key, maximum = by_item[item]
        if type(count) is not int or not 1 <= count <= maximum:
            raise ValueError("Inventory stack exceeds the item's stack limit")
        occupied.add(slot)
        counts[key] += count
    return MinecraftState(**counts, **{key: example["context"][key] for key in CONTEXT_FIELDS})


def encode_example(state: MinecraftState, temperature: float, rng: random.Random, layout: str = "random", family: str | None = None, case_id: str | None = None) -> dict:
    scores = teacher_scores(state, temperature)
    goal = max(scores, key=scores.get) if any(scores.values()) else None
    return {
        "schema_version": SCHEMA_VERSION,
        "inventory": inventory_from_state(state, rng, layout),
        "context": {key: getattr(state, key) for key in CONTEXT_FIELDS},
        "target": {
            "goal_id": int(goal) if goal is not None else None, "goal": goal.name if goal is not None else None,
            "label_status": "blocked" if goal is None else "complete" if goal == Goal.COMPLETE else "actionable",
            "valid_goals": {g.name: valid for g, valid in valid_goals(state).items()},
            "probabilities": {g.name: probability for g, probability in scores.items()},
        },
        "diagnostics": {"progression_stage": progression_stage(state), "inventory_layout": layout, **({"sampling_family": family} if family else {}), **({"coverage_case": case_id} if case_id else {})},
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
    coverage = {}
    if parent:
        # Load all splits before sampling to prevent cross-split duplicates.
        for split in SPLITS:
            with (parent / f"{split}.jsonl").open(encoding="utf-8") as source:
                for line in source:
                    state = state_from_example(json.loads(line))
                    if state in seen:
                        raise ValueError("Parent contains duplicate states across or within splits")
                    seen.add(state)
                    parent_counts[split] += 1
    requested = dict(zip(SPLITS, [args.train_size, args.validation_size, args.test_size, args.ood_size]))
    representatives, protected_states = reserved_cases()
    for index, split in enumerate(SPLITS):
        # Separate RNG streams keep splits reproducible when other sizes change.
        rng = random.Random(args.seed + index * 1_000_003)
        layout_rng = random.Random(args.seed + index * 1_000_003 + 97_000_019)
        size = requested[split]
        count = 0
        attempts = 0
        catalog = coverage_catalog(split == "ood_test")
        groups = {family: [case for case in catalog if case.family == family] for family in EDGE_FAMILIES}
        case_lookup = {case.id: case for case in catalog}
        case_counts = Counter()
        case_first = {}
        family_counts = Counter()
        def record_coverage(example, row):
            diagnostics = example.get("diagnostics", {})
            family_counts[diagnostics.get("sampling_family", "legacy")] += 1
            key = diagnostics.get("coverage_case")
            if key in case_lookup:
                case_counts[key] += 1
                case_first.setdefault(key, row)
        offsets = []
        written = 0
        with (output / f"{split}.jsonl").open("wb") as target:
            def write_example(example, original=None):
                nonlocal written
                if written % INDEX_STRIDE == 0:
                    offsets.append(target.tell())
                target.write(original if original is not None else (json.dumps(example, separators=(",", ":")) + "\n").encode("utf-8"))
                written += 1
            if parent:
                with (parent / f"{split}.jsonl").open("rb") as source:
                    for line in source:
                        example = json.loads(line)
                        write_example(example, line)
                        histograms[split][example["target"]["goal"] or "BLOCKED"] += 1
                        record_coverage(example, written - 1)
            mandatory = [case for case in catalog if not case_counts[case.id]]
            mandatory_index = 0
            print(json.dumps({"split": split, "rows": 0, "total": size}), flush=True)
            while count < size:
                attempts += 1
                if attempts > max(1, size) * args.max_generation_multiplier:
                    pending = mandatory[mandatory_index].id if mandatory_index < len(mandatory) else "random mixture"
                    raise RuntimeError(f"Could not generate {size} unique labelled states for {split} while sampling {pending}")
                case_id = None
                layout = "random"
                if mandatory_index < len(mandatory):
                    case = mandatory[mandatory_index]
                    state, family, layout, case_id = representatives[split][case.id], case.family, case.layout, case.id
                elif rng.random() < args.edge_fraction:
                    if split == "ood_test":
                        family = rng.choice(["sparse", "surplus", "full", "overflow"])
                        if family == "overflow":
                            case = rng.choice(catalog)
                            state, layout, case_id = case_state(case, rng), case.layout, case.id
                        else:
                            state, layout, case_id = edge_state(rng, family, groups.get(family, []))
                            # Reserve enough stack capacity for OOD logs.
                            if family == "full":
                                state = replace(state, cobblestone=64, planks=64, sticks=64, iron_ingots=64)
                    else:
                        family = rng.choice(EDGE_FAMILIES)
                        state, layout, case_id = edge_state(rng, family, groups.get(family, []))
                else:
                    family = "boundary_random" if rng.random() < args.boundary_fraction else "broad_random"
                    state = boundary_state(rng) if family == "boundary_random" else random_state(rng)
                if split == "ood_test":
                    if not 65 <= state.logs <= 256:
                        state = replace(state, logs=rng.randint(65, 256))
                    if case_id == "full_maximum": case_id = None
                if state in seen:
                    continue
                if mandatory_index >= len(mandatory) and state in protected_states:
                    continue
                try:
                    example = encode_example(state, args.temperature, layout_rng, layout, family, case_id)
                except ValueError:
                    continue
                if state_from_example(example) != state:
                    raise RuntimeError("Inventory does not match the labelled state")
                seen.add(state)
                write_example(example)
                histograms[split][example["target"]["goal"] or "BLOCKED"] += 1
                record_coverage(example, written - 1)
                if mandatory_index < len(mandatory): mandatory_index += 1
                count += 1
                if count % 1000 == 0 or count == size:
                    print(json.dumps({"split": split, "rows": count, "total": size}), flush=True)
        print(f"Wrote {split}: {parent_counts[split] + count} rows ({count} new)", flush=True)
        (output / f"{split}.index.json").write_text(json.dumps({"stride": INDEX_STRIDE, "rows": written, "offsets": offsets}) + "\n")
        missing = [case.id for case in catalog if not case_counts[case.id]]
        coverage[split] = {
            "required_cases": len(catalog), "covered_cases": len(catalog) - len(missing), "complete": not missing,
            "missing_cases": missing, "families": dict(family_counts),
            "blocked_rows": histograms[split]["BLOCKED"],
            "cases": [{"id": case.id, "family": case.family, "description": case.description,
                       "count": case_counts[case.id], "first_index": case_first.get(case.id)} for case in catalog],
        }
        print(f"Coverage {split}: {len(catalog) - len(missing)}/{len(catalog)} defined cases; {histograms[split]['BLOCKED']} blocked examples", flush=True)
    metadata = {
        "generator": "phase1a", "generator_version": GENERATOR_VERSION,
        "schema_version": SCHEMA_VERSION, "format": "jsonl", "minecraft_version": "1.18.1",
        "source_hash": source_hash, "seed": args.seed,
        "temperature": args.temperature, "boundary_fraction": args.boundary_fraction,
        "edge_fraction": args.edge_fraction,
        "max_generation_multiplier": args.max_generation_multiplier,
        "requested_new_rows": requested,
        "split_sizes": {split: parent_counts[split] + requested[split] for split in SPLITS},
        "goal_counts": histograms,
        "coverage": coverage,
        "sampling": "Required finite case matrix first; then family-balanced edge samples and broad/boundary random states",
        "context_fields": CONTEXT_FIELDS,
        "inventory_schema": {
            "size": 41, "empty_slots": "omitted", "item_ids": "minecraft namespaced IDs",
            "slots": {"hotbar": [0, 8], "main": [9, 35], "boots": 36, "leggings": 37,
                      "chestplate": 38, "helmet": 39, "off_hand": 40},
            "selected_hotbar_slot": "0..8", "crafting_slots": "not part of player storage",
            "placement": "synthetic random legal slots; not recorded gameplay",
            "item_stack_limits": {item: maximum for item, maximum in INVENTORY_ITEMS.values()},
        },
        "goals": {goal.name: int(goal) for goal in GOALS},
        "ood_definition": "Total logs 65..256 versus 0..64 in training. Surplus quantities of other Phase 1A items occur in both distributions.",
        "parent": str(parent) if parent else None,
        "target": "high-level progression goal; not a low-level action",
        "teacher": "Interpretable synthetic utility prior; not a validated optimal planner",
        "diagnostic_fields": ["diagnostics.progression_stage"],
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
    parser.add_argument("--edge-fraction", type=float, default=0.6)
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
    if not 0 <= args.edge_fraction <= 1:
        parser.error("edge fraction must be 0..1")
    if not 0 <= args.boundary_fraction <= 1 or not 1 <= args.max_generation_multiplier <= 1000:
        parser.error("boundary fraction must be 0..1 and generation multiplier 1..1000")
    generate(args)


if __name__ == "__main__":
    main()

