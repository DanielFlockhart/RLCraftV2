"use client";
import type { ArchiveState } from "@mlcraft/core";
export function ArchiveStatus({
  state,
  disabled,
  sync,
}: {
  state?: ArchiveState;
  disabled: boolean;
  sync: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h3>Cloud archive</h3>
          <p>
            {state?.provider === "firebase"
              ? "Firebase · Firestore + Cloud Storage"
              : "Local storage · Firebase optional"}
          </p>
        </div>
        {state?.provider === "firebase" && (
          <button
            className="secondary"
            disabled={disabled || state.syncing}
            onClick={sync}
          >
            {state.syncing ? "Uploading…" : "Sync now"}
          </button>
        )}
      </div>
      <div className="world-help">
        {state?.provider === "firebase" ? (
          <>
            <p>
              {state.pending.toLocaleString()} pending records · Last upload:{" "}
              {state.lastSyncedAt
                ? new Date(state.lastSyncedAt).toLocaleString()
                : "Not yet synced"}
              .
            </p>
            <p>
              Cloud copies preserve experiment history and artifacts. The live
              dashboard and scheduler still use local storage.
            </p>
            {state.nextRetryAt && (
              <p>
                Next retry: {new Date(state.nextRetryAt).toLocaleTimeString()}.
              </p>
            )}
          </>
        ) : (
          <p>
            Runs, logs, graphs and checkpoints are stored locally. Configure
            Firebase on the control service to enable background archiving;
            credentials stay on that service.
          </p>
        )}
        {state?.error && <p className="error-text">{state.error}</p>}
      </div>
    </section>
  );
}
