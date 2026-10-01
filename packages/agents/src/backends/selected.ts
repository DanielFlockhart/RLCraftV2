import type {
  AgentInputConfig,
  AgentInputFrame,
  BackendDescriptor,
  Environment,
  Observation,
} from "@mlcraft/core";
import { inputCatalog } from "@mlcraft/core";
import { projectFields } from "../inputs/serialize.js";

/** Enforce input selection at the common boundary, including third-party backends. */
export function selectedEnvironment(
  environment: Environment,
  config: AgentInputConfig,
  descriptor?: BackendDescriptor,
): Environment {
  return {
    ...(environment.feed ? { feed: () => environment.feed!() } : {}),
    ...(environment.sound ? { sound: (muted?: boolean) => environment.sound!(muted) } : {}),
    ...(environment.watchProgress
      ? {
          watchProgress: (
            listener: Parameters<NonNullable<Environment["watchProgress"]>>[0],
          ) => environment.watchProgress!(listener),
        }
      : {}),
    connect: () => environment.connect(),
    close: () => environment.close(),
    async apply(action) {
      for (const [capability, requested] of [
        ["controls", Object.values(action.controls ?? {}).some(Boolean)],
        ["look", !!action.look],
        ["dig", !!action.dig],
      ] as const)
        if (requested && descriptor && !descriptor.actions.includes(capability))
          throw new Error(
            `Backend '${descriptor.id}' does not support action '${capability}'`,
          );
      await environment.apply(action);
    },
    ...((!descriptor || descriptor.lifecycle.reset) && environment.reset
      ? {
          reset: (setup: Parameters<NonNullable<Environment["reset"]>>[0]) =>
            environment.reset!(setup),
        }
      : {}),
    ...((!descriptor || descriptor.lifecycle.teleport) && environment.teleport
      ? {
          teleport: (
            position: Parameters<NonNullable<Environment["teleport"]>>[0],
          ) => environment.teleport!(position),
        }
      : {}),
    ...((!descriptor || descriptor.lifecycle.respawn) && environment.respawn
      ? { respawn: () => environment.respawn!() }
      : {}),
    ...((!descriptor || descriptor.lifecycle.capture) && environment.capture
      ? {
          capture: (
            frame: Parameters<NonNullable<Environment["capture"]>>[0],
          ) => environment.capture!(frame),
        }
      : {}),
    async observe(tick): Promise<Observation> {
      const observation = await environment.observe(tick);
      const received = observation.inputs;
      if (!received || received.schemaVersion !== 1)
        throw new Error("Backend must expose AgentInputFrame schemaVersion 1");
      const channels: AgentInputFrame["channels"] = {};
      for (const entry of inputCatalog.channels) {
        const selection = config.channels[entry.id];
        if (!selection?.enabled) continue;
        const sample = received.channels[entry.id];
        channels[entry.id] = sample
          ? {
              ...sample,
              ...(sample.data !== undefined
                ? { data: projectFields(sample.data, selection.fields) }
                : {}),
            }
          : {
              status: "unavailable",
              source: "backend",
              sampledAt: Date.now(),
              reason: "Selected channel is not supplied by this backend",
            };
      }
      return { ...observation, tick, inputs: { ...received, tick, channels } };
    },
  };
}
