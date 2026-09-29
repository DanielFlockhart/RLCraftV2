import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import type { ProgressEvidence, ProgressRecord, Run } from "@rlcraft/core";
import { MinecraftProgress } from "../packages/agents/src/progression.js";
import { Store } from "../apps/control/src/store.js";
import {
  progressionCatalog,
  ownsProgress,
  receiveServerProgress,
  progressRecordSchema,
} from "../apps/control/src/progress.js";
import { archiveDocuments } from "../apps/control/src/archive-documents.js";

function fixture() {
  const writes: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    write: (name: string, data: unknown) => writes.push({ name, data }),
  });
  const bot = Object.assign(new EventEmitter(), {
    _client: client,
    version: "1.18.1",
    username: "rl_abcdef_0",
    game: { gameMode: "survival", dimension: "overworld" },
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      slots: Array.from(
        { length: 46 },
        () => null as null | { name: string; count: number },
      ),
    },
    currentWindow: null,
    blockAt: () => null,
  });
  const evidence: ProgressEvidence[] = [];
  const tracker = new MinecraftProgress(bot as unknown as Bot, (e) =>
    evidence.push(e),
  );
  const packet = (name: string, data: unknown) =>
    client.emit("packet", data, { name, state: "play" });
  return { bot, tracker, evidence, packet, writes };
}

test("every baseline milestone references real 1.18.1 registry entries and a detection rule", () => {
  const data = minecraftData("1.18.1");
  assert.equal(progressionCatalog.steps.length, 75);
  assert.equal(new Set(progressionCatalog.steps.map((s) => s.id)).size, 75);
  for (const step of progressionCatalog.steps) {
    assert(step.instructions.length > 0 && step.minimum && step.items);
    assert(step.rules.length);
    for (const rule of step.rules) {
      if (rule.kind === "inventory")
        for (const item of rule.items ?? [])
          assert(data.itemsByName[item], `${step.id}: ${item}`);
      if (rule.kind === "block")
        for (const name of rule.names) assert(data.blocksByName[name], name);
      if (rule.kind === "statistic")
        for (const name of rule.names)
          assert(
            (rule.category === "mined"
              ? data.blocksByName
              : rule.category === "killed"
                ? data.entitiesByName
                : data.itemsByName)[name],
            `${step.id}: ${name}`,
          );
    }
  }
});

test("supplied inventory proves possession, not crafting, and cleanup stops collection", () => {
  const f = fixture();
  try {
    f.tracker.setOrigin("setup");
    f.bot.inventory.slots[36] = { name: "ender_eye", count: 12 };
    f.tracker.sample();
    assert(
      f.evidence.some(
        (e) => e.milestoneId === "eyes-twelve" && e.origin === "setup",
      ),
    );
    assert(!f.evidence.some((e) => e.milestoneId === "craft-eye"));
    assert(
      !f.evidence.some(
        (e) => e.milestoneId === "rod" || e.milestoneId === "enter-nether",
      ),
    );
    const count = f.evidence.length;
    f.tracker.sample();
    assert.equal(f.evidence.length, count);
    f.tracker.close();
    f.bot.inventory.slots[37] = { name: "blaze_rod", count: 6 };
    f.tracker.sample();
    assert.equal(f.evidence.length, count);
    assert.equal(f.bot._client.listenerCount("packet"), 0);
  } finally {
    f.tracker.close();
  }
});

test("advancements evaluate AND-of-OR criteria, retain partial updates and ignore nearby dragon death", () => {
  const f = fixture();
  try {
    const id = "minecraft:end/kill_dragon";
    f.packet("advancements", {
      reset: true,
      advancementMapping: [
        { key: id, value: { requirements: [["a", "b"], ["c"]] } },
      ],
      progressMapping: [
        {
          key: id,
          value: [{ criterionIdentifier: "a", criterionProgress: [0, 1] }],
        },
      ],
    });
    f.tracker.sample();
    assert(!f.evidence.some((e) => e.milestoneId === "kill-dragon"));
    f.packet("entity_destroy", { entityIds: [1] });
    assert(!f.evidence.some((e) => e.milestoneId === "kill-dragon"));
    f.packet("advancements", {
      progressMapping: [
        {
          key: id,
          value: [{ criterionIdentifier: "c", criterionProgress: [0, 2] }],
        },
      ],
    });
    f.tracker.sample();
    assert(f.evidence.some((e) => e.milestoneId === "kill-dragon"));
    assert(f.evidence.some((e) => e.milestoneId === "fight-dragon"));
    assert(!f.evidence.some((e) => e.milestoneId === "credits"));
  } finally {
    f.tracker.close();
  }
});

test("previous advancement/statistic totals are labeled existing and statistics requests are bounded", () => {
  const f = fixture();
  try {
    const id = "minecraft:nether/obtain_blaze_rod";
    f.packet("advancements", {
      reset: true,
      advancementMapping: [{ key: id, value: { requirements: [["rod"]] } }],
      progressMapping: [
        {
          key: id,
          value: [{ criterionIdentifier: "rod", criterionProgress: [0, 1] }],
        },
      ],
    });
    f.tracker.sample();
    assert(
      f.evidence.some(
        (e) => e.milestoneId === "rod" && e.origin === "existing",
      ),
    );
    const eye = minecraftData("1.18.1").itemsByName.ender_eye.id;
    f.packet("statistics", {
      entries: [{ categoryId: 1, statisticId: eye, value: 2 }],
    });
    assert(
      f.evidence.some(
        (e) => e.milestoneId === "craft-eye" && e.origin === "existing",
      ),
    );
    f.tracker.sample(true);
    f.tracker.sample(true);
    assert.deepEqual(f.writes, [
      { name: "client_command", data: { actionId: 1 } },
    ]);
  } finally {
    f.tracker.close();
  }
});

