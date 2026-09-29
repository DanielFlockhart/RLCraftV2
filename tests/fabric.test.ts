import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  defaultInputs,
  type RunSpec,
  type Environment,
  type CaptureFrame,
} from "@rlcraft/core";
import {
  parseRgbFrame,
  offlineUuid,
} from "../packages/agents/src/backends/fabric.js";
import { renderSchema } from "../packages/runtime/src/fabric.js";
import { selectedEnvironment } from "../packages/agents/src/backends/selected.js";
import { Scheduler } from "../apps/control/src/scheduler.js";
import { Store } from "../apps/control/src/store.js";
import { config } from "../apps/control/src/config.js";

const rgb = (): CaptureFrame => ({
  kind: "rgb",
  encoding: "rgb8",
  width: 2,
  height: 1,
  sequence: 1,
  capturedAt: Date.now(),
  data: Buffer.from([255, 0, 0, 0, 255, 0]).toString("base64"),
});
test("RGB feed validates dimensions, bytes, timestamps and rejects stale frames", () => {
  const frame = rgb();
  assert.deepEqual(parseRgbFrame(frame), frame);
  assert.equal(parseRgbFrame(null), undefined);
  assert.equal(
    parseRgbFrame({ ...rgb(), capturedAt: Date.now() - 2001 }),
    undefined,
  );
  assert.throws(
    () => parseRgbFrame({ ...rgb(), capturedAt: Date.now() + 5000 }),
    /Future/,
  );
  assert.throws(() => parseRgbFrame({ ...rgb(), data: "AAAA" }), /byte count/);
  assert.throws(() => parseRgbFrame({ ...rgb(), width: 1024 }));
  assert.throws(() => parseRgbFrame({ ...rgb(), data: "@@@" }));
});
test("renderer settings bound GPU/capture budgets and native offline identity is deterministic", () => {
  assert.equal(renderSchema.parse(undefined).fps, 10);
  assert.throws(() =>
    renderSchema.parse({ ...renderSchema.parse(undefined), fps: 1000 }),
  );
  assert.throws(() =>
    renderSchema.parse({ ...renderSchema.parse(undefined), width: 4096 }),
  );
  assert.equal(offlineUuid("Notch"), "b50ad385829d3141a2167e7d7539ba7f");
});
test("administrative camera survives selected-input masking without adding policy RGB", async () => {
  const inputs = structuredClone(defaultInputs);
  for (const channel of Object.values(inputs.channels)) channel.enabled = false;
  const frame = rgb();
  const environment: Environment = {
    async connect() {},
    async close() {},
    async apply() {},
    async feed() {
      return frame;
    },
    observe(tick) {
      return {
        tick,
        position: { x: 0, y: 0, z: 0 },
        health: 20,
        food: 20,
        inventory: {},
        inputs: {
          schemaVersion: 1,
          at: Date.now(),
          tick,
          sequence: 1,
          channels: {
            "vision.rgb": {
              status: "ready",
              source: "vanilla-framebuffer",
              sampledAt: Date.now(),
              data: { frame: frame as any },
            },
          },
          diagnostics: { droppedEvents: 0, droppedBytes: 0, eventBytes: 0 },
        },
      };
    },
  };
  const selected = selectedEnvironment(environment, inputs);
  assert.deepEqual((await selected.observe(0)).inputs!.channels, {});
  assert.deepEqual(await selected.feed!(), frame);
});
test("renderer slots gate queued runs independently and agent feeds require ownership", async () => {
  const old = config.MAX_RENDER_CLIENTS;
  config.MAX_RENDER_CLIENTS = 1;
  const store = new Store(":memory:");
  const launched: {
    id: string;
    process: EventEmitter & {
      connected: boolean;
      send: (message: any, callback?: any) => void;
    };
  }[] = [];
  const scheduler = new Scheduler(store, () => {}, {
    launch(run) {
      const process = Object.assign(new EventEmitter(), {
        connected: true,
        send(message: any, callback?: any) {
          if (message.type === "feed-request")
            queueMicrotask(() =>
              process.emit("message", {
                type: "feed",
                requestId: message.requestId,
                frame: rgb(),
              }),
            );
          if (message.type === "cancel")
            queueMicrotask(() => process.emit("close", 0));
          callback?.();
        },
        kill() {
          queueMicrotask(() => process.emit("close", 0));
          return true;
        },
      });
      launched.push({ id: run.id, process });
      return process as unknown as ChildProcess;
    },
  });
  const spec: RunSpec = {
    backend: "fabric",
    mode: "minecraft",
    stage: "movement",
    component: "pipeline",
    agents: 1,
    episodes: 1,
    ticksPerEpisode: 1,
    tickMs: 100,
    seed: 42,
  };
  try {
    assert.throws(
      () => scheduler.enqueue({ ...spec, agents: 2 }),
      /renderer capacity/,
    );
    const a = scheduler.enqueue(spec),
      b = scheduler.enqueue(spec);
    assert.equal(launched.length, 1);
    assert.equal(store.getRun(b.id)!.status, "queued");
    store.saveAgents([
      {
        id: `${a.id}:0`,
        runId: a.id,
        username: `rl_${a.id.slice(0, 6)}_0`,
        status: "active",
        ticks: 0,
        reward: 0,
        health: 20,
      },
    ]);
    assert.throws(
      () => scheduler.viewAgent(a.id, "rl_aaaaaa_0"),
      /No connected agent/,
    );
    assert.throws(
      () => scheduler.viewAgent(randomUUID(), `rl_${a.id.slice(0, 6)}_0`),
      /No connected agent/,
    );
    assert.equal(
      (await scheduler.viewAgent(a.id, `rl_${a.id.slice(0, 6)}_0`))!.kind,
      "rgb",
    );
    assert.equal(scheduler.renderClients(), 1);
  } finally {
    await scheduler.close();
    store.close();
    config.MAX_RENDER_CLIENTS = old;
  }
});
