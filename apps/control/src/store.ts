import { DatabaseSync } from "node:sqlite";
import { ArchiveQueue } from "./archive-queue.js";
import { progressRecordSchema, progressAgentSchema } from "./progress.js";
import type {
  ProgressRecord,
  ProgressAgent,
  ProgressSummary,
} from "@mlcraft/core";
import type {
  AgentState,
  HostMetric,
  LogEntry,
  Metric,
  Run,
  MotorFullRun,
  MotorTerrainRun,
  CombatFullRun,
  AgentPreset,
  ArenaPreset,
} from "@mlcraft/core";
export class Store {
  private db: DatabaseSync;
  readonly archive: ArchiveQueue;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS motor_full_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS motor_terrain_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS combat_full_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metrics(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS metrics_run_at ON metrics(run_id,at);
      CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, run_id TEXT, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_run ON logs(run_id,id);
      CREATE TABLE IF NOT EXISTS host_metrics(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_presets(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS arena_presets(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress_evidence(run_id TEXT NOT NULL, agent_id TEXT NOT NULL, milestone_id TEXT NOT NULL, eligible INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,agent_id,milestone_id,eligible));
      CREATE INDEX IF NOT EXISTS progress_milestone_at ON progress_evidence(milestone_id,at);
      CREATE TABLE IF NOT EXISTS progress_agents(run_id TEXT NOT NULL, agent_id TEXT NOT NULL, supported INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,agent_id));
      PRAGMA user_version=1;`);
    this.archive = new ArchiveQueue(this.db);
    this.archive.configure();
  }
  saveRun(run: Run) {
    this.db
      .prepare(
        "INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body",
      )
      .run(run.id, run.status, JSON.stringify(run));
  }
  saveMotorFullRun(plan: MotorFullRun) {
    this.db.prepare(
      "INSERT INTO motor_full_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body",
    ).run(plan.id, plan.status, JSON.stringify(plan));
  }
  motorFullRun(id: string): MotorFullRun | undefined {
    const row = this.db.prepare("SELECT body FROM motor_full_runs WHERE id=?").get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  motorFullRuns(limit = 20): MotorFullRun[] {
    return this.db.prepare("SELECT body FROM motor_full_runs ORDER BY rowid DESC LIMIT ?")
      .all(limit).map((row) => JSON.parse(String(row.body)));
  }
  saveMotorTerrainRun(plan: MotorTerrainRun) {
    this.db.prepare(
      "INSERT INTO motor_terrain_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body",
    ).run(plan.id, plan.status, JSON.stringify(plan));
  }
  motorTerrainRun(id: string): MotorTerrainRun | undefined {
    const row = this.db.prepare("SELECT body FROM motor_terrain_runs WHERE id=?").get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  motorTerrainRuns(limit = 20): MotorTerrainRun[] {
    return this.db.prepare("SELECT body FROM motor_terrain_runs ORDER BY rowid DESC LIMIT ?")
      .all(limit).map((row) => JSON.parse(String(row.body)));
  }
  saveCombatFullRun(plan: CombatFullRun) {
    this.db.prepare(
      "INSERT INTO combat_full_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body",
    ).run(plan.id, plan.status, JSON.stringify(plan));
  }
  combatFullRun(id: string): CombatFullRun | undefined {
    const row = this.db.prepare("SELECT body FROM combat_full_runs WHERE id=?").get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  combatFullRuns(limit = 20): CombatFullRun[] {
    return this.db.prepare("SELECT body FROM combat_full_runs ORDER BY rowid DESC LIMIT ?")
      .all(limit).map((row) => JSON.parse(String(row.body)));
  }
  saveProgress(record: ProgressRecord) {
    const valid = progressRecordSchema.safeParse(record);
    if (!valid.success || record.minecraftVersion !== "1.18.1") return false;
    const eligible = ["survival", "adventure"].includes(record.gameMode)
      ? 1
      : 0;
    const result = this.db
      .prepare(
        "INSERT INTO progress_evidence VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(
        record.runId,
        record.agentId,
        record.milestoneId,
        eligible,
        record.at,
        JSON.stringify(valid.data),
      );
    return result.changes > 0;
  }
  saveProgressAgent(agent: ProgressAgent) {
    const valid = progressAgentSchema.safeParse(agent);
    if (!valid.success) return false;
    this.db
      .prepare(
        "INSERT INTO progress_agents VALUES(?,?,?,?) ON CONFLICT(run_id,agent_id) DO UPDATE SET supported=excluded.supported,body=excluded.body",
      )
      .run(
        agent.runId,
        agent.agentId,
        agent.supported ? 1 : 0,
        JSON.stringify(valid.data),
      );
    return true;
  }
  progress(runId?: string): ProgressSummary[] {
    const params = runId ? [runId] : [];
    const rows = this.db
      .prepare(
        `SELECT milestone_id, COUNT(DISTINCT agent_id) AS agents, COUNT(DISTINCT CASE WHEN eligible=1 THEN agent_id END) AS survival_agents FROM progress_evidence ${runId ? "WHERE run_id=?" : ""} GROUP BY milestone_id`,
      )
      .all(...params);
    return rows.map((row) => {
      const first = this.db
        .prepare(
          `SELECT body FROM progress_evidence WHERE milestone_id=? ${runId ? "AND run_id=?" : ""} ORDER BY at,rowid LIMIT 1`,
        )
        .get(String(row.milestone_id), ...params);
      const firstSurvival = this.db
        .prepare(
          `SELECT body FROM progress_evidence WHERE milestone_id=? AND eligible=1 ${runId ? "AND run_id=?" : ""} ORDER BY at,rowid LIMIT 1`,
        )
        .get(String(row.milestone_id), ...params);
      return {
        milestoneId: String(row.milestone_id),
        agents: Number(row.agents),
        survivalAgents: Number(row.survival_agents),
        ...(first ? { first: JSON.parse(String(first.body)) } : {}),
        ...(firstSurvival
          ? { firstSurvival: JSON.parse(String(firstSurvival.body)) }
          : {}),
      };
    });
  }
  progressTracking(runId?: string) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS agents, COALESCE(SUM(supported),0) AS supported FROM progress_agents ${runId ? "WHERE run_id=?" : ""}`,
      )
      .get(...(runId ? [runId] : []))!;
    return {
      agents: Number(row.agents),
      supported: Number(row.supported),
      unsupported: Number(row.agents) - Number(row.supported),
    };
  }
  progressOwners(username: string): AgentState[] {
    return this.db
      .prepare(
        "SELECT agents.body FROM agents JOIN runs ON agents.run_id=runs.id WHERE json_extract(agents.body,'$.username')=? AND runs.status IN ('running','paused','pausing') AND json_extract(agents.body,'$.status') NOT IN ('stopped','failed') LIMIT 2",
      )
      .all(username)
      .map((row) => JSON.parse(String(row.body)));
  }
  presets(): AgentPreset[] {
    return this.db
      .prepare("SELECT body FROM agent_presets ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(row.body as string));
  }
  getPreset(id: string): AgentPreset | undefined {
    const row = this.db
      .prepare("SELECT body FROM agent_presets WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  savePreset(preset: AgentPreset) {
    this.db
      .prepare(
        "INSERT INTO agent_presets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(preset.id, JSON.stringify(preset));
  }
  deletePreset(id: string) {
    this.db.prepare("DELETE FROM agent_presets WHERE id=?").run(id);
  }
  getRun(id: string): Run | undefined {
    const row = this.db.prepare("SELECT body FROM runs WHERE id=?").get(id);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  arenaPresets(): ArenaPreset[] {
    return this.db
      .prepare("SELECT body FROM arena_presets ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(row.body as string));
  }
  arenaPreset(id: string): ArenaPreset | undefined {
    const row = this.db
      .prepare("SELECT body FROM arena_presets WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  saveArenaPreset(preset: ArenaPreset) {
    this.db
      .prepare(
        "INSERT INTO arena_presets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(preset.id, JSON.stringify(preset));
  }
  deleteArenaPreset(id: string) {
    this.db.prepare("DELETE FROM arena_presets WHERE id=?").run(id);
  }
  runs(limit = 100): Run[] {
    return this.db
      .prepare(
        "SELECT body FROM runs ORDER BY CASE WHEN status IN ('running','pausing','paused','queued') THEN 0 ELSE 1 END, rowid DESC LIMIT ?",
      )
      .all(limit)
      .map((r) => JSON.parse(r.body as string));
  }
  queued(): Run[] {
    return this.db
      .prepare("SELECT body FROM runs WHERE status='queued' ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  saveAgents(agents: AgentState[]) {
    const stmt = this.db.prepare(
      "INSERT INTO agents VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    );
    this.db.exec("BEGIN");
    try {
      for (const a of agents) stmt.run(a.id, a.runId, JSON.stringify(a));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  agents(runId?: string): AgentState[] {
    return (
      runId
        ? this.db.prepare("SELECT body FROM agents WHERE run_id=?").all(runId)
        : this.db
            .prepare(
              "SELECT agents.body FROM agents JOIN runs ON agents.run_id=runs.id ORDER BY CASE WHEN runs.status IN ('running','pausing','paused') THEN 0 ELSE 1 END, agents.rowid DESC LIMIT 512",
            )
            .all()
    ).map((r) => JSON.parse(r.body as string));
  }
  metric(metric: Metric) {
    this.db
      .prepare("INSERT INTO metrics(run_id,at,body) VALUES(?,?,?)")
      .run(metric.runId, metric.at, JSON.stringify(metric));
  }
  metrics(runId?: string, limit = 180): Metric[] {
    return (
      runId
        ? this.db
            .prepare(
              "SELECT body FROM metrics WHERE run_id=? ORDER BY id DESC LIMIT ?",
            )
            .all(runId, limit)
        : this.db
            .prepare("SELECT body FROM metrics ORDER BY id DESC LIMIT ?")
            .all(limit)
    )
      .reverse()
      .map((r) => JSON.parse(r.body as string));
  }
  log(entry: LogEntry) {
    this.db
      .prepare("INSERT INTO logs(at,run_id,body) VALUES(?,?,?)")
      .run(entry.at, entry.runId ?? null, JSON.stringify(entry));
  }
  logs(runId?: string, limit = 150): LogEntry[] {
    return (
      runId
        ? this.db
            .prepare(
              "SELECT id,body FROM logs WHERE run_id=? ORDER BY id DESC LIMIT ?",
            )
            .all(runId, limit)
        : this.db
            .prepare("SELECT id,body FROM logs ORDER BY id DESC LIMIT ?")
            .all(limit)
    )
      .reverse()
      .map((r) => ({ ...JSON.parse(r.body as string), id: r.id }));
  }
  host(metric: HostMetric) {
    this.db
      .prepare("INSERT INTO host_metrics(body) VALUES(?)")
      .run(JSON.stringify(metric));
  }
  hostMetrics(): HostMetric[] {
    return this.db
      .prepare("SELECT body FROM host_metrics ORDER BY id DESC LIMIT 180")
      .all()
      .reverse()
      .map((r) => JSON.parse(r.body as string));
  }
  recover() {
    for (const row of this.db
      .prepare(
        "SELECT body FROM runs WHERE status IN ('running','pausing','paused')",
      )
      .all()) {
      const run = JSON.parse(row.body as string) as Run;
      run.status = "interrupted";
      run.error = run.spec.stage === "motor"
        ? "Control service restarted; continue from a compatible full-state checkpoint in Phase 3A if available."
        : "Control service restarted; rerun from dashboard.";
      run.updatedAt = new Date().toISOString();
      this.saveRun(run);
      this.saveAgents(
        this.agents(run.id).map((a) => ({ ...a, status: "stopped" })),
      );
      this.archive.artifacts(run.id);
    }
  }
  prune() {
    this.db.exec(`DELETE FROM logs WHERE id < (SELECT MAX(id)-100000 FROM logs);
      DELETE FROM metrics WHERE id < (SELECT MAX(id)-100000 FROM metrics);
      DELETE FROM host_metrics WHERE id < (SELECT MAX(id)-3600 FROM host_metrics);
      DELETE FROM agents WHERE run_id IN (SELECT id FROM runs WHERE status NOT IN ('queued','running','paused','pausing') ORDER BY rowid DESC LIMIT -1 OFFSET 100);`);
  }
  close() {
    this.db.close();
  }
}
