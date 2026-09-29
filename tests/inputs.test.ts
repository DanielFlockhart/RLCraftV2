import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { defaultInputs, type AgentInputConfig } from "@rlcraft/core";
import { MinecraftInputs } from "../packages/agents/src/inputs/minecraft.js";
import { InputEvents } from "../packages/agents/src/inputs/events.js";
import { inputJson } from "../packages/agents/src/inputs/serialize.js";
import { protocolCatalog } from "../packages/agents/src/inputs/catalog.js";
import { geometryVision } from "../packages/agents/src/inputs/vision.js";
import {
  captureSchema,
  inputConfigSchema,
} from "../apps/control/src/inputs.js";
function fixture() {
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    version: "1.18.1",
    username: "agent",
    entity: {
      id: 1,
      position: new Vec3(0.5, 64, 0.5),
      height: 1.8,
      width: 0.6,
      yaw: 0,
      pitch: 0,
    },
    entities: {},
    health: 20,
    food: 18,
    foodSaturation: 5,
    oxygenLevel: 20,
  });
  return bot as unknown as Bot;
}
test("input schema rejects unknown channels, field masks, costs and malformed captures", () => {
  const config: AgentInputConfig = structuredClone(defaultInputs);
  assert.ok(inputConfigSchema.safeParse(config).success);
  config.channels["server.exhaustion"] = { enabled: true, intervalMs: 0 };
  assert.ok(!inputConfigSchema.safeParse(config).success);
  delete config.channels["server.exhaustion"];
  config.channels["self.vitals"].fields = ["exhaustion"];
  assert.ok(!inputConfigSchema.safeParse(config).success);
  assert.ok(
    !captureSchema.safeParse({
      kind: "rgb",
      encoding: "rgb8",
      sequence: 1,
      capturedAt: Date.now(),
      width: 1,
      height: 1,
      data: Buffer.alloc(4).toString("base64"),
    }).success,
  );
  const invalid = Buffer.alloc(4);
  invalid.writeFloatLE(NaN);
  assert.ok(
    !captureSchema.safeParse({
      kind: "pcm",
      encoding: "f32le",
      sequence: 1,
      capturedAt: Date.now(),
      sampleRate: 16000,
      channels: 1,
      data: invalid.toString("base64"),
    }).success,
  );
});
test("field masks remove unselected state and events are non-consuming, bounded and ordered", () => {
  const config: AgentInputConfig = structuredClone(defaultInputs);
  for (const c of Object.values(config.channels)) c.enabled = false;
  config.channels["self.vitals"] = {
    enabled: true,
    intervalMs: 0,
    fields: ["health"],
  };
  config.channels["events.messages"] = { enabled: true, intervalMs: 0 };
  const bot = fixture(),
    inputs = new MinecraftInputs(bot, config);
  try {
    bot.emit("messagestr", "hello", "chat", { text: "hello" } as any);
    const first = inputs.observe(0),
      second = inputs.observe(1);
    assert.deepEqual(first.channels["self.vitals"].data, { health: 20 });
    assert.ok(!first.channels["self.pose"]);
    assert.deepEqual(
      first.channels["events.messages"].data,
      second.channels["events.messages"].data,
    );
    assert.equal(first.channels["events.messages"].status, "ready");
  } finally {
    inputs.close();
  }
  const ring = new InputEvents(2, 1000, 1000, 1000);
  ring.push("a", "one", 1, 0);
  ring.push("a", "two", 2, 1);
  ring.push("a", "three", 3, 2);
  assert.equal(ring.diagnostics.droppedEvents, 1);
  assert.deepEqual(
    ring.read("a", 2).map((e) => e.sequence),
    [2, 3],
  );
  assert.equal(ring.read("a", 2000).length, 0);
});
test("protocol catalog covers every current PLAY packet and capture excludes authentication", () => {
  const catalog = protocolCatalog("1.18.1");
  assert.equal(catalog.clientboundPlayPackets.length, 104);
  assert.ok(catalog.clientboundPlayPackets.every((packet) => packet.schema));
  const config: AgentInputConfig = structuredClone(defaultInputs);
  for (const c of Object.values(config.channels)) c.enabled = false;
  config.channels["protocol.packets"] = { enabled: true, intervalMs: 0 };
  const bot = fixture(),
    inputs = new MinecraftInputs(bot, config);
  try {
    bot._client.emit(
      "packet",
      { token: "not captured" },
      { state: "login", name: "encryption_begin" },
    );
    bot._client.emit(
      "packet",
      { payload: Buffer.from([1, 2]), value: 12345678901234567890n },
      { state: "play", name: "custom_payload" },
    );
    const events = (inputs.observe(0).channels["protocol.packets"].data as any)
      .events;
    assert.equal(events.length, 1);
    assert.equal(events[0].data.payload.data, "AQI=");
    assert.equal(events[0].data.value.value, "12345678901234567890");
  } finally {
    inputs.close();
  }
  assert.deepEqual(inputJson(Infinity), {
    type: "nonFinite",
    value: "Infinity",
  });
});
test("first-person geometry reflects block changes, does not treat unloaded terrain as air, and capture freshness is enforced", () => {
  const bot = fixture();
  let wall = true;
  bot.blockAt = ((point: Vec3) =>
    point.z === -2 && wall
      ? { name: "stone", stateId: 1, shapes: [[0, 0, 0, 1, 1, 1]] }
      : point.z < -3
        ? null
        : { name: "air", stateId: 0, shapes: [] }) as any;
  const limits = {
    ...defaultInputs.limits,
    visionWidth: 4,
    visionHeight: 4,
    visionFov: 20,
    visionDistance: 8,
  };
  const seen = geometryVision(bot, limits);
  assert.ok(seen.stateIds.includes(1));
  wall = false;
  const unloaded = geometryVision(bot, limits);
  assert.ok(unloaded.valid.some((valid) => !valid));
  assert.ok(unloaded.depth.some((value) => value === null));
  const config: AgentInputConfig = structuredClone(defaultInputs);
  for (const c of Object.values(config.channels)) c.enabled = false;
  config.channels["vision.rgb"] = { enabled: true, intervalMs: 0 };
  const inputs = new MinecraftInputs(bot, config);
  try {
    assert.equal(
      inputs.observe(0).channels["vision.rgb"].status,
      "unavailable",
    );
    const frame = {
      kind: "rgb" as const,
      encoding: "rgb8" as const,
      sequence: 1,
      capturedAt: Date.now(),
      width: 1,
      height: 1,
      data: "AAAA",
    };
    inputs.capture(frame);
    assert.equal(inputs.observe(0).channels["vision.rgb"].status, "ready");
    assert.throws(() => inputs.capture(frame), /sequence/);
    inputs.capture({ ...frame, sequence: 2, capturedAt: Date.now() - 3000 });
    assert.equal(
      inputs.observe(0).channels["vision.rgb"].status,
      "unavailable",
    );
  } finally {
    inputs.close();
  }
});
