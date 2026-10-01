import {
  initializeApp,
  applicationDefault,
  deleteApp,
  type Credential,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat, lstat } from "node:fs/promises";
import { relative, resolve, sep, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import { archiveDocuments } from "./archive-documents.js";
import type { ArchiveSink } from "./archive.js";
import type { ArchiveEvent } from "./archive-queue.js";

export interface FirebaseArchiveSettings {
  projectId: string;
  bucket: string;
  prefix: string;
  artifactDir: string;
}

/** Top-level run files and models/** only. Never traverse links or other runtime data. */
export async function artifactFiles(root: string, runId: string) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid archive run ID");
  const directory = resolve(root, runId);
  const files: { path: string; name: string; bytes: number }[] = [];
  let canonical: string;
  try {
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error("Artifact directory links cannot be archived");
    canonical = await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  const fromRoot = relative(await realpath(root), canonical);
  if (
    fromRoot.startsWith(".." + sep) ||
    fromRoot === ".." ||
    isAbsolute(fromRoot)
  )
    throw new Error("Artifact directory leaves its storage root");
  async function walk(path: string, prefix: string, depth: number) {
    if (depth > 16)
      throw new Error("Model directory exceeds archive depth limit");
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Artifact links cannot be archived");
      const name = prefix + entry.name;
      const nested = !!prefix;
      if (entry.isDirectory() && (nested || entry.name === "models"))
        await walk(resolve(path, entry.name), name + "/", depth + 1);
      else if (
        entry.isFile() &&
        (nested ||
          [
            "config.json",
            "metrics.jsonl",
            "episodes.jsonl",
            "evolution.jsonl",
            "motor-trials.jsonl",
            "controls.jsonl",
            "checkpoint.json",
            "models.json",
            "inputs.jsonl",
          ].includes(name))
      ) {
        const fullPath = await realpath(resolve(path, entry.name));
        const within = relative(canonical, fullPath);
        if (
          within.startsWith(".." + sep) ||
          within === ".." ||
          isAbsolute(within)
        )
          throw new Error("Artifact file leaves its run directory");
        if (files.length >= 10000)
          throw new Error("Run exceeds 10,000 archived artifact files");
        files.push({
          path: fullPath,
          name,
          bytes: (await stat(fullPath)).size,
        });
      }
    }
  }
  await walk(directory, "", 0);
  return files;
}

export function createFirebaseArchive(
  settings: FirebaseArchiveSettings,
  credential: Credential = applicationDefault(),
): ArchiveSink {
  const app = initializeApp(
    {
      credential,
      projectId: settings.projectId,
      storageBucket: settings.bucket,
    },
    `rlcraft-archive-${Date.now()}`,
  );
  const firestore = getFirestore(app);
  firestore.settings({
    ignoreUndefinedProperties: true,
    preferRest: true,
    clientConfig: {
      interfaces: {
        "google.firestore.v1.Firestore": {
          retry_codes: { archive_none: [] },
          retry_params: {
            archive_bounded: {
              initial_retry_delay_millis: 100,
              retry_delay_multiplier: 1,
              max_retry_delay_millis: 100,
              initial_rpc_timeout_millis: 15000,
              rpc_timeout_multiplier: 1,
              max_rpc_timeout_millis: 15000,
              total_timeout_millis: 15000,
            },
          },
          methods: {
            Commit: {
              timeout_millis: 15000,
              retry_codes_name: "archive_none",
              retry_params_name: "archive_bounded",
            },
          },
        },
      },
    },
  });
  const bucket = getStorage(app).bucket();
  return {
    async write(
      runtimeId: string,
      events: ArchiveEvent[],
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      const base = `${settings.prefix}/${runtimeId}`;
      const batch = firestore.batch();
      for (const document of archiveDocuments(events)) {
        const ref = firestore.doc(`${base}/${document.path}`);
        if (document.value === null) batch.delete(ref);
        else batch.set(ref, document.value);
      }
      if (events.some((event) => event.kind !== "artifacts"))
        await batch.commit();
      for (const event of events.filter(
        (event) => event.kind === "artifacts",
      )) {
        for (const file of await artifactFiles(
          settings.artifactDir,
          event.key,
        )) {
          signal.throwIfAborted();
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(file.path, { signal }))
            hash.update(chunk);
          const sha256 = hash.digest("hex");
          const object = `${base}/runs/${event.key}/${file.name}`;
          await pipeline(
            createReadStream(file.path),
            bucket.file(object).createWriteStream({
              timeout: 30000,
              resumable: file.bytes > 5 * 1024 * 1024,
              metadata: { metadata: { sha256, runId: event.key, runtimeId } },
            }),
            { signal },
          );
          const id = createHash("sha256").update(file.name).digest("hex");
          await firestore.doc(`${base}/runs/${event.key}/artifacts/${id}`).set({
            name: file.name,
            bytes: file.bytes,
            sha256,
            bucket: settings.bucket,
            object,
            schemaVersion: 1,
          });
        }
      }
    },
    async close() {
      await firestore.terminate();
      await deleteApp(app);
    },
  };
}
