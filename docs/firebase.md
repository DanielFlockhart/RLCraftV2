# Optional Firebase experiment archive

Local operation remains the default. Set `ARCHIVE_PROVIDER=firebase` on the **control service** to archive new run metadata, presets, logs and performance samples in Cloud Firestore, and finished run files/models in Cloud Storage for Firebase. The Admin SDK and credentials run only on the control service; the dashboard talks to its existing authenticated API. Firebase supports these server services through the [Admin SDK](https://firebase.google.com/docs/admin/setup) and [Cloud Storage API](https://firebase.google.com/docs/storage/admin/start).

This is an optional cloud archive, not a replacement for the live SQLite scheduler database. Dashboard graphs still read recent local samples. World files, Minecraft runtime files, active agent state and the durable upload queue remain on the runtime host. Do not remove local data after enabling archiving. Historical cloud queries/restoration, cloud-only storage and a distributed scheduler require further implementation behind the archive boundary.

## Enable later

Create your Firebase project, Firestore database and Storage bucket when you want to use them. Grant the runtime service account Firestore data access and object access to that bucket. Use Google Application Default Credentials: an assigned service account on a Google Cloud host, or a private service-account JSON file for local development. The browser's Firebase API key is not an Admin credential.

Add these values to the control service environment or root `.env`:

```dotenv
ARCHIVE_PROVIDER=firebase
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_STORAGE_BUCKET=your-project-id.firebasestorage.app
FIREBASE_ARCHIVE_PREFIX=rlcraftRuntimes
# Omit on a Google Cloud host using its assigned service account.
GOOGLE_APPLICATION_CREDENTIALS=C:/private/firebase-service-account.json
```

Use your bucket's actual name, without `gs://`; existing projects may have a different suffix. Keep credential files outside the repository and mount them as read-only secrets. Restart the control service after setting the environment. No credentials are needed and no Firebase clients are initialized with `ARCHIVE_PROVIDER=local`.

**Overview → Cloud archive** shows pending records, upload status, the last successful batch and retry failures. **Sync now** starts one immediate batch; automatic processing continues every five seconds. Each batch contains at most 200 events and normally at most 256 KiB of source data. Repeated run/preset updates coalesce, while logs and graph samples are grouped by run into batch documents to reduce write volume. Firestore bills operations and storage; batching does not make uploads free. See [Firestore pricing](https://firebase.google.com/docs/firestore/pricing).

Disabling archiving stops recording new cloud events and preserves already queued work. Re-enabling the same destination resumes that queue. Changing project, bucket or prefix with pending work is rejected to prevent sending old data to an unintended destination. Existing history from before enabling is not automatically backfilled.

## Data layout

Each SQLite database has a persisted runtime UUID. Cloud paths are scoped to that ID, so independent runtimes do not collide:

```text
Firestore: <prefix>/<runtime-uuid>/
  runs/<run-uuid>                         Latest run metadata/configuration
    artifacts/<hash-of-relative-name>     Object name, size and SHA-256 checksum
  presets/<preset-uuid>                   Latest preset; deletion removes it
  arenaPresets/<preset-uuid>              Training structure blueprint
  logBatches/<first-event-sequence>       Ordered log records and run ID
  metricBatches/<first-event-sequence>    Reward/throughput/tick/memory samples
  hostBatches/<first-event-sequence>      Control CPU/memory/event-loop samples

Cloud Storage: <prefix>/<runtime-uuid>/runs/<run-uuid>/
  config.json
  metrics.jsonl
  episodes.jsonl
  checkpoint.json
  models.json                  Actual model architecture/configuration snapshot
  models/<your model files>
```

Batch documents have `schemaVersion`, `runId`, `firstAt`, `lastAt`, `count` and `records`. Each record has its durable `sequence` and original `value`. Cloud analytics can query by run/time range and flatten those records. These are training analytics, independent of Firebase Analytics/browser telemetry. Run records contain the full starting setup and world generation/settings, but not the terrain itself.

Firestore documents have size limits, so binary models and full JSONL histories go into object storage. See [Firestore limits](https://firebase.google.com/docs/firestore/quotas). Index exemptions for batch `records` fields are provided in `deploy/firebase/firestore.indexes.json`; run/time fields remain available for queries. Add compound indexes when implementing cloud historical queries.

## Models and consistency

Your trainer can save model files beneath its run's artifact directory in `models/`. Save/close them before the worker exits. The scheduler queues upload after that exit, including partial files for failed/cancelled runs when present. Interrupted runs are queued for artifact upload during recovery. Empty/missing artifact directories require no upload. Only standard run files and `models/` are archived; links are rejected.

SQLite triggers record archive work in the same transaction as live state. Network failure leaves that work pending, with exponential retry delay capped at five minutes. Cloud outages do not block training or dashboard requests. Local retention does not remove queued uploads. The queue can grow during an extended outage; its database and unsent files must remain on persistent storage.

Uploads use stable document/object paths and streaming transfers. A retry may rewrite the same batch or object; it does not create duplicate logical record IDs, although Storage object versioning can retain previous generations. File manifests record SHA-256 for future download verification. Cloud object writes and Firestore manifests are not one cross-service transaction: work is acknowledged only after the whole batch succeeds. Shutdown aborts stream transfers and leaves unfinished work for restart. Do not edit finished run files while uploads are pending.

No remote retention/deletion policy is applied automatically. Set cloud lifecycle/retention deliberately when enabling it. Local log retention remains as documented in operations.

## Optional containers

The default Compose profile remains local. A service-account secret overlay is included:

```powershell
docker compose --env-file .env -f deploy/compose.yml -f deploy/firebase/compose.yml up --build --detach
```

The overlay requires project, bucket and an **absolute host path** in `GOOGLE_APPLICATION_CREDENTIALS`, and mounts the credential only into the control container. On a Google Cloud VM with an assigned service account, pass the Firebase environment settings into the control container without the JSON-secret overlay instead.

`deploy/firebase/firebase.json`, rules and indexes are templates for a dedicated archive project. Rules deny direct browser/client access; Admin access is controlled through service-account IAM. They have not been deployed. Review existing project rules before applying templates, because deployment replaces the targeted rules/index configuration.

## Verification and further work

`npm test` checks durable retry/restart behavior, destination guards, batching, shutdown and model-file isolation without a Firebase account. It also sends real Admin SDK Firestore batches to an isolated local test endpoint using a generated test certificate. The production dashboard proxy smoke check verifies local status and disabled-sync behavior. A real Firebase project's permissions and Storage uploads still need an integration check when credentials are enabled.

`ArchiveSink` separates Firebase from orchestration; another backend can implement the same contract. To move historical dashboard queries to Firebase, add a paginated cloud history/artifact reader behind the control API and migrate retained local history. Replacing the scheduler database requires asynchronous storage/queue contracts and concurrency control; archiving alone does not provide multi-host worker leases.
