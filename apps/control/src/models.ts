import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { ModelSnapshot, StageId } from "@rlcraft/core";
import { root } from "./config.js";

// Hash code, not mtimes, so replacing a file always invalidates the preview.
export async function modelCodeVersion(base = root): Promise<string> {
  const hash = createHash("sha256");
  async function walk(path: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (
        ["node_modules", "dist", ".next", "__pycache__"].includes(entry.name) ||
        entry.isSymbolicLink()
      )
        continue;
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(ts|tsx|js|mjs|cjs|py|json)$/.test(entry.name)) {
        hash.update(relative(base, file));
        hash.update(await readFile(file));
      }
    }
  }
  await walk(resolve(base, "packages"));
  return hash.digest("hex");
}
export class ModelCatalog {
  private cache = new Map<
    StageId,
    { version: string; snapshot: ModelSnapshot }
  >();
  private pending = new Map<string, Promise<ModelSnapshot>>();
  async preview(stage: StageId, fresh = false): Promise<ModelSnapshot> {
    const version = await modelCodeVersion();
    const cached = this.cache.get(stage);
    if (
      !fresh &&
      cached?.version === version &&
      Date.now() - cached.snapshot.sampledAt < 30000
    )
      return cached.snapshot;
    const key = `${stage}:${version}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.probe(stage)
      .then(async (snapshot) => {
        if ((await modelCodeVersion()) !== version)
          throw new Error(
            "Model code changed during inspection; refresh to inspect the new version",
          );
        snapshot.codeVersion = version;
        this.cache.set(stage, { version, snapshot });
        return snapshot;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }
  private probe(stage: StageId): Promise<ModelSnapshot> {
    return new Promise((accept, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=512",
          "--import",
          "tsx",
          resolve(root, "apps/control/src/model-probe.ts"),
          stage,
        ],
        {
          cwd: root,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            "Model preview exceeded ten seconds. Initialize heavyweight models in a run and inspect the runtime instead.",
          ),
        );
      }, 10000);
      let result: ModelSnapshot | undefined;
      child.on("message", (message) => {
        result = message as ModelSnapshot;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !result)
          reject(
            new Error(
              "Model preview could not be inspected. Inspect an initialized run or check the registry factory.",
            ),
          );
        else accept(result);
      });
    });
  }
}
