import type { ArchiveState } from "@rlcraft/core";
import type { ArchiveEvent, ArchiveQueue } from "./archive-queue.js";

export interface ArchiveSink {
  write(
    runtimeId: string,
    events: ArchiveEvent[],
    signal: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Isolates cloud latency/failures from training and HTTP. One bounded batch at a time. */
export class CloudArchive {
  private sink?: ArchiveSink;
  private inflight?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private failures = 0;
  private controller?: AbortController;
  private nextRetry = 0;
  private state: Omit<ArchiveState, "pending" | "runtimeId">;
  constructor(
    private queue: ArchiveQueue,
    private factory?: () => Promise<ArchiveSink>,
  ) {
    this.state = {
      provider: factory ? "firebase" : "local",
      mode: factory ? "archive" : "local",
      syncing: false,
    };
  }
  snapshot(): ArchiveState {
    return {
      ...this.state,
      runtimeId: this.queue.runtimeId,
      pending: this.queue.pending(),
    };
  }
  start() {
    if (!this.factory || this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.sync();
    }, 5000);
    this.timer.unref();
    void this.sync();
  }
  sync(force = false): Promise<void> {
    if (this.closed || !this.factory || (!force && Date.now() < this.nextRetry))
      return Promise.resolve();
    if (this.inflight) return this.inflight;
    const events = this.queue.batch();
    if (!events.length) return Promise.resolve();
    this.state.syncing = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.inflight = Promise.resolve().then(async () => {
      try {
        this.sink ??= await this.factory!();
        signal.throwIfAborted();
        await this.sink.write(this.queue.runtimeId, events, signal);
        this.queue.ack(events.at(-1)!.id);
        this.state.lastSyncedAt = new Date().toISOString();
        this.state.error = undefined;
        this.state.nextRetryAt = undefined;
        this.failures = 0;
        this.nextRetry = 0;
      } catch (error) {
        // Do not archive our own errors, which would recursively grow the queue.
        this.state.error = (
          error instanceof Error ? error.message : "Cloud archive failed"
        ).slice(0, 500);
        this.nextRetry =
          Date.now() +
          Math.min(300000, 5000 * 2 ** Math.min(this.failures++, 6));
        this.state.nextRetryAt = new Date(this.nextRetry).toISOString();
      } finally {
        this.state.syncing = false;
        this.inflight = undefined;
      }
    });
    return this.inflight;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.controller?.abort(
      new Error("Archive shutdown; unacknowledged work will resume on restart"),
    );
    await this.inflight;
    await this.sink?.close();
  }
}