test("End return requires win event: ordinary respawn/dimension change is not victory", () => {
  const f = fixture();
  try {
    f.packet("game_state_change", { reason: "win_game", gameMode: 1 });
    f.tracker.sample();
    assert(!f.evidence.some((e) => e.milestoneId === "credits"));
    f.bot.game.dimension = "the_end";
    f.tracker.sample();
    assert(f.evidence.some((e) => e.milestoneId === "enter-end"));
    f.bot.game.dimension = "overworld";
    f.tracker.sample();
    assert(!f.evidence.some((e) => e.milestoneId === "return-end"));
    f.bot.game.dimension = "the_end";
    f.tracker.sample();
    f.packet("game_state_change", { reason: "win_game", gameMode: 1 });
    f.bot.game.dimension = "overworld";
    f.tracker.sample();
    assert(f.evidence.some((e) => e.milestoneId === "credits"));
    assert(f.evidence.some((e) => e.milestoneId === "return-end"));
    assert(!f.evidence.some((e) => e.milestoneId === "kill-dragon"));
  } finally {
    f.tracker.close();
  }
});

function record(runId = randomUUID(), gameMode = "survival"): ProgressRecord {
  return {
    runId,
    agentId: `${runId}:0`,
    username: `rl_${runId.slice(0, 6)}_0`,
    minecraftVersion: "1.18.1",
    episode: 1,
    at: 100,
    milestoneId: "rod",
    source: "inventory",
    detail: "Observed blaze rod",
    gameMode,
    origin: "live",
  };
}
test("progress survives restart, deduplicates modes/agents, scopes runs and survives telemetry pruning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rlcraft-progress-"));
  let store = new Store(join(dir, "test.sqlite"));
  try {
    const a = record(undefined, "creative");
    const b = record();
    assert(store.saveProgress(a));
    assert(!store.saveProgress(a));
    assert(store.saveProgress({ ...a, gameMode: "survival", at: 200 }));
    assert(store.saveProgress(b));
    assert.equal(store.progress()[0].agents, 2);
    assert.equal(store.progress()[0].survivalAgents, 2);
    assert.equal(store.progress(a.runId)[0].agents, 1);
    assert.equal(store.progress(a.runId)[0].first?.gameMode, "creative");
    assert.equal(store.progress(a.runId)[0].firstSurvival?.at, 200);
    store.prune();
    store.close();
    store = new Store(join(dir, "test.sqlite"));
    assert.equal(store.progress()[0].agents, 2);
    assert(!store.saveProgress({ ...b, milestoneId: "made-up" }));
    assert(!store.saveProgress({ ...b, minecraftVersion: "1.21.1" }));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("server attribution requires the private logger prefix and active registered ownership", () => {
  const store = new Store(":memory:");
  try {
    const r = record();
    assert(ownsProgress(r.runId, 1, r));
    assert(!ownsProgress(r.runId, 1, { ...r, username: "rl_aaaaaa_0" }));
    const line = `[12:00:00] [Server thread/INFO]: [RLCraftViewerGuard] RLCRAFT_PROGRESS ${r.username} fight-dragon survival`;
    assert(!receiveServerProgress(store, line));
    store.saveRun({
      id: r.runId,
      spec: { mode: "minecraft", agents: 1 },
      status: "running",
      episode: 2,
    } as Run);
    store.saveAgents([
      {
        id: r.agentId,
        runId: r.runId,
        username: r.username,
        status: "active",
        ticks: 1,
        reward: 0,
        health: 20,
      },
    ]);
    assert(
      !receiveServerProgress(
        store,
        `[12:00:00] [Server thread/INFO]: <${r.username}> [RLCraftViewerGuard] RLCRAFT_PROGRESS ${r.username} fight-dragon survival`,
      ),
    );
    assert(receiveServerProgress(store, line));
    assert(
      receiveServerProgress(
        store,
        `[12:00:01 INFO]: [RLCraftViewerGuard] RLCRAFT_PROGRESS ${r.username} blaze-seen survival`,
      ),
    );
    assert(
      !receiveServerProgress(
        store,
        `[12:00:02 INFO]: <${r.username}> [RLCraftViewerGuard] RLCRAFT_PROGRESS ${r.username} crystal survival`,
      ),
    );
    assert.equal(store.progress()[0].first?.source, "server-event");
    assert.equal(store.progress()[0].first?.episode, 2);
    assert(
      !progressRecordSchema.safeParse({ ...r, milestoneId: "not-real" })
        .success,
    );
  } finally {
    store.close();
  }
});

test("progress and tracking metadata use the durable Firebase outbox when enabled", () => {
  const store = new Store(":memory:");
  try {
    store.archive.configure("test-cloud");
    const r = record();
    store.saveProgress(r);
    store.saveProgressAgent({
      runId: r.runId,
      agentId: r.agentId,
      username: r.username,
      backend: "mineflayer",
      minecraftVersion: "1.18.1",
      supported: true,
      startedAt: 1,
    });
    const events = store.archive.batch();
    assert.equal(events.length, 2);
    assert(events.some((e) => e.kind === "progress"));
    const docs = archiveDocuments(events);
    assert(docs.some((d) => d.path.startsWith("progress/")));
    assert(docs.some((d) => d.path.startsWith("progressAgents/")));
  } finally {
    store.close();
  }
});
