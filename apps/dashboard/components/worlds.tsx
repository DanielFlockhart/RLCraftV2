"use client";
import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import type { WorldCatalog, WorldSettings } from "@mlcraft/core";
import { MinecraftIcon, worldIcons } from "./minecraft-icon";
import { MinecraftSelect, type MinecraftOption } from "./minecraft-select";
const terrainOptions: MinecraftOption[] = [
  {
    value: "survival",
    label: "Normal Minecraft terrain",
    icon: "grass_block",
    description: "Survival terrain with hills, caves and oceans",
  },
  {
    value: "flat",
    label: "Superflat",
    icon: "grass_slab",
    description: "Flat layers for controlled experiments",
  },
  {
    value: "large_biomes",
    label: "Large biomes",
    icon: "oak_log",
    description: "Larger regions of each biome",
  },
  {
    value: "amplified",
    label: "Amplified",
    icon: "stone",
    description: "Tall mountains and dramatic terrain",
  },
];

const defaults: WorldSettings = {
  type: "survival",
  seed: "",
  difficulty: "normal",
  gamemode: "survival",
  structures: true,
  flat: {
    biome: "minecraft:plains",
    layers: [
      { block: "minecraft:bedrock", height: 1 },
      { block: "minecraft:dirt", height: 2 },
      { block: "minecraft:grass_block", height: 1 },
    ],
  },
};
export function TrainingWorlds({
  online,
  serverStatus,
  act,
}: {
  online: boolean;
  serverStatus?: string;
  act: (path: string, body?: unknown) => Promise<unknown>;
}) {
  const [catalog, setCatalog] = useState<WorldCatalog>();
  const [profileId, setProfileId] = useState("");
  const [generationId, setGenerationId] = useState("");
  const [name, setName] = useState("");
  const [settings, setSettings] = useState<WorldSettings>(defaults);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/control/worlds", { signal });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? "World controls unavailable");
      setCatalog(body);
      setError("");
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        setError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      await refresh(controller.signal);
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  const profile = catalog?.profiles.find((p) => p.id === profileId);
  const generation = profile?.generations.find((g) => g.id === generationId);
  const activeGeneration = catalog?.profiles
    .find((p) => p.id === catalog.active?.profileId)
    ?.generations.find((g) => g.id === catalog?.active?.generationId);
  function choose(id: string, genId?: string) {
    const profile = catalog?.profiles.find((p) => p.id === id);
    const generation = profile?.generations.find(
      (g) =>
        g.id ===
        (genId ??
          (catalog?.active?.profileId === id
            ? catalog.active.generationId
            : profile.generations.at(-1)?.id)),
    );
    setProfileId(id);
    setGenerationId(generation?.id ?? "");
    if (generation) setSettings(structuredClone(generation.settings));
  }
  useEffect(() => {
    if (catalog?.active && !profileId)
      choose(catalog.active.profileId, catalog.active.generationId);
  }, [catalog, profileId]);
  const disabled =
    busy ||
    !online ||
    !catalog?.canChange ||
    ["running", "starting", "stopping"].includes(serverStatus ?? "");
  async function change(path: string, body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const result = (await act(path, body)) as WorldCatalog | undefined;
      if (result) {
        setCatalog(result);
        setProfileId("");
        setGenerationId("");
        setMessage(
          "World selected. Start Minecraft to load it; earlier generations are retained.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel world-panel">
      <div className="panel-heading">
        <div>
          <h3>
            <MinecraftIcon name="grass_block" size={24} /> Training worlds
          </h3>
          <p>
            Create, switch, customise and regenerate experiment environments.
          </p>
        </div>
      </div>
      <p className="world-current">
        <MinecraftIcon
          name={worldIcons[activeGeneration?.settings.type ?? "survival"]}
          size={24}
        />
        Current world:{" "}
        <strong>
          {catalog?.profiles.find((p) => p.id === catalog.active?.profileId)
            ?.name ?? "Not prepared"}
        </strong>{" "}
        <code>{catalog?.active?.levelName}</code>
      </p>
      <p className="world-help">
        Finish or cancel Minecraft runs, stop the server, wait for its save,
        then change the world. Start it again when ready.
      </p>
      {catalog?.reason && <div className="notice">{catalog.reason}</div>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="world-help" role="status">
          {message}
        </p>
      )}
      <div className="form-grid">
        <MinecraftSelect
          label="Saved world profile"
          value={profileId}
          placeholder="Select a profile"
          onChange={choose}
          options={(catalog?.profiles ?? []).map((p) => {
            const g =
              p.generations.find(
                (g) => g.id === catalog?.active?.generationId,
              ) ?? p.generations.at(-1);
            return {
              value: p.id,
              label: p.name,
              icon: worldIcons[g?.settings.type ?? "survival"],
              description: g
                ? terrainOptions.find(
                    (option) => option.value === g.settings.type,
                  )?.label
                : undefined,
            };
          })}
        />
        <MinecraftSelect
          label="Saved generation"
          value={generationId}
          placeholder="Select a generation"
          onChange={(id) => choose(profileId, id)}
          options={(profile?.generations ?? [])
            .slice()
            .reverse()
            .map((g, i) => ({
              value: g.id,
              label: `${profile!.generations.length - i} · ${terrainOptions.find((option) => option.value === g.settings.type)?.label ?? g.settings.type}`,
              icon: worldIcons[g.settings.type],
              description: new Date(g.createdAt).toLocaleString(),
            }))}
        />
      </div>
      <div className="world-actions">
        <button
          className="secondary"
          disabled={disabled || !generation}
          onClick={() =>
            change(`worlds/${profileId}/activate`, { generationId })
          }
        >
          Select saved generation
        </button>
        <button
          className="secondary"
          disabled={disabled || !generation}
          onClick={() =>
            change(`worlds/${profileId}/reset`, {
              generationId,
              randomSeed: false,
            })
          }
        >
          <RefreshCw size={14} /> Reset with same seed
        </button>
        <button
          className="secondary"
          disabled={disabled || !generation}
          onClick={() =>
            change(`worlds/${profileId}/reset`, {
              generationId,
              randomSeed: true,
            })
          }
        >
          Refresh with random seed
        </button>
      </div>
      <div className="form-grid world-editor">
        <label>
          New profile name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Movement arena or forest survival"
            maxLength={80}
          />
        </label>
        <MinecraftSelect
          label="Terrain"
          value={settings.type}
          onChange={(type) =>
            setSettings({ ...settings, type: type as WorldSettings["type"] })
          }
          options={terrainOptions}
        />
        <label>
          World seed
          <input
            value={settings.seed}
            onChange={(e) => setSettings({ ...settings, seed: e.target.value })}
            maxLength={64}
            placeholder="Blank generates and records a random seed"
          />
        </label>
        <MinecraftSelect
          label="Difficulty"
          value={settings.difficulty}
          onChange={(difficulty) =>
            setSettings({
              ...settings,
              difficulty: difficulty as WorldSettings["difficulty"],
            })
          }
          options={[
            { value: "peaceful", label: "Peaceful", icon: "grass_block" },
            { value: "easy", label: "Easy", icon: "apple" },
            { value: "normal", label: "Normal", icon: "iron_axe" },
            { value: "hard", label: "Hard", icon: "iron_sword" },
          ]}
        />
        <MinecraftSelect
          label="Agent game mode"
          value={settings.gamemode}
          onChange={(gamemode) =>
            setSettings({
              ...settings,
              gamemode: gamemode as WorldSettings["gamemode"],
            })
          }
          options={[
            { value: "survival", label: "Survival", icon: "iron_pickaxe" },
            { value: "creative", label: "Creative", icon: "diamond" },
            { value: "adventure", label: "Adventure", icon: "compass" },
          ]}
        />
        <label>
          Generated structures
          <select
            value={String(settings.structures)}
            onChange={(e) =>
              setSettings({
                ...settings,
                structures: e.target.value === "true",
              })
            }
          >
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </label>
      </div>
      {settings.type === "flat" && (
        <div className="world-flat">
          <label>
            Flat biome
            <input
              value={settings.flat.biome}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  flat: { ...settings.flat, biome: e.target.value },
                })
              }
              placeholder="minecraft:plains"
            />
          </label>
          <p className="world-help">
            Layers from bottom to top · at most 384 blocks total. Enabled flat
            structures add villages where the biome supports them.
          </p>
          {settings.flat.layers.map((layer, index) => (
            <div className="world-layer" key={index}>
              <label>
                Layer {index + 1} block
                <input
                  value={layer.block}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      flat: {
                        ...settings.flat,
                        layers: settings.flat.layers.map((v, i) =>
                          i === index ? { ...v, block: e.target.value } : v,
                        ),
                      },
                    })
                  }
                  placeholder="minecraft:grass_block"
                />
              </label>
              <label>
                Height
                <input
                  type="number"
                  min={1}
                  max={384}
                  value={layer.height}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      flat: {
                        ...settings.flat,
                        layers: settings.flat.layers.map((v, i) =>
                          i === index
                            ? { ...v, height: Number(e.target.value) }
                            : v,
                        ),
                      },
                    })
                  }
                />
              </label>
              <button
                className="secondary"
                aria-label={`Remove layer ${index + 1}`}
                disabled={settings.flat.layers.length <= 1}
                onClick={() =>
                  setSettings({
                    ...settings,
                    flat: {
                      ...settings.flat,
                      layers: settings.flat.layers.filter(
                        (_, i) => i !== index,
                      ),
                    },
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button
            className="secondary"
            disabled={settings.flat.layers.length >= 32}
            onClick={() =>
              setSettings({
                ...settings,
                flat: {
                  ...settings.flat,
                  layers: [
                    ...settings.flat.layers,
                    { block: "minecraft:grass_block", height: 1 },
                  ],
                },
              })
            }
          >
            Add layer
          </button>
        </div>
      )}
      <div className="world-actions">
        <button
          className="primary"
          disabled={disabled || !name.trim()}
          onClick={() => change("worlds", { name: name.trim(), settings })}
        >
          <Plus size={14} /> Create and select profile
        </button>
        <button
          className="secondary"
          disabled={disabled || !generation}
          onClick={() =>
            change(`worlds/${profileId}/reset`, {
              generationId,
              settings,
              randomSeed: false,
            })
          }
        >
          Apply edits to a fresh generation
        </button>
      </div>
      <p className="world-help">
        Resets preserve earlier terrain, Nether, End and player data in their
        own directories. Returning to a saved generation resumes its previous
        state. ChilledVibe remains a protected admin spectator.
      </p>
    </section>
  );
}
