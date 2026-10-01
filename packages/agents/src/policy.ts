import type {
  Action,
  PolicyObservation,
  Policy,
  Trainer,
  Transition,
  ModelInspection,
} from "@mlcraft/core";
/** Replace with your model. No random movement or fake learning is used. */
export class PlaceholderPolicy implements Policy {
  inspectModel(): ModelInspection {
    if (this.constructor !== PlaceholderPolicy)
      throw new Error(
        "Derived policies must inspect their own actual model; placeholder metadata cannot describe them.",
      );
    return {
      implementation: this.constructor.name,
      framework: "TypeScript",
      status: "placeholder",
      parameters: 0,
      trainableParameters: 0,
      hyperparameters: {},
      nodes: [
        { id: "observation", label: "Observation", kind: "input" },
        {
          id: "policy",
          label: this.constructor.name,
          kind: "no-op policy",
          parameters: 0,
          trainableParameters: 0,
        },
        { id: "action", label: "Empty action", kind: "output" },
      ],
      edges: [
        { from: "observation", to: "policy", label: "act(observation)" },
        { from: "policy", to: "action", label: "returns {}" },
      ],
      reason: "No neural network or learned weights are implemented.",
    };
  }
  async reset(_seed: number) {}
  async act(_observation: PolicyObservation): Promise<Action> {
    return {};
  }
  async close() {}
}
/** Replace with NEAT/PPO/etc. Avoid retaining unbounded transitions in memory. */
export class PlaceholderTrainer implements Trainer {
  inspectModel(): ModelInspection {
    if (this.constructor !== PlaceholderTrainer)
      throw new Error(
        "Derived trainers must inspect their own actual optimizer and model.",
      );
    return {
      implementation: this.constructor.name,
      framework: "TypeScript",
      status: "placeholder",
      parameters: 0,
      trainableParameters: 0,
      hyperparameters: {},
      nodes: [
        { id: "transition", label: "Transition", kind: "input" },
        {
          id: "trainer",
          label: this.constructor.name,
          kind: "no-op trainer",
          parameters: 0,
        },
        { id: "checkpoint", label: "Metadata checkpoint", kind: "output" },
      ],
      edges: [
        { from: "transition", to: "trainer", label: "observe()" },
        { from: "trainer", to: "checkpoint", label: "checkpoint()" },
      ],
      reason:
        "No optimizer, algorithm or learning hyperparameters are implemented.",
    };
  }
  async observe(_agentId: string, _transition: Transition) {}
  async endEpisode(_episode: number) {
    return {};
  }
  async checkpoint() {
    return {
      kind: "placeholder",
      model: null,
      note: "Infrastructure checkpoint; no model has been trained.",
    };
  }
}
