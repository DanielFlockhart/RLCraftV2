import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentInputFrame, AgentState } from "@mlcraft/core";
import { liveGoalInput } from "../apps/dashboard/lib/live-goal.js";

test("live goal input maps player slots, retains unknown items in the display, and uses observed context", () => {
  const agent: AgentState = {
    id: "agent",
    runId: "run",
    username: "agent",
    status: "active",
    ticks: 0,
    reward: 0,
    health: 19,
    food: 18,
  };
  const frame = {
    schemaVersion: 1,
    at: 1,
    tick: 0,
    sequence: 1,
    diagnostics: { droppedEvents: 0, droppedBytes: 0, eventBytes: 0 },
    channels: {
      "self.inventory": {
        status: "ready",
        sampledAt: 1,
        source: "client",
        data: {
          quickBarSlot: 2,
          slots: [
            { slot: 9, item: { name: "oak_planks", count: 4 } },
            { slot: 36, item: { name: "oak_log", count: 2 } },
            { slot: 45, item: { name: "diamond", count: 1 } },
            { slot: 5, item: { name: "iron_helmet", count: 1 } },
          ],
        },
      },
      "self.vitals": {
        status: "ready",
        sampledAt: 1,
        source: "client",
        data: { health: 17, food: 14 },
      },
      "world.blocks": {
        status: "ready",
        sampledAt: 1,
        source: "client",
        data: { blocks: [{ name: "oak_log" }, { name: "iron_ore" }] },
      },
      "world.time": {
        status: "ready",
        sampledAt: 1,
        source: "client",
        data: { isDay: false },
      },
    },
  } as AgentInputFrame;
  const value = liveGoalInput(frame, agent)!;
  assert.deepEqual(
    value.display.slots.map((stack) => stack.slot),
    [9, 0, 40, 39],
  );
  assert.deepEqual(
    value.input.inventory.slots.map((stack) => stack.slot),
    [9, 0],
  );
  assert.equal(value.omitted, 2);
  assert.equal(value.input.context.wood_accessible, true);
  assert.equal(value.input.context.iron_known, true);
  assert.equal(value.input.context.health, 17);
  assert.equal(value.input.context.daytime, false);
});
