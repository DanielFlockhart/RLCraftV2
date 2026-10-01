"use client";
import { DEFAULT_TRAINING_RULES, type TrainingRules } from "@mlcraft/core";
import { MinecraftSelect } from "./minecraft-select";
const agentRules = [
  ["keepInventory", "Keep inventory on death"],
  ["noHungerLoss", "No hunger loss"],
  ["creeperEntityDamage", "Creeper damage to agents"],
  ["pvp", "Player versus player damage"],
  ["fallDamage", "Fall damage"],
  ["drowningDamage", "Drowning damage"],
  ["fireDamage", "Fire and lava damage"],
] as const;
const worldRules = [
  ["doDaylightCycle", "Day/night cycle"],
  ["doWeatherCycle", "Weather cycle"],
  ["doMobSpawning", "Natural mob spawning"],
  ["mobGriefing", "Mob terrain/inventory changes"],
  ["doFireTick", "Fire spread"],
  ["naturalRegeneration", "Natural health regeneration"],
  ["doMobLoot", "Mob loot"],
  ["doTileDrops", "Block drops"],
  ["doEntityDrops", "Non-mob entity drops"],
  ["doInsomnia", "Phantom spawning"],
  ["doPatrolSpawning", "Patrol spawning"],
  ["doTraderSpawning", "Wandering traders"],
] as const;
export function TrainingRulesEditor({
  value,
  onChange,
  minecraft,
}: {
  value?: TrainingRules;
  onChange: (rules: TrainingRules) => void;
  minecraft: boolean;
}) {
  const rules = value ?? DEFAULT_TRAINING_RULES;
  return (
    <section className="setup-run training-rules-editor">
      <h3>Experiment game rules</h3>
      <p className="world-help">
        Agent settings apply to this run’s players. Keep inventory on death is
        separate from restoring a starting kit each generation.
      </p>
      <div className="form-grid">
        {agentRules.map(([key, label]) => (
          <label key={key}>
            {label}
            <select
              value={String(rules[key])}
              onChange={(event) =>
                onChange({ ...rules, [key]: event.target.value === "true" })
              }
            >
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </label>
        ))}
      </div>
      <h4>Shared world settings</h4>
      <p className="world-help">
        Difficulty, creeper terrain damage and world rules affect the current
        overworld for the entire run, including pauses. Concurrent Minecraft
        experiments must use matching world settings. Previous settings restore
        when the last run exits. Peaceful difficulty can remove existing hostile
        mobs; changing difficulty back cannot restore them.
      </p>
      <div className="form-grid">
        <MinecraftSelect
          label="Difficulty"
          value={rules.difficulty}
          onChange={(difficulty) =>
            onChange({
              ...rules,
              difficulty: difficulty as TrainingRules["difficulty"],
            })
          }
          options={[
            {
              value: "world",
              label: "Use world difficulty",
              icon: "grass_block",
            },
            { value: "peaceful", label: "Peaceful", icon: "apple" },
            { value: "easy", label: "Easy", icon: "leather_boots" },
            { value: "normal", label: "Normal", icon: "iron_sword" },
            { value: "hard", label: "Hard", icon: "diamond" },
          ]}
        />
        <label>
          Creeper damage to blocks
          <select
            value={String(rules.creeperBlockDamage)}
            onChange={(event) =>
              onChange({
                ...rules,
                creeperBlockDamage: event.target.value === "true",
              })
            }
          >
            <option value="true">Allowed by world rules</option>
            <option value="false">Off</option>
          </select>
        </label>
        {worldRules.map(([key, label]) => (
          <label key={key}>
            {label}
            <select
              value={
                rules.world[key] === undefined
                  ? "world"
                  : String(rules.world[key])
              }
              onChange={(event) => {
                const world = { ...rules.world };
                if (event.target.value === "world") delete world[key];
                else world[key] = event.target.value === "true";
                onChange({ ...rules, world });
              }}
            >
              <option value="world">Use world setting</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </label>
        ))}
        {(
          [
            ["randomTickSpeed", "Random tick speed", 100],
            ["spawnRadius", "World spawn radius", 128],
          ] as const
        ).map(([key, label, max]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={0}
              max={max}
              step={1}
              placeholder="Use world setting"
              value={rules.world[key] ?? ""}
              onChange={(event) => {
                const world = { ...rules.world };
                if (event.target.value === "") delete world[key];
                else world[key] = Number(event.target.value);
                onChange({ ...rules, world });
              }}
            />
          </label>
        ))}
      </div>
      {!minecraft && (
        <p className="world-help">
          Simulator runs record these settings for configuration checks;
          Minecraft physics and world rules are only enforced on live Minecraft
          runs.
        </p>
      )}
      <button
        type="button"
        className="secondary"
        onClick={() => onChange(structuredClone(DEFAULT_TRAINING_RULES))}
      >
        Restore default experiment rules
      </button>
    </section>
  );
}
