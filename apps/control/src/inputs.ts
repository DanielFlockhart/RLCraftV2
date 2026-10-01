import { z } from "zod";
import {
  inputCatalog,
  defaultInputs,
  type AgentInputConfig,
} from "@mlcraft/core";
const ids = new Set(inputCatalog.channels.map((c) => c.id));
export const inputConfigSchema = z
  .object({
    channels: z
      .record(
        z.string(),
        z
          .object({
            enabled: z.boolean(),
            intervalMs: z.number().int().min(0).max(60000),
            fields: z.array(z.string()).max(100).optional(),
          })
          .strict(),
      )
      .superRefine((channels, context) => {
        for (const [id, config] of Object.entries(channels)) {
          const descriptor = inputCatalog.channels.find((c) => c.id === id);
          if (!descriptor)
            context.addIssue({
              code: "custom",
              message: `Unknown input channel: ${id}`,
              path: [id],
            });
          if (
            config.fields?.some((field) => !descriptor?.fields.includes(field))
          )
            context.addIssue({
              code: "custom",
              message: "Unknown field selector",
              path: [id, "fields"],
            });
        }
      }),
    limits: z
      .object({
        eventCount: z.number().int().min(16).max(8192),
        eventBytes: z.number().int().min(4096).max(16777216),
        packetBytes: z.number().int().min(1024).max(16777216),
        eventWindowMs: z.number().int().min(100).max(60000),
        blockRadius: z.number().int().min(0).max(8),
        entities: z.number().int().min(1).max(512),
        visionWidth: z.number().int().min(4).max(128),
        visionHeight: z.number().int().min(4).max(96),
        visionDistance: z.number().min(1).max(128),
        visionFov: z.number().min(20).max(140),
        audioSampleRate: z.number().int().min(8000).max(48000),
        audioWindowMs: z.number().int().min(20).max(1000),
      })
      .strict(),
    record: z.boolean(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.limits.packetBytes > config.limits.eventBytes)
      context.addIssue({
        code: "custom",
        message: "Packet limit cannot exceed the event buffer budget",
        path: ["limits", "packetBytes"],
      });
  });
export const captureSchema = z
  .object({
    kind: z.enum(["rgb", "pcm"]),
    sequence: z.number().int().min(0),
    capturedAt: z.number().int().positive(),
    encoding: z.enum(["rgb8", "f32le"]),
    data: z.string().max(1048576),
    width: z.number().int().min(1).max(512).optional(),
    height: z.number().int().min(1).max(512).optional(),
    sampleRate: z.number().int().min(8000).max(48000).optional(),
    channels: z.number().int().min(1).max(2).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (
      Date.now() - value.capturedAt > 2000 ||
      value.capturedAt > Date.now() + 250
    )
      fail("Capture timestamp must be current");
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value.data,
      )
    )
      fail("Invalid base64 media");
    const bytes = Buffer.from(value.data, "base64").length;
    if (value.kind === "rgb") {
      if (
        value.encoding !== "rgb8" ||
        !value.width ||
        !value.height ||
        bytes !== value.width * value.height * 3
      )
        fail("RGB capture requires exact width × height × 3 bytes");
    } else if (
      value.encoding !== "f32le" ||
      !value.sampleRate ||
      !value.channels ||
      bytes % ((value.channels ?? 1) * 4) !== 0 ||
      bytes > value.sampleRate * value.channels * 4
    )
      fail(
        "PCM capture requires interleaved float32 audio of at most one second",
      );
    if (value.kind === "pcm" && value.encoding === "f32le") {
      const buffer = Buffer.from(value.data, "base64");
      for (let i = 0; i + 4 <= buffer.length; i += 4)
        if (!Number.isFinite(buffer.readFloatLE(i))) {
          fail("PCM samples must be finite");
          break;
        }
    }
  });
export const defaultInputConfig = structuredClone(
  defaultInputs,
) as AgentInputConfig;
