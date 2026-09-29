import type { ArchiveEvent } from "./archive-queue.js";

export interface ArchiveDocument {
  path: string;
  value: Record<string, unknown> | null;
}

/** Stable document IDs make a retried batch safe after a partial cloud failure. */
export function archiveDocuments(events: ArchiveEvent[]): ArchiveDocument[] {
  const documents = new Map<string, ArchiveDocument>();
  const batches = new Map<
    string,
    { path: string; value: Record<string, unknown>; records: unknown[] }
  >();
  for (const event of events) {
    const value = JSON.parse(event.body) as Record<string, unknown>;
    if (event.kind === "artifacts") continue;
    if (
      [
        "runs",
        "progress",
        "progress-agents",
        "presets",
        "preset-delete",
        "arena-presets",
        "arena-preset-delete",
      ].includes(event.kind)
    ) {
      const path = `${event.kind === "runs" ? "runs" : event.kind === "progress" ? "progress" : event.kind === "progress-agents" ? "progressAgents" : event.kind.startsWith("arena-") ? "arenaPresets" : "presets"}/${event.key}`;
      documents.set(path, {
        path,
        value: event.kind.endsWith("delete") ? null : value,
      });
      continue;
    }
    const collection =
      event.kind === "host"
        ? "hostBatches"
        : event.kind === "logs"
          ? "logBatches"
          : "metricBatches";
    const runId = typeof value.runId === "string" ? value.runId : null;
    const group = `${collection}:${runId ?? "global"}`;
    let batch = batches.get(group);
    if (!batch) {
      const records: unknown[] = [];
      batch = {
        path: `${collection}/${event.id}`,
        value: {
          schemaVersion: 1,
          runId,
          firstAt: value.at,
          lastAt: value.at,
          count: 0,
          records,
        },
        records,
      };
      batches.set(group, batch);
    }
    batch.records.push({ sequence: event.id, value });
    batch.value.lastAt = value.at;
    batch.value.count = batch.records.length;
  }
  return [
    ...documents.values(),
    ...Array.from(batches.values(), ({ path, value }) => ({ path, value })),
  ];
}
