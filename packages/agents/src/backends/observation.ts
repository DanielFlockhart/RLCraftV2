import { z } from "zod";
import type { Observation } from "@mlcraft/core";
const sample = z
  .object({
    status: z.enum(["ready", "unavailable", "error"]),
    sampledAt: z.number().int().nonnegative(),
    source: z.string().min(1).max(256),
    data: z.json().optional(),
    reason: z.string().max(4096).optional(),
    durationMs: z.number().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) => value.status !== "ready" || value.data !== undefined,
    "Ready samples require data",
  );
const observationSchema = z
  .object({
    position: z
      .object({ x: z.number(), y: z.number(), z: z.number() })
      .strict(),
    health: z.number(),
    food: z.number(),
    inventory: z.record(z.string(), z.number().nonnegative()),
    tick: z.number().int().nonnegative(),
    inputs: z
      .object({
        schemaVersion: z.literal(1),
        at: z.number().int().nonnegative(),
        tick: z.number().int().nonnegative(),
        sequence: z.number().int().nonnegative(),
        channels: z.record(z.string(), sample),
        diagnostics: z
          .object({
            droppedEvents: z.number().int().nonnegative(),
            droppedBytes: z.number().int().nonnegative(),
            eventBytes: z.number().int().nonnegative(),
            unloadedBlocks: z.number().int().nonnegative().optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
/** JSON-sidecar replies are validated before reaching telemetry or learning code. */
export function parseBackendObservation(value: unknown): Observation {
  const observation = observationSchema.parse(value);
  if (
    observation.inputs.at < Date.now() - 5000 ||
    observation.inputs.at > Date.now() + 250
  )
    throw new Error("Backend returned a stale or future observation frame");
  return observation;
}
