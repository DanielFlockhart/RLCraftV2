import { z } from "zod";
import type { RunSpec, RunPlayback, PlaybackCommand } from "@mlcraft/core";
const speed = z.number().min(0.25).max(8);
const seconds = z.number().min(0.1).max(86400);
const steps = z.number().int().min(1).max(100000);
export const playbackSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("speed"), speed }).strict(),
    z
      .object({
        action: z.literal("length"),
        unit: z.enum(["steps", "seconds"]),
        value: z.number().positive(),
      })
      .strict(),
    z.object({ action: z.literal("extend"), seconds }).strict(),
    z
      .object({
        action: z.literal("advance"),
        unit: z.enum(["steps", "seconds", "generation"]),
        value: z.number().positive(),
      })
      .strict(),
    z.object({ action: z.literal("end-generation") }).strict(),
  ])
  .superRefine((command, ctx) => {
    if (command.action === "length" || command.action === "advance") {
      const parsed = (
        command.unit === "steps"
          ? steps
          : command.unit === "generation"
            ? z.literal(1)
            : seconds
      ).safeParse(command.value);
      if (!parsed.success)
        ctx.addIssue({
          code: "custom",
          message: "Invalid step count, seconds or generation increment",
        });
    }
  });
export function initialPlayback(spec: RunSpec): RunPlayback {
  return {
    speed: spec.speed ?? 1,
    ticksPerGeneration:
      spec.component === "environment"
        ? 1
        : spec.generationSeconds !== undefined
          ? 100000
          : spec.ticksPerEpisode,
    ...(spec.component !== "environment" && spec.generationSeconds !== undefined
      ? { generationSeconds: spec.generationSeconds }
      : {}),
  };
}
export function changePlayback(
  current: RunPlayback,
  input: PlaybackCommand,
  spec: RunSpec,
  paused: boolean,
): RunPlayback {
  const command = playbackSchema.parse(input);
  const next = structuredClone(current);
  if (command.action === "speed") next.speed = command.speed;
  else if (command.action === "length") {
    if (spec.component === "environment")
      throw new Error("Connectivity checks have one step per generation");
    if (command.unit === "steps") {
      next.ticksPerGeneration = command.value;
      delete next.generationSeconds;
    } else {
      next.generationSeconds = command.value;
      next.ticksPerGeneration = 100000;
    }
  } else if (command.action === "extend") {
    if (spec.component === "environment")
      throw new Error("Connectivity checks cannot be extended");
    if (next.generationSeconds !== undefined)
      next.generationSeconds = seconds.parse(
        next.generationSeconds + command.seconds,
      );
    else
      next.ticksPerGeneration = steps.parse(
        next.ticksPerGeneration +
          Math.ceil((command.seconds * 1000) / spec.tickMs),
      );
  } else if (command.action === "advance") {
    if (!paused || next.manual)
      throw new Error("Pause training before advancing it manually");
    next.manual = { kind: command.unit, remaining: command.value };
  } else delete next.manual;
  return next;
}
