import type { InputValue } from "@rlcraft/core";
export interface InputEvent {
  sequence: number;
  at: number;
  channel: string;
  name: string;
  data: InputValue;
  bytes: number;
}
export class InputEvents {
  private entries: InputEvent[] = [];
  private bytes = 0;
  sequence = 0;
  droppedEvents = 0;
  droppedBytes = 0;
  constructor(
    private count: number,
    private budget: number,
    private maximum: number,
    private windowMs: number,
  ) {}
  push(channel: string, name: string, data: InputValue, at = Date.now()) {
    const bytes = Buffer.byteLength(JSON.stringify(data)),
      sequence = ++this.sequence;
    if (bytes > this.maximum || bytes > this.budget) {
      this.droppedEvents++;
      this.droppedBytes += bytes;
      return;
    }
    this.entries.push({ sequence, at, channel, name, data, bytes });
    this.bytes += bytes;
    while (this.entries.length > this.count || this.bytes > this.budget) {
      const lost = this.entries.shift()!;
      this.bytes -= lost.bytes;
      this.droppedEvents++;
      this.droppedBytes += lost.bytes;
    }
    this.expire(at);
  }
  private expire(at: number) {
    while (this.entries.length && this.entries[0].at < at - this.windowMs)
      this.bytes -= this.entries.shift()!.bytes;
  }
  read(channel: string, at = Date.now()) {
    this.expire(at);
    return this.entries
      .filter((entry) => entry.channel === channel)
      .map(({ bytes, ...entry }) => entry);
  }
  get diagnostics() {
    return {
      droppedEvents: this.droppedEvents,
      droppedBytes: this.droppedBytes,
      eventBytes: this.bytes,
    };
  }
}
