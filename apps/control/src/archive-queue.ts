import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface ArchiveEvent {
  id: number;
  kind:
    | "runs"
    | "progress"
    | "progress-agents"
    | "presets"
    | "preset-delete"
    | "arena-presets"
    | "arena-preset-delete"
    | "logs"
    | "metrics"
    | "host"
    | "artifacts";
  key: string;
  body: string;
}

/** A transactional outbox: SQLite triggers commit archive events with live state. */
export class ArchiveQueue {
  readonly runtimeId: string;
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_settings(id INTEGER PRIMARY KEY CHECK(id=1), runtime_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, target TEXT);
      CREATE TABLE IF NOT EXISTS archive_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL);
    `);
    db.prepare(
      "INSERT OR IGNORE INTO archive_settings(id,runtime_id) VALUES(1,?)",
    ).run(randomUUID());
    this.runtimeId = db
      .prepare("SELECT runtime_id FROM archive_settings WHERE id=1")
      .get()!.runtime_id as string;
    for (const [table, kind, key, actions] of [
      ["runs", "runs", "NEW.id", ["INSERT", "UPDATE"]],
      [
        "progress_evidence",
        "progress",
        "NEW.agent_id || ':' || NEW.milestone_id || ':' || NEW.eligible",
        ["INSERT"],
      ],
      [
        "progress_agents",
        "progress-agents",
        "NEW.agent_id",
        ["INSERT", "UPDATE"],
      ],
      ["agent_presets", "presets", "NEW.id", ["INSERT", "UPDATE"]],
      ["arena_presets", "arena-presets", "NEW.id", ["INSERT", "UPDATE"]],
      ["logs", "logs", "CAST(NEW.id AS TEXT)", ["INSERT"]],
      ["metrics", "metrics", "CAST(NEW.id AS TEXT)", ["INSERT"]],
      ["host_metrics", "host", "CAST(NEW.id AS TEXT)", ["INSERT"]],
    ] as const) {
      for (const action of actions)
        db.exec(`
        CREATE TRIGGER IF NOT EXISTS archive_${table}_${action.toLowerCase()} AFTER ${action} ON ${table}
        WHEN (SELECT enabled FROM archive_settings WHERE id=1)=1 BEGIN
          INSERT INTO archive_outbox(kind,key,body) VALUES('${kind}',${key},NEW.body);
        END;
      `);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS archive_preset_delete AFTER DELETE ON agent_presets
      WHEN (SELECT enabled FROM archive_settings WHERE id=1)=1 BEGIN
        INSERT INTO archive_outbox(kind,key,body) VALUES('preset-delete',OLD.id,'null'); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS archive_arena_preset_delete AFTER DELETE ON arena_presets
      WHEN (SELECT enabled FROM archive_settings WHERE id=1)=1 BEGIN
        INSERT INTO archive_outbox(kind,key,body) VALUES('arena-preset-delete',OLD.id,'null'); END;`);
  }
  configure(target?: string) {
    const current = this.db
      .prepare("SELECT target FROM archive_settings WHERE id=1")
      .get()!.target;
    if (target && current && current !== target && this.pending())
      throw new Error(
        "Archive destination changed with pending uploads. Drain the existing destination before changing project/bucket/prefix.",
      );
    this.db
      .prepare(
        "UPDATE archive_settings SET enabled=?,target=COALESCE(?,target) WHERE id=1",
      )
      .run(target ? 1 : 0, target ?? null);
  }
  pending() {
    return Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM archive_outbox").get()!
        .count,
    );
  }
  batch(): ArchiveEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM archive_outbox ORDER BY id LIMIT 200")
      .all() as unknown as ArchiveEvent[];
    let bytes = 0;
    return rows.filter((row, index) => {
      bytes += Buffer.byteLength(row.body) + 512;
      return index === 0 || bytes <= 256 * 1024;
    });
  }
  ack(lastId: number) {
    this.db.prepare("DELETE FROM archive_outbox WHERE id<=?").run(lastId);
  }
  artifacts(runId: string) {
    this.db
      .prepare(
        "INSERT INTO archive_outbox(kind,key,body) SELECT 'artifacts',?,? WHERE (SELECT enabled FROM archive_settings WHERE id=1)=1",
      )
      .run(runId, JSON.stringify({ runId }));
  }
}
