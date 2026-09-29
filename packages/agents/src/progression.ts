import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import type {
  ProgressEvidence,
  ProgressRule,
  ProgressSnapshot,
} from "@rlcraft/core";
import catalogJson from "../../core/src/progression-catalog.json" with { type: "json" };

const catalog = catalogJson as ProgressSnapshot["catalog"];
const categories = { mined: 0, crafted: 1, used: 2, picked_up: 4, killed: 6 };
const dimension = (name: unknown) =>
  String(name ?? "").replace(/^minecraft:/, "");

/** Administrative evidence from this player's ordinary connection. Independent
 * of policy input masks; nothing in this class adds an input to Policy.act. */
export class MinecraftProgress {
  private listeners: {
    target: NodeJS.EventEmitter;
    event: string;
    fn: (...args: any[]) => void;
  }[] = [];
  private interval?: ReturnType<typeof setInterval>;
  private emitted = new Set<string>();
  private requirements = new Map<string, string[][]>();
  private criteria = new Map<string, Set<string>>();
  private stats = new Map<string, number>();
  private existingAdvancements = new Set<string>();
  private statisticsArrived = false;
  private initialAdvancements = true;
  private lastStatsRequest = 0;
  private hasNether = false;
  private hasEnd = false;
  private won = false;
  private origin: ProgressEvidence["origin"] = "existing";
  private closed = false;
  private data: ReturnType<typeof minecraftData>;
  constructor(
    private bot: Bot,
    private report: (evidence: ProgressEvidence) => void,
  ) {
    this.data = minecraftData(bot.version || catalog.minecraftVersion);
    this.listen(bot, "end", () => this.close());
    this.listen(bot._client, "packet", (packet, meta) => {
      if (meta.state !== "play") return;
      this.packet(String(meta.name), packet);
    });
    for (const event of [
      "spawn",
      "respawn",
      "heldItemChanged",
      "windowOpen",
      "windowClose",
    ])
      this.listen(bot, event, () => this.sample());
    // Bounded polling detects local inventory/dimension/block/menu changes even
    // while policy execution is paused. Timer is owned and cleared on close.
    this.interval = setInterval(() => this.sample(true), 1000);
    this.interval.unref();
  }
  setOrigin(origin: ProgressEvidence["origin"]) {
    this.origin = origin;
  }
  private listen(
    target: NodeJS.EventEmitter,
    event: string,
    fn: (...args: any[]) => void,
  ) {
    target.on(event, fn);
    this.listeners.push({ target, event, fn });
  }
  private emit(
    id: string,
    source: ProgressEvidence["source"],
    detail: string,
    origin = this.origin,
  ) {
    if (this.closed || !this.bot.entity || !this.bot.game?.gameMode) return;
    const gameMode = this.bot.game.gameMode;
    const key = `${id}:${gameMode}:${origin}`;
    if (this.emitted.has(key)) return;
    this.emitted.add(key);
    this.report({
      milestoneId: id,
      source,
      detail: detail.slice(0, 1000),
      gameMode,
      origin,
      at: Date.now(),
    });
  }
  private complete(id: string) {
    const groups = this.requirements.get(id);
    const done = this.criteria.get(id);
    return (
      !!groups?.length &&
      groups.every(
        (group) => group.length > 0 && group.some((key) => done?.has(key)),
      )
    );
  }
  private packet(name: string, packet: any) {
    if (name === "advancements") {
      if (packet.reset) {
        this.requirements.clear();
        this.criteria.clear();
      }
      for (const id of packet.identifiers ?? []) {
        this.requirements.delete(id);
        this.criteria.delete(id);
      }
      for (const entry of packet.advancementMapping ?? [])
        this.requirements.set(entry.key, entry.value.requirements ?? []);
      for (const entry of packet.progressMapping ?? []) {
        const completed = this.criteria.get(entry.key) ?? new Set<string>();
        for (const criterion of entry.value ?? []) {
          if (
            criterion.criterionProgress !== null &&
            criterion.criterionProgress !== undefined
          )
            completed.add(criterion.criterionIdentifier);
          else completed.delete(criterion.criterionIdentifier);
        }
        this.criteria.set(entry.key, completed);
        if (this.initialAdvancements && this.complete(entry.key))
          this.existingAdvancements.add(entry.key);
      }
      this.initialAdvancements = false;
    }
    if (name === "statistics") {
      for (const entry of packet.entries ?? [])
        this.stats.set(`${entry.categoryId}:${entry.statisticId}`, entry.value);
      for (const step of catalog.steps)
        for (const rule of step.rules)
          if (rule.kind === "statistic" && this.statistic(rule))
            this.emit(
              step.id,
              "statistic",
              `${rule.category}: ${rule.names.join(" / ")} ≥ ${rule.count ?? 1}`,
              this.statisticsArrived ? this.origin : "existing",
            );
      this.statisticsArrived = true;
    }
    if (
      name === "game_state_change" &&
      [4, "win_game"].includes(packet.reason) &&
      this.hasEnd
    ) {
      this.won = true;
      this.emit(
        "credits",
        "credits",
        "Server sent win_game after observed End presence; rendered credits are backend-dependent.",
      );
    }
    // Wait until Mineflayer's packet-specific handlers finish updating state.
    if (
      [
        "advancements",
        "statistics",
        "window_items",
        "set_slot",
        "respawn",
        "login",
        "game_state_change",
      ].includes(name)
    )
      queueMicrotask(() => this.sample());
  }
  private statistic(rule: Extract<ProgressRule, { kind: "statistic" }>) {
    let total = 0;
    for (const name of rule.names) {
      const record =
        rule.category === "mined"
          ? this.data.blocksByName[name]
          : rule.category === "killed"
            ? this.data.entitiesByName[name]
            : this.data.itemsByName[name];
      if (record)
        total +=
          this.stats.get(`${categories[rule.category]}:${record.id}`) ?? 0;
    }
    return total >= (rule.count ?? 1);
  }
  sample(requestStatistics = false) {
    if (
      this.closed ||
      !this.bot.entity ||
      !this.bot.game?.gameMode ||
      this.bot.version !== catalog.minecraftVersion
    )
      return;
    const b = this.bot;
    const dim = dimension(b.game.dimension);
    if (dim === "the_nether") this.hasNether = true;
    if (dim === "the_end") this.hasEnd = true;
    if (requestStatistics && Date.now() - this.lastStatsRequest >= 10000) {
      this.lastStatsRequest = Date.now();
      // Ordinary player's statistics request, not an operator/server-only RPC.
      b._client.write("client_command", { actionId: 1 });
    }
    const inventory = b.inventory?.slots?.slice(5).filter(Boolean) ?? [];
    let nearby: ReturnType<Bot["blockAt"]>[] | undefined;
    const blocks = () => {
      if (nearby) return nearby;
      nearby = [];
      const center = b.entity.position.floored();
      for (let x = -2; x <= 2; x++)
        for (let y = -2; y <= 2; y++)
          for (let z = -2; z <= 2; z++)
            nearby.push(b.blockAt(center.offset(x, y, z)));
      return nearby;
    };
    for (const step of catalog.steps) {
      for (const rule of step.rules) {
        if (rule.kind === "inventory") {
          const count = inventory.reduce(
            (n, item) =>
              n +
              (item &&
              (rule.items?.includes(item.name) ||
                (rule.suffix && item.name.endsWith(rule.suffix)))
                ? item.count
                : 0),
            0,
          );
          if (count >= (rule.count ?? 1))
            this.emit(
              step.id,
              "inventory",
              `Observed ${count} matching items in this player's inventory; acquisition source is not inferred.`,
            );
        } else if (rule.kind === "advancement" && this.complete(rule.id)) {
          this.emit(
            step.id,
            "advancement",
            `Completed ${rule.id}`,
            this.existingAdvancements.has(rule.id) ? "existing" : this.origin,
          );
        } else if (rule.kind === "dimension") {
          if (
            rule.name === dim ||
            (rule.name === "overworld_after_nether" &&
              dim === "overworld" &&
              this.hasNether)
          )
            this.emit(
              step.id,
              "dimension",
              `Observed dimension ${dim}${rule.name === "overworld_after_nether" ? " after Nether presence" : ""}`,
            );
        } else if (rule.kind === "block") {
          if (
            ["exit-portal", "reach-island"].includes(step.id) &&
            dim !== "the_end"
          )
            continue;
          if (
            ["active-end-portal", "portal-room", "insert-eye"].includes(
              step.id,
            ) &&
            dim !== "overworld"
          )
            continue;
          const found = blocks().find(
            (block) =>
              block &&
              rule.names.includes(block.name) &&
              Object.entries(rule.properties ?? {}).every(
                ([key, value]) => String(block.getProperties()[key]) === value,
              ),
          );
          if (found)
            this.emit(
              step.id,
              "block",
              `Observed loaded ${found.name} at ${found.position}; placement/activation actor not inferred.`,
            );
        } else if (
          rule.kind === "window" &&
          b.currentWindow &&
          String(b.currentWindow.type).includes(rule.type)
        ) {
          this.emit(
            step.id,
            "window",
            `Opened ${b.currentWindow.type} window ${b.currentWindow.id}`,
          );
        } else if (rule.kind === "credits" && this.won) {
          this.emit(step.id, "credits", "Received End win_game event.");
        } else if (
          rule.kind === "end-return" &&
          this.won &&
          this.hasEnd &&
          dim === "overworld"
        ) {
          this.emit(
            step.id,
            "end-return",
            "Observed Overworld after End win_game event.",
          );
        }
      }
    }
  }
  close() {
    this.closed = true;
    clearInterval(this.interval);
    for (const { target, event, fn } of this.listeners)
      target.removeListener(event, fn);
    this.listeners = [];
  }
}
