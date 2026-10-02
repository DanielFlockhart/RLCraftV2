import type { Action, ModelInspection, Policy, PolicyObservation, Trainer, Transition } from "@mlcraft/core";

/** The Mineflayer environment executes SkillRequest directly for this stage. */
export class InteractionBaselinePolicy implements Policy {
  inspectModel(): ModelInspection {
    return {
      implementation: "MineflayerInteractionExecutor",
      framework: "TypeScript / Mineflayer",
      status: "ready",
      reason: "Deterministic skill executor. No neural network or learned weights are used.",
      parameters: 0,
      trainableParameters: 0,
      hyperparameters: { control: "player-equivalent", feedback: "Minecraft block and inventory state" },
      nodes: [
        { id: "request", label: "SkillRequest", kind: "input", config: { fields: "skill, target, parameters" } },
        { id: "affordance", label: "Minecraft affordance rules", kind: "deterministic rules" },
        { id: "executor", label: "Aim, equip, interact and verify", kind: "state machine" },
        { id: "world", label: "Minecraft", kind: "environment" },
        { id: "result", label: "SkillResult", kind: "output", config: { fields: "status, reason, state_delta, duration, metrics" } },
      ],
      edges: [
        { from: "request", to: "affordance" },
        { from: "affordance", to: "executor" },
        { from: "executor", to: "world" },
        { from: "world", to: "result" },
      ],
    };
  }
  async reset(_seed: number) {}
  async act(_observation: PolicyObservation): Promise<Action> { return {}; }
  async close() {}
}

export class InteractionBaselineTrainer implements Trainer {
  inspectModel(): ModelInspection {
    return {
      implementation: "InteractionTrialEvaluator",
      framework: "TypeScript",
      status: "ready",
      reason: "Measures baseline reliability across isolated trials; no optimizer or learning is performed.",
      parameters: 0,
      trainableParameters: 0,
      hyperparameters: { evaluation: "per-trial success, duration and failure reasons" },
      nodes: [
        { id: "results", label: "SkillResults", kind: "input" },
        { id: "metrics", label: "Trial metrics", kind: "evaluator" },
        { id: "artifacts", label: "Results and checkpoint", kind: "output" },
      ],
      edges: [{ from: "results", to: "metrics" }, { from: "metrics", to: "artifacts" }],
    };
  }
  async observe(_agentId: string, _transition: Transition) {}
  async endEpisode(_episode: number) { return {}; }
  async checkpoint() { return { kind: "interaction-baseline" }; }
}
