"use client";
import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import {
  DEFAULT_AGENT_SETUP,
  type AgentSetup,
  type AgentPreset,
} from "@mlcraft/core";

const slots = Array.from({ length: 41 }, (_, slot) => ({
  slot,
  label:
    slot < 9
      ? `Hotbar ${slot + 1}`
      : slot < 36
        ? `Backpack ${slot - 8}`
        : ["Boots", "Leggings", "Chestplate", "Helmet", "Off-hand"][slot - 36],
}));
export function AgentSetupEditor({
  value,
  onChange,
  act,
  online,
  idPrefix,
}: {
  value?: AgentSetup;
  onChange: (setup: AgentSetup | undefined) => void;
  act: (path: string, body?: unknown) => Promise<unknown>;
  online: boolean;
  idPrefix: string;
}) {
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [items, setItems] = useState<
    { id: string; name: string; stackSize: number }[]
  >([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh(signal?: AbortSignal) {
    try {
      const response = await fetch("/api/control/agent-presets", { signal });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Agent presets unavailable");
      setPresets(data.presets);
      setItems(data.items);
      setError("");
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        setError((error as Error).message);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [online]);
  function select(id: string) {
    setSelected(id);
    const preset = presets.find((p) => p.id === id);
    if (preset) {
      onChange(structuredClone(preset.setup));
      setName(preset.name);
    }
  }
  async function save(update: boolean) {
    if (!value) return;
    setBusy(true);
    try {
      const result = (await act(
        update ? `agent-presets/${selected}` : "agent-presets",
        { name: name.trim(), setup: value },
      )) as AgentPreset | undefined;
      if (result) {
        await refresh();
        setSelected(result.id);
      }
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      if (await act(`agent-presets/${selected}/delete`)) {
        setSelected("");
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  const disabled = !online || busy;
  return (
    <div className="setup-editor">
      <div className="form-grid">
        <label>
          Agent setup
          <select
            value={value ? "enabled" : "disabled"}
            onChange={(e) =>
              onChange(
                e.target.value === "enabled"
                  ? structuredClone(DEFAULT_AGENT_SETUP)
                  : undefined,
              )
            }
          >
            <option value="disabled">
              Default training setup · empty inventory, reset each generation
            </option>
            <option value="enabled">
              Custom starting inventory and agent state
            </option>
          </select>
        </label>
        <label>
          Saved preset
          <select value={selected} onChange={(e) => select(e.target.value)}>
            <option value="">Custom setup</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {value && (
        <>
          <p className="world-help">
            Applies to every training agent in this run. Armour and off-hand
            slots are supported. ChilledVibe and other players are excluded.
          </p>
          <datalist id={`${idPrefix}-items`}>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </datalist>
          <div className="setup-items">
            {value.items.map((item, index) => (
              <div className="setup-item" key={index}>
                <label>
                  Slot
                  <select
                    value={item.slot}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        items: value.items.map((item, i) =>
                          i === index
                            ? { ...item, slot: Number(e.target.value) }
                            : item,
                        ),
                      })
                    }
                  >
                    {slots.map((slot) => (
                      <option
                        key={slot.slot}
                        value={slot.slot}
                        disabled={value.items.some(
                          (other, i) => i !== index && other.slot === slot.slot,
                        )}
                      >
                        {slot.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Item
                  <input
                    list={`${idPrefix}-items`}
                    value={item.item}
                    placeholder="Search Minecraft items"
                    onChange={(e) =>
                      onChange({
                        ...value,
                        items: value.items.map((item, i) =>
                          i === index
                            ? { ...item, item: e.target.value }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Count
                  <input
                    type="number"
                    min={1}
                    max={
                      item.slot >= 36 && item.slot <= 39
                        ? 1
                        : (items.find((v) => v.id === item.item)?.stackSize ??
                          64)
                    }
                    value={item.count}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        items: value.items.map((item, i) =>
                          i === index
                            ? { ...item, count: Number(e.target.value) }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Remove item ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...value,
                      items: value.items.filter((_, i) => i !== index),
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              disabled={value.items.length >= 41}
              onClick={() => {
                const slot = slots.find(
                  (slot) =>
                    !value.items.some((item) => item.slot === slot.slot),
                )?.slot;
                if (slot !== undefined)
                  onChange({
                    ...value,
                    items: [
                      ...value.items,
                      { slot, item: "minecraft:stone", count: 1 },
                    ],
                  });
              }}
            >
              <Plus size={14} /> Add starting item
            </button>
          </div>
          <div className="form-grid world-editor">
            <label>
              Existing inventory
              <select
                value={String(value.clearInventory)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    clearInventory: e.target.value === "true",
                  })
                }
              >
                <option value="true">Clear before applying the kit</option>
                <option value="false">Keep unspecified slots</option>
              </select>
            </label>
            <label>
              Apply setup
              <select
                value={String(value.applyEachEpisode)}
                onChange={(e) =>
                  onChange({
                    ...value,
                    applyEachEpisode: e.target.value === "true",
                  })
                }
              >
                <option value="true">At spawn and each episode</option>
                <option value="false">Once at run start</option>
              </select>
            </label>
            <label>
              Agent game mode
              <select
                value={value.gamemode}
                onChange={(e) =>
                  onChange({
                    ...value,
                    gamemode: e.target.value as AgentSetup["gamemode"],
                  })
                }
              >
                <option value="world">Use server game mode</option>
                {["survival", "creative", "adventure"].map((mode) => (
                  <option key={mode}>{mode}</option>
                ))}
              </select>
            </label>
            <label>
              Held hotbar slot
              <select
                value={value.heldSlot}
                onChange={(e) =>
                  onChange({ ...value, heldSlot: Number(e.target.value) })
                }
              >
                {slots.slice(0, 9).map((slot) => (
                  <option key={slot.slot} value={slot.slot}>
                    {slot.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Health, hunger and XP
              <select
                value={String(value.resetVitals)}
                onChange={(e) =>
                  onChange({ ...value, resetVitals: e.target.value === "true" })
                }
              >
                <option value="true">Reset to configured values</option>
                <option value="false">Keep current values</option>
              </select>
            </label>
            {value.resetVitals &&
              (
                [
                  { key: "health", label: "Health", min: 1, max: 20 },
                  { key: "food", label: "Hunger", min: 0, max: 20 },
                  {
                    key: "experienceLevel",
                    label: "Experience level",
                    min: 0,
                    max: 10000,
                  },
                ] as const
              ).map((field) => (
                <label key={field.key}>
                  {field.label}
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={value[field.key]}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        [field.key]: Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            <label>
              Starting position
              <select
                value={value.spawn ? "custom" : "world"}
                onChange={(e) =>
                  onChange({
                    ...value,
                    spawn:
                      e.target.value === "custom"
                        ? { x: 0.5, y: 64, z: 0.5 }
                        : undefined,
                  })
                }
              >
                <option value="world">
                  Return to initial spawn each generation
                </option>
                <option value="custom">
                  Set coordinates in the active world
                </option>
              </select>
            </label>
            {value.spawn &&
              (["x", "y", "z"] as const).map((axis) => (
                <label key={axis}>
                  Spawn {axis.toUpperCase()}
                  <input
                    type="number"
                    step="any"
                    value={value.spawn![axis]}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        spawn: {
                          ...value.spawn!,
                          [axis]: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              ))}
          </div>
          <p className="world-help">
            Choose a safe spawn height for the selected terrain. Episode setup
            resets inventory, vitals and position. Dead agents respawn for the
            next generation. Use arena resets to restore terrain, resources and
            mobs.
          </p>
          <div className="form-grid">
            <label>
              Preset name
              <input
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Woodcutting tools or combat equipment"
              />
            </label>
          </div>
          <div className="world-actions">
            <button
              type="button"
              className="secondary"
              disabled={disabled || !name.trim()}
              onClick={() => save(false)}
            >
              <Save size={14} /> Save new preset
            </button>
            <button
              type="button"
              className="secondary"
              disabled={disabled || !selected || !name.trim()}
              onClick={() => save(true)}
            >
              Update selected preset
            </button>
            <button
              type="button"
              className="secondary"
              disabled={disabled || !selected}
              onClick={remove}
            >
              Delete preset
            </button>
          </div>
          <p className="world-help">
            Preset edits affect future selections. Each queued run stores its
            own complete setup. Saving a preset does not start a run or change
            online players.
          </p>
        </>
      )}
    </div>
  );
}
