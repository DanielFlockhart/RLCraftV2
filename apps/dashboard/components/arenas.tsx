"use client";
import { useEffect, useState } from "react";
import {
  DEFAULT_ARENA_SPEC,
  type ArenaSpec,
  type ArenaBlueprint,
  type ArenaPoint,
  type ArenaPreset,
} from "@rlcraft/core";
import { arenaBounds } from "../../../packages/core/src/arenas";

function Coordinates({
  label,
  value,
  change,
  max,
}: {
  label: string;
  value: ArenaPoint;
  change: (value: ArenaPoint) => void;
  max?: ArenaPoint;
}) {
  return (
    <fieldset className="arena-coordinates">
      <legend>{label}</legend>
      {(["x", "y", "z"] as const).map((axis) => (
        <label key={axis}>
          {axis.toUpperCase()}
          <input
            type="number"
            step="1"
            min={max ? 0 : axis === "y" ? -64 : -29999984}
            max={max ? max[axis] : axis === "y" ? 318 : 29999984}
            value={value[axis]}
            onChange={(e) =>
              change({ ...value, [axis]: Number(e.target.value) })
            }
          />
        </label>
      ))}
    </fieldset>
  );
}
const tint = (block: string) =>
  ["#76998c", "#bd9167", "#779bbc", "#a490be", "#a4a173", "#b57f82"][
    Array.from(block).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6
  ];

