import type { MinecraftAsset } from "../components/minecraft-icon";

type TrainingStage = {
  id: string;
  phase: number;
  code: string;
  name: string;
  icon: MinecraftAsset;
  description: string;
  inputs: string;
  outputs: string;
  evaluation: string;
};

export const trainingPhases = [
  "Formalised problem",
  "State and goal representations",
  "Vision and perception",
  "Isolated low-level skills",
  "Skill and action arbitration",
  "World mapping and navigation",
  "Memory and long-horizon tasks",
  "World model and outcome prediction",
  "Goal and hierarchical planning",
  "Curriculum integration",
  "End-to-end reinforcement learning",
  "Sticking point detection",
] as const;

// Dashboard roadmap from the project notes. Only Phase 1A has a trainer.
// These IDs describe planned work; they are not live-agent RunSpec stage IDs.
export const trainingStages = [
  {
    id: "phase0",
    phase: 0,
    code: "0",
    name: "Formalised problem",
    icon: "book",
    description:
      "Define stable interfaces for observations, state, memory, goals, skills, actions and outcomes.",
    inputs:
      "Player-visible observations, normal player actions and progression requirements.",
    outputs:
      "Goal prerequisites and completion conditions; skill initiation and termination conditions; outcomes recording success, failure reason, state delta, duration and cost.",
    evaluation:
      "Contract compatibility and consistent outcome reporting across components. Existing runtime interfaces are a starting point for this planned formalisation.",
  },
  {
    id: "phase1a",
    phase: 1,
    code: "1A",
    name: "State-conditioned goal identification",
    icon: "book",
    description:
      "Predict short-term progression goals from structured Minecraft state, initially through obtaining an iron pickaxe.",
    inputs:
      "Inventory, player state, known resources, accessibility and a valid-goal mask.",
    outputs:
      "Goal scores and a preferred valid goal from a supervised state encoder and MLP.",
    evaluation:
      "Top-1 and top-k accuracy, invalid-goal selection, crafting boundaries, out-of-distribution performance and inference latency.",
  },
  {
    id: "phase1b",
    phase: 1,
    code: "1B",
    name: "Learned state representations",
    icon: "barrel",
    description:
      "Learn compact inventory and player-state representations for other networks.",
    inputs: "Resource quantities, equipment, inventory slots and player state.",
    outputs:
      "A compressed state representation that preserves information needed for progression.",
    evaluation:
      "Representation size, retained resource thresholds and downstream goal prediction performance.",
  },
  {
    id: "phase1c",
    phase: 1,
    code: "1C",
    name: "Goal embeddings",
    icon: "diamond",
    description:
      "Represent goals with learned embeddings instead of numeric goal IDs alone.",
    inputs:
      "Goal identity, parameters, prerequisites and completion conditions.",
    outputs:
      "Latent goal representations shared by goal prediction, planning and skill selection.",
    evaluation:
      "Generalisation across related goals and usefulness in downstream planning.",
  },
  {
    id: "phase1d",
    phase: 1,
    code: "1D",
    name: "Goal prediction under incomplete information",
    icon: "compass",
    description:
      "Choose useful goals when resource locations or nearby observations are only partly known.",
    inputs:
      "Known inventory, partial world observations and explicit unknown or inaccessible resources.",
    outputs:
      "Goal scores that account for missing information and the need to explore.",
    evaluation:
      "Goal validity, robustness to missing observations and appropriate exploration choices.",
  },
  {
    id: "phase2a",
    phase: 2,
    code: "2A",
    name: "Visual feature encoder",
    icon: "ender_eye",
    description:
      "Encode the agent’s first-person images into features for perception and planning.",
    inputs: "Rendered RGB frames from the agent’s own Minecraft client.",
    outputs: "Compact visual features reusable by other networks.",
    evaluation:
      "Feature quality, inference latency and robustness to lighting and viewpoint changes.",
  },
  {
    id: "phase2b",
    phase: 2,
    code: "2B",
    name: "Semantic perception",
    icon: "grass_block",
    description:
      "Identify meaningful blocks, entities and objects from visual observations.",
    inputs:
      "RGB images and visual features; labelled examples for supervised perception.",
    outputs:
      "Semantic labels or segmentation for resources, terrain, structures and threats.",
    evaluation:
      "Per-class accuracy, segmentation quality and generalisation to unseen scenes.",
  },
  {
    id: "phase2c",
    phase: 2,
    code: "2C",
    name: "Spatial perception",
    icon: "stone",
    description:
      "Learn spatial relationships needed to understand reachable terrain and nearby obstacles.",
    inputs: "Visual features, semantic observations and player pose.",
    outputs:
      "Estimated relative locations, traversability and spatial relationships.",
    evaluation:
      "Spatial estimation error, obstacle detection and navigation usefulness.",
  },
  {
    id: "phase2d",
    phase: 2,
    code: "2D",
    name: "Multimodal state fusion",
    icon: "crafting_table",
    description:
      "Combine perception with structured state into a shared representation.",
    inputs:
      "Vision, available audio, inventory, player state and memory context.",
    outputs:
      "A fused state representation with explicit handling of unavailable inputs.",
    evaluation:
      "Downstream goal accuracy, missing-modality robustness and inference cost.",
  },
  {
    id: "phase3a",
    phase: 3,
    code: "3A",
    name: "Primitive motor skills",
    icon: "stick",
    description:
      "Train target-directed movement through nine isolated Minecraft arenas.",
    inputs: "Target delta, velocity, yaw, pitch, on-ground state and optional local depth.",
    outputs:
      "Forward, back, left, right, jump, sprint, yaw delta and pitch delta.",
    evaluation:
      "Target progress and success, movement efficiency, and evolved NEAT fitness.",
  },
  {
    id: "phase3b",
    phase: 3,
    code: "3B",
    name: "Locomotion",
    icon: "leather_boots",
    description:
      "Learn to reach coordinate targets and explore unfamiliar terrain.",
    inputs:
      "Player pose, nearby terrain, target coordinates and exploration requests.",
    outputs:
      "Movement skills for travelling, obstacle handling and exploration.",
    evaluation:
      "Target success, completion time, path efficiency and falls or collisions.",
  },
  {
    id: "phase3c",
    phase: 3,
    code: "3C",
    name: "Interaction skills",
    icon: "iron_pickaxe",
    description:
      "Train mining, eating, crafting and inventory or container interactions in isolation.",
    inputs:
      "Requested interaction, inventory, accessible targets and relevant player state.",
    outputs:
      "Player action sequences and skill outcomes for resource and item interactions.",
    evaluation:
      "Interaction success, inventory changes, hunger recovery and completion time.",
  },
  {
    id: "phase3d",
    phase: 3,
    code: "3D",
    name: "Combat",
    icon: "iron_sword",
    description:
      "Learn isolated combat skills for engaging threats and retreating when needed.",
    inputs:
      "Observed opponents, health, equipment, terrain and a combat objective.",
    outputs: "Attack, defence and flee skills through normal player actions.",
    evaluation:
      "Survival, damage dealt and received, encounter success and resource cost.",
  },
  {
    id: "phase4a",
    phase: 4,
    code: "4A",
    name: "Rule-based arbitration",
    icon: "shield",
    description:
      "Establish emergency priorities before learning which skills to invoke.",
    inputs:
      "Available skills, active goal, burning, drowning, starvation and immediate threats.",
    outputs:
      "A baseline skill selection that prioritises urgent survival actions.",
    evaluation:
      "Emergency response time, survival and correct precedence over routine tasks.",
  },
  {
    id: "phase4b",
    phase: 4,
    code: "4B",
    name: "Learned arbitration",
    icon: "experience_bottle",
    description:
      "Learn which skill or combination of skills should run at each decision point.",
    inputs:
      "Current goal, state, available skills and their estimated outcomes.",
    outputs:
      "Ranked skills and invocation decisions, calling each network only as often as needed.",
    evaluation:
      "Goal progress, emergency handling, unnecessary skill switches and network call cost.",
  },
  {
    id: "phase4c",
    phase: 4,
    code: "4C",
    name: "Skill interruption and resumption",
    icon: "red_bed",
    description:
      "Interrupt a task for an urgent event, then resume the original goal when safe.",
    inputs:
      "Active skill, goal context, progress and new threat or survival events.",
    outputs:
      "Interrupt, fight or flee, and resume decisions that retain task context.",
    evaluation:
      "Safe interruption, successful resumption and progress retained after threats.",
  },
  {
    id: "phase5",
    phase: 5,
    code: "5",
    name: "World mapping and navigation",
    icon: "compass",
    description:
      "Learn bounded world maps containing resources, structures, containers, bases and waypoints.",
    inputs:
      "Observed locations, player coordinates, discovered landmarks and manually named locations.",
    outputs:
      "Compressed map representations and capped location records, with viewable agent maps and navigation targets.",
    evaluation:
      "Location recall, map accuracy, navigation success and storage use.",
  },
  {
    id: "phase6",
    phase: 6,
    code: "6",
    name: "Memory and long-horizon tasks",
    icon: "book",
    description:
      "Learn what to retain and compress across working, episodic and semantic memory.",
    inputs:
      "Current goals and skills, recent observations, past outcomes and known world locations.",
    outputs:
      "Bounded memory for task context, useful past experiences, bases, portals and container contents.",
    evaluation:
      "Long-task completion, useful recall, forgetting behaviour and memory capacity.",
  },
  {
    id: "phase7",
    phase: 7,
    code: "7",
    name: "World model and outcome prediction",
    icon: "ender_pearl",
    description:
      "Predict what will happen if the agent pursues a candidate goal, skill or action.",
    inputs: "Current state, memory and a candidate goal, skill or action.",
    outputs:
      "Predicted next state, inventory delta, goal progress, danger, duration and success probability.",
    evaluation:
      "State and duration prediction error, risk calibration and success-probability accuracy.",
  },
  {
    id: "phase8",
    phase: 8,
    code: "8",
    name: "Goal and hierarchical planning",
    icon: "ender_eye",
    description:
      "Break the final objective of defeating the Ender Dragon into useful sub-goals.",
    inputs:
      "Goal embeddings, world-model predictions, memory and learned value estimates.",
    outputs:
      "Goal hierarchies and plans covering resources, Nether access, fortress discovery and End access.",
    evaluation:
      "Plan validity, prerequisite coverage, replanning and progress towards the final objective.",
  },
  {
    id: "phase9",
    phase: 9,
    code: "9",
    name: "Curriculum integration",
    icon: "nether_bricks",
    description:
      "Combine components in staged scenarios so failures can be isolated before full-game runs.",
    inputs:
      "Trained components and controlled scenarios, including Nether-only and End-only tasks.",
    outputs:
      "Integrated stage curricula, scenario outcomes and component-level failure evidence.",
    evaluation:
      "Scenario success, cross-component compatibility and regressions across earlier skills.",
  },
  {
    id: "phase10",
    phase: 10,
    code: "10",
    name: "End-to-end reinforcement learning",
    icon: "dragon_egg",
    description:
      "Fine-tune the combined architecture through full-game reinforcement learning.",
    inputs:
      "Integrated perception, skills, arbitration, maps, memory, world model and planner.",
    outputs:
      "Updated policies and checkpoints from complete progression attempts, with slower updates to pretrained skills.",
    evaluation:
      "Game completion rate, completion time, reward, survival and retained skill performance.",
  },
  {
    id: "phase11",
    phase: 11,
    code: "11",
    name: "Sticking point detection",
    icon: "furnace",
    description:
      "Identify weak components and trigger targeted retraining after repeated failures.",
    inputs:
      "Full-run failures, skill outcomes, progression traces and regression results.",
    outputs:
      "Failure classifications, targeted curricula and retraining recommendations before returning to full runs.",
    evaluation:
      "Failure attribution, improvement after retraining and absence of regressions in other components.",
  },
] as const satisfies readonly TrainingStage[];

export type TrainingStageId = (typeof trainingStages)[number]["id"];
