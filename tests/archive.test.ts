import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/control/src/store.js";
import { CloudArchive, type ArchiveSink } from "../apps/control/src/archive.js";
import { archiveDocuments } from "../apps/control/src/archive-documents.js";
import { artifactFiles } from "../apps/control/src/firebase-archive.js";
import { createFirebaseArchive } from "../apps/control/src/firebase-archive.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cert } from "firebase-admin/app";
import { generateKeyPairSync } from "node:crypto";
import type { ArchiveEvent } from "../apps/control/src/archive-queue.js";

test("local storage performs no archive work; enabled events survive pruning/restart and destination changes are guarded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rlcraft-archive-"));
  const path = join(dir, "state.sqlite");
  let store = new Store(path);
  try {
    store.log({ at: 1, source: "test", level: "info", message: "Local only" });
    assert.equal(store.archive.pending(), 0);
    const disabled = new CloudArchive(store.archive);
    assert.equal(disabled.snapshot().provider, "local");
    await disabled.sync(true);
    const runtimeId = store.archive.runtimeId;
    store.archive.configure("destination-A");
    store.log({
      at: 2,
      source: "test",
      level: "info",
      message: "Durable event",
    });
    store.host({ at: 3, cpuPercent: 1, memoryMb: 20, eventLoopMs: 0 });
    store.archive.artifacts("11111111-1111-4111-8111-111111111111");
    store.prune();
    const before = store.archive.batch();
    assert.equal(before.length, 3);
    store.close();
    store = new Store(path);
    assert.equal(store.archive.runtimeId, runtimeId);
    assert.deepEqual(store.archive.batch(), before);
    assert.throws(
      () => store.archive.configure("destination-B"),
      /pending uploads/,
    );
    store.archive.configure("destination-A");
    store.archive.ack(before.at(-1)!.id);
    store.log({
      at: 4,
      source: "test",
      level: "info",
      message: "After acknowledgement",
    });
    assert.ok(store.archive.batch()[0].id > before.at(-1)!.id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cloud failures preserve queued data, retries are idempotent, concurrent syncs do not overlap and new records are not acknowledged early", async () => {
  const store = new Store(":memory:");
  store.archive.configure("test-cloud");
  store.log({
    at: 1,
    source: "test",
    level: "info",
    message: "Before failure",
  });
  let attempts = 0;
  let release!: () => void;
  const writes: ReturnType<typeof archiveDocuments>[] = [];
  const sink: ArchiveSink = {
    async write(_id, events) {
      writes.push(archiveDocuments(events));
      attempts++;
      if (attempts === 1) throw new Error("Cloud unavailable");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    async close() {},
  };
  const archive = new CloudArchive(store.archive, async () => sink);
  try {
    await archive.sync();
    assert.equal(store.archive.pending(), 1);
    assert.match(archive.snapshot().error!, /Cloud unavailable/);
    await archive.sync();
    assert.equal(attempts, 1, "Automatic retry should respect backoff");
    const retry = archive.sync(true);
    assert.equal(archive.sync(true), retry);
    await new Promise((resolve) => setImmediate(resolve));
    store.log({
      at: 2,
      source: "test",
      level: "info",
      message: "During upload",
    });
    release();
    await retry;
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(
      store.archive.pending(),
      1,
      "Only the uploaded prefix is acknowledged",
    );
    assert.equal(archive.snapshot().error, undefined);
    assert.ok(archive.snapshot().lastSyncedAt);
  } finally {
    await archive.close();
    store.close();
  }
});

test("cloud shutdown aborts work and retains its retry queue", async () => {
  const store = new Store(":memory:");
  store.archive.configure("test-cloud");
  store.log({ at: 1, source: "test", level: "info", message: "Pending" });
  const archive = new CloudArchive(store.archive, async () => ({
    async write(_id, _events, signal) {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
    async close() {},
  }));
  void archive.sync();
  await new Promise((resolve) => setImmediate(resolve));
  await archive.close();
  assert.equal(store.archive.pending(), 1);
  store.close();
});

test("Firestore telemetry is grouped by run into bounded batches while state updates and preset deletion coalesce", () => {
  const event = (
    id: number,
    kind: ArchiveEvent["kind"],
    key: string,
    body: unknown,
  ): ArchiveEvent => ({ id, kind, key, body: JSON.stringify(body) });
  const result = archiveDocuments([
    event(1, "runs", "run-a", { status: "running" }),
    event(2, "runs", "run-a", { status: "completed" }),
    event(3, "logs", "1", { runId: "run-a", at: 1, message: "one" }),
    event(4, "logs", "2", { runId: "run-a", at: 2, message: "two" }),
    event(5, "logs", "3", { at: 3, message: "global" }),
    event(6, "metrics", "1", { runId: "run-a", at: 4, reward: 2 }),
    event(7, "presets", "preset-a", { name: "Deleted later" }),
    event(8, "preset-delete", "preset-a", null),
  ]);
  assert.deepEqual(result.find((doc) => doc.path === "runs/run-a")!.value, {
    status: "completed",
  });
  assert.equal(
    result.find((doc) => doc.path === "presets/preset-a")!.value,
    null,
  );
  assert.equal(
    result.find((doc) => doc.path === "logBatches/3")!.value!.count,
    2,
  );
  assert.equal(
    result.find((doc) => doc.path === "logBatches/5")!.value!.runId,
    null,
  );
  assert.equal(result.length, 5);
  const store = new Store(":memory:");
  try {
    store.archive.configure("test-cloud");
    for (let i = 0; i < 200; i++)
      store.log({
        at: i,
        source: "test",
        level: "info",
        message: "x".repeat(8192),
      });
    const batch = store.archive.batch();
    assert.ok(batch.length < 200);
    assert.ok(
      Buffer.byteLength(JSON.stringify(archiveDocuments(batch))) < 300 * 1024,
    );
  } finally {
    store.close();
  }
});

test("model archiving includes only run artifacts/models and rejects links", async () => {
  const root = await mkdtemp(join(tmpdir(), "rlcraft-models-"));
  const runId = "11111111-1111-4111-8111-111111111111";
  const run = join(root, runId);
  try {
    await mkdir(join(run, "models", "episode-1"), { recursive: true });
    await writeFile(join(run, "config.json"), "{}");
    await writeFile(
      join(run, "models.json"),
      '{"source":"runtime","variants":[]}',
    );
    await writeFile(
      join(run, "controls.jsonl"),
      '{"action":"speed","speed":2}\n',
    );
    await writeFile(
      join(run, "models", "episode-1", "weights.bin"),
      Buffer.from([1, 2, 3]),
    );
    await writeFile(join(run, "private-notes.txt"), "Do not upload");
    const files = await artifactFiles(root, runId);
    assert.deepEqual(files.map((file) => file.name).sort(), [
      "config.json",
      "controls.jsonl",
      "models.json",
      "models/episode-1/weights.bin",
    ]);
    assert.equal(
      files.find((file) => file.name.endsWith("weights.bin"))!.bytes,
      3,
    );
    await assert.rejects(artifactFiles(root, "../../world"), /Invalid/);
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(
      outside,
      join(run, "models", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(artifactFiles(root, runId), /links/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Firebase Admin adapter sends real Firestore REST batches to an isolated test endpoint using synthetic credentials", async () => {
  const previousHost = process.env.FIRESTORE_EMULATOR_HOST;
  const requests: { writes: unknown[] }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
      writes: unknown[];
    };
    requests.push(payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        commitTime: "2026-09-28T12:00:00Z",
        writeResults: payload.writes.map(() => ({
          updateTime: "2026-09-28T12:00:00Z",
        })),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const sink = createFirebaseArchive(
    {
      projectId: "demo-rlcraft",
      bucket: "demo-rlcraft.firebasestorage.app",
      prefix: "rlcraftRuntimes",
      artifactDir: ".",
    },
    cert({
      projectId: "demo-rlcraft",
      clientEmail: "test@demo-rlcraft.iam.gserviceaccount.com",
      privateKey: key,
    }),
  );
  try {
    await sink.write(
      "runtime-test",
      [
        {
          id: 1,
          kind: "runs",
          key: "run-test",
          body: JSON.stringify({ status: "completed" }),
        },
        {
          id: 2,
          kind: "metrics",
          key: "1",
          body: JSON.stringify({ runId: "run-test", at: 1, reward: 0 }),
        },
        { id: 3, kind: "preset-delete", key: "deleted-preset", body: "null" },
      ],
      new AbortController().signal,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].writes.length, 3);
    const encoded = JSON.stringify(requests[0]);
    assert.match(encoded, /rlcraftRuntimes\/runtime-test\/runs\/run-test/);
    assert.match(encoded, /metricBatches\/2/);
    assert.match(encoded, /"delete"/);
  } finally {
    await sink.close();
    if (previousHost === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
    else process.env.FIRESTORE_EMULATOR_HOST = previousHost;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