export function ArenaEditor({
  value,
  onChange,
  act,
  online,
  idPrefix,
  agents = 1,
  placement = true,
}: {
  value?: ArenaSpec;
  onChange: (value: ArenaSpec | undefined) => void;
  act: (path: string, body?: unknown) => Promise<unknown>;
  online: boolean;
  idPrefix: string;
  agents?: number;
  placement?: boolean;
}) {
  const [presets, setPresets] = useState<ArenaPreset[]>([]);
  const [blocks, setBlocks] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<
    { id: string; name: string; stackSize: number }[]
  >([]);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [slice, setSlice] = useState(0);
  async function refresh(signal?: AbortSignal) {
    try {
      const response = await fetch("/api/control/arena-presets", { signal }),
        data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Arena presets unavailable");
      setPresets(data.presets);
      setBlocks(data.blocks);
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
  function blueprint(patch: Partial<ArenaBlueprint>) {
    if (value)
      onChange({ ...value, blueprint: { ...value.blueprint, ...patch } });
  }
  function select(id: string) {
    setSelected(id);
    const preset = presets.find((preset) => preset.id === id);
    if (preset) {
      onChange({
        ...(value ?? structuredClone(DEFAULT_ARENA_SPEC)),
        blueprint: structuredClone(preset.blueprint),
      });
      setName(preset.name);
    }
  }
  async function save(update: boolean) {
    if (!value) return;
    setBusy(true);
    try {
      const result = (await act(
        update ? `arena-presets/${selected}` : "arena-presets",
        { name: name.trim(), blueprint: value.blueprint },
      )) as ArenaPreset | undefined;
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
      if (await act(`arena-presets/${selected}/delete`)) {
        setSelected("");
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  const a = value?.blueprint;
  const dimensions = a
    ? { x: a.width - 1, y: a.height - 1, z: a.depth - 1 }
    : { x: 0, y: 0, z: 0 };
  const bounds = value ? arenaBounds(value, agents) : undefined;
  const width = Math.max(3, Math.min(32, a?.width ?? 7)),
    depth = Math.max(3, Math.min(32, a?.depth ?? 7));
  const level = Math.min(slice, (a?.height ?? 4) - 1);
  const blockInput = (
    label: string,
    block: string,
    change: (value: string) => void,
  ) => (
    <label>
      {label}
      <input
        list={`${idPrefix}-blocks`}
        value={block}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
  return (
    <div className="setup-editor arena-editor">
      <div className="form-grid">
        <label>
          Training structure
          <select
            value={value ? "enabled" : "disabled"}
            onChange={(e) =>
              onChange(
                e.target.value === "enabled"
                  ? structuredClone(DEFAULT_ARENA_SPEC)
                  : undefined,
              )
            }
          >
            <option value="disabled">Normal world · no arena changes</option>
            <option value="enabled">Custom training arena</option>
          </select>
        </label>
        <label>
          Saved structure
          <select value={selected} onChange={(e) => select(e.target.value)}>
            <option value="">Custom blueprint</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
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
      {a && value && (
        <>
          <p className="world-help">
            Dimensions describe the clear interior. Contents use coordinates
            inside it, starting at 0. Saved blueprints include contents and
            spawn; placement is selected per experiment.
          </p>
          <datalist id={`${idPrefix}-blocks`}>
            {blocks.map((block) => (
              <option key={block.id} value={block.id}>
                {block.name}
              </option>
            ))}
          </datalist>
          <datalist id={`${idPrefix}-items`}>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </datalist>
          <div className="arena-fields">
            {(["width", "depth", "height"] as const).map((key) => (
              <label key={key}>
                Interior {key}
                <input
                  type="number"
                  min="3"
                  max={key === "height" ? 16 : 32}
                  value={a[key]}
                  onChange={(e) => blueprint({ [key]: Number(e.target.value) })}
                />
              </label>
            ))}
            {blockInput("Floor", a.floor, (floor) => blueprint({ floor }))}
            {blockInput("Walls", a.walls, (walls) => blueprint({ walls }))}
            {blockInput("Roof · air leaves it open", a.roof, (roof) =>
              blueprint({ roof }),
            )}
          </div>
          <Coordinates
            label="Agent spawn inside each cell"
            value={a.spawn}
            max={{ ...dimensions, y: a.height - 2 }}
            change={(spawn) => blueprint({ spawn })}
          />
          <div className="arena-preview">
            <div>
              <label>
                Preview height
                <select
                  value={level}
                  onChange={(e) => setSlice(Number(e.target.value))}
                >
                  {Array.from(
                    { length: Math.max(1, Math.min(16, a.height)) },
                    (_, y) => (
                      <option key={y} value={y}>
                        Y {y}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <p className="world-help">
                Click a tile to set the agent spawn. Green marks spawn, amber
                marks containers, red marks mobs.
              </p>
            </div>
            <svg
              viewBox={`0 0 ${width + 2} ${depth + 2}`}
              role="img"
              aria-label="Arena floor plan"
              className="arena-map"
            >
              <rect width={width + 2} height={depth + 2} fill={tint(a.walls)} />
              {Array.from({ length: width * depth }, (_, index) => {
                const x = index % width,
                  z = Math.floor(index / width);
                let block = "minecraft:air";
                for (const region of a.regions)
                  if (
                    x >= region.from.x &&
                    x <= region.to.x &&
                    z >= region.from.z &&
                    z <= region.to.z &&
                    level >= region.from.y &&
                    level <= region.to.y
                  )
                    block = region.block;
                const container = a.containers.some(
                  (container) =>
                    container.position.x === x &&
                    container.position.z === z &&
                    container.position.y === level,
                );
                const mob = a.entities.some(
                  (mob) =>
                    mob.position.x === x &&
                    mob.position.z === z &&
                    mob.position.y === level,
                );
                const spawn =
                  a.spawn.x === x && a.spawn.z === z && a.spawn.y === level;
                return (
                  <g
                    key={index}
                    role="button"
                    tabIndex={0}
                    aria-label={`Set spawn at ${x}, ${level}, ${z}`}
                    onClick={() => blueprint({ spawn: { x, y: level, z } })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        blueprint({ spawn: { x, y: level, z } });
                      }
                    }}
                  >
                    <rect
                      x={x + 1}
                      y={z + 1}
                      width="1"
                      height="1"
                      fill={
                        container
                          ? "#d0a34e"
                          : block === "minecraft:air"
                            ? "#202c32"
                            : tint(block)
                      }
                      stroke="#394851"
                      strokeWidth="0.03"
                    />
                    <title>
                      {x}, {level}, {z}: {container ? "Container" : block}
                    </title>
                    {spawn && (
                      <circle
                        cx={x + 1.5}
                        cy={z + 1.5}
                        r="0.25"
                        fill="#61d6ac"
                      />
                    )}
                    {mob && (
                      <circle
                        cx={x + 1.75}
                        cy={z + 1.25}
                        r="0.15"
                        fill="#f08080"
                      />
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="section-heading">
            <h3>Block regions</h3>
            <button
              type="button"
              className="secondary"
              disabled={a.regions.length >= 32}
              onClick={() =>
                blueprint({
                  regions: [
                    ...a.regions,
                    {
                      from: { x: 0, y: 0, z: 0 },
                      to: { x: 0, y: 0, z: 0 },
                      block: "minecraft:oak_log",
                    },
                  ],
                })
              }
            >
              Add region
            </button>
          </div>
          {a.regions.map((region, index) => (
            <div className="arena-content" key={index}>
              <div className="arena-fields">
                {blockInput(
                  `Region ${index + 1} block`,
                  region.block,
                  (block) =>
                    blueprint({
                      regions: a.regions.map((row, i) =>
                        i === index ? { ...row, block } : row,
                      ),
                    }),
                )}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    blueprint({
                      regions: a.regions.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove region
                </button>
              </div>
              <div className="form-grid">
                <Coordinates
                  label="From · inclusive"
                  value={region.from}
                  max={dimensions}
                  change={(from) =>
                    blueprint({
                      regions: a.regions.map((row, i) =>
                        i === index ? { ...row, from } : row,
                      ),
                    })
                  }
                />
                <Coordinates
                  label="To · inclusive"
                  value={region.to}
                  max={dimensions}
                  change={(to) =>
                    blueprint({
                      regions: a.regions.map((row, i) =>
                        i === index ? { ...row, to } : row,
                      ),
                    })
                  }
                />
              </div>
            </div>
          ))}
          <p className="world-help">
            Regions fill rectangular volumes. Later regions replace earlier
            ones; containers are placed last. Use air regions to carve spaces.
          </p>
          <div className="section-heading">
            <h3>Stocked containers</h3>
            <button
              type="button"
              className="secondary"
              disabled={a.containers.length >= 8}
              onClick={() =>
                blueprint({
                  containers: [
                    ...a.containers,
                    {
                      position: { x: 0, y: 0, z: 0 },
                      block: "minecraft:barrel",
                      items: [],
                    },
                  ],
                })
              }
            >
              Add container
            </button>
          </div>
          {a.containers.map((container, index) => {
            const update = (patch: Partial<typeof container>) =>
              blueprint({
                containers: a.containers.map((row, i) =>
                  i === index ? { ...row, ...patch } : row,
                ),
              });
            return (
              <div className="arena-content" key={index}>
                <div className="form-grid">
                  <label>
                    Container {index + 1}
                    <select
                      value={container.block}
                      onChange={(e) =>
                        update({
                          block: e.target.value as typeof container.block,
                        })
                      }
                    >
                      <option value="minecraft:barrel">Barrel</option>
                      <option value="minecraft:chest">Chest</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      blueprint({
                        containers: a.containers.filter((_, i) => i !== index),
                      })
                    }
                  >
                    Remove container
                  </button>
                </div>
                <Coordinates
                  label="Position inside cell"
                  value={container.position}
                  max={dimensions}
                  change={(position) => update({ position })}
                />
                {container.items.map((item, slotIndex) => (
                  <div className="setup-item" key={slotIndex}>
                    <label>
                      Slot (1–27)
                      <input
                        type="number"
                        min="1"
                        max="27"
                        value={item.slot + 1}
                        onChange={(e) =>
                          update({
                            items: container.items.map((row, i) =>
                              i === slotIndex
                                ? { ...row, slot: Number(e.target.value) - 1 }
                                : row,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      Item
                      <input
                        list={`${idPrefix}-items`}
                        value={item.item}
                        onChange={(e) =>
                          update({
                            items: container.items.map((row, i) =>
                              i === slotIndex
                                ? { ...row, item: e.target.value }
                                : row,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      Count
                      <input
                        type="number"
                        min="1"
                        max={
                          items.find((row) => row.id === item.item)
                            ?.stackSize ?? 64
                        }
                        value={item.count}
                        onChange={(e) =>
                          update({
                            items: container.items.map((row, i) =>
                              i === slotIndex
                                ? { ...row, count: Number(e.target.value) }
                                : row,
                            ),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        update({
                          items: container.items.filter(
                            (_, i) => i !== slotIndex,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary"
                  disabled={container.items.length >= 27}
                  onClick={() => {
                    const slot = Array.from({ length: 27 }, (_, i) => i).find(
                      (slot) =>
                        !container.items.some((item) => item.slot === slot),
                    )!;
                    update({
                      items: [
                        ...container.items,
                        { slot, item: "minecraft:oak_log", count: 8 },
                      ],
                    });
                  }}
                >
                  Add item
                </button>
              </div>
            );
          })}
          <div className="section-heading">
            <h3>Mobs</h3>
            <button
              type="button"
              className="secondary"
              disabled={a.entities.length >= 16}
              onClick={() =>
                blueprint({
                  entities: [
                    ...a.entities,
                    { position: { x: 1, y: 0, z: 1 }, type: "cow", count: 1 },
                  ],
                })
              }
            >
              Add mob spawn
            </button>
          </div>
          {a.entities.map((mob, index) => (
            <div className="arena-content" key={index}>
              <div className="arena-fields">
                <label>
                  Mob
                  <select
                    value={mob.type}
                    onChange={(e) =>
                      blueprint({
                        entities: a.entities.map((row, i) =>
                          i === index
                            ? {
                                ...row,
                                type: e.target.value as typeof mob.type,
                              }
                            : row,
                        ),
                      })
                    }
                  >
                    {[
                      "cow",
                      "pig",
                      "sheep",
                      "chicken",
                      "zombie",
                      "skeleton",
                      "spider",
                    ].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Count
                  <input
                    type="number"
                    min="1"
                    max="8"
                    value={mob.count}
                    onChange={(e) =>
                      blueprint({
                        entities: a.entities.map((row, i) =>
                          i === index
                            ? { ...row, count: Number(e.target.value) }
                            : row,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    blueprint({
                      entities: a.entities.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove mob spawn
                </button>
              </div>
              <Coordinates
                label="Mob position inside cell"
                value={mob.position}
                max={{ ...dimensions, y: a.height - 2 }}
                change={(position) =>
                  blueprint({
                    entities: a.entities.map((row, i) =>
                      i === index ? { ...row, position } : row,
                    ),
                  })
                }
              />
            </div>
          ))}
          {placement && (
            <>
              <h3>Placement for this run</h3>
              <Coordinates
                label="World origin · outside floor corner"
                value={value.origin}
                change={(origin) => onChange({ ...value, origin })}
              />
              <div className="arena-fields">
                <label>
                  Layout
                  <select
                    value={value.layout}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        layout: e.target.value as ArenaSpec["layout"],
                      })
                    }
                  >
                    <option value="individual">
                      Separate cell for each agent
                    </option>
                    <option value="shared">One shared arena</option>
                  </select>
                </label>
                <label>
                  Grid columns
                  <input
                    type="number"
                    min="1"
                    max="16"
                    value={value.columns}
                    onChange={(e) =>
                      onChange({ ...value, columns: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Gap between cells
                  <input
                    type="number"
                    min="2"
                    max="32"
                    value={value.gap}
                    onChange={(e) =>
                      onChange({ ...value, gap: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Rebuild
                  <select
                    value={value.resetEachEpisode ? "episode" : "once"}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        resetEachEpisode: e.target.value === "episode",
                      })
                    }
                  >
                    <option value="episode">Before every episode</option>
                    <option value="once">Once before the run</option>
                  </select>
                </label>
              </div>
              <p className="world-help">
                {value.layout === "shared" ? 1 : agents} cell(s), each{" "}
                {a.width + 2} × {a.height + 2} × {a.depth + 2} including its
                shell. World bounds: {bounds?.min.x}, {bounds?.min.y},{" "}
                {bounds?.min.z} to {bounds?.max.x}, {bounds?.max.y},{" "}
                {bounds?.max.z}. Starting kits are configured separately; remove
                their custom spawn to use this arena.
              </p>
              <p className="notice">
                Running this experiment replaces blocks and clears non-player
                entities inside each cell. Terrain outside the cells is
                preserved. Agents spawn after preparation; rebuilding also
                respawns the configured mobs and restocks containers.
              </p>
            </>
          )}
          <div className="preset-actions">
            <label>
              Blueprint name
              <input
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                placeholder="Wood collection cage"
              />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={!online || busy || !name.trim()}
              onClick={() => save(false)}
            >
              Save new blueprint
            </button>
            {selected && (
              <>
                <button
                  type="button"
                  className="secondary"
                  disabled={!online || busy || !name.trim()}
                  onClick={() => save(true)}
                >
                  Update selected
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={!online || busy}
                  onClick={remove}
                >
                  Delete preset
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
