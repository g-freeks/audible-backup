import { EventEmitter } from "node:events";

export interface ProgressReporter {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  progress?(percent: number, label: string): void;
  bookStart?(asin: string): void;
  bookProgress?(asin: string, percent: number): void;
  bookDone?(asin: string, success: boolean): void;
}

export const consoleReporter: ProgressReporter = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
  warn: (msg) => console.warn(msg),
  progress: (pct, label) => {
    const barWidth = 30;
    const filled = Math.round((pct / 100) * barWidth);
    const bar = "\u2588".repeat(filled) + "\u2591".repeat(barWidth - filled);
    process.stdout.write(`\r  ${label}: ${bar} ${pct}%`);
    if (pct >= 100) process.stdout.write("\n");
  },
};

export class EventReporter extends EventEmitter implements ProgressReporter {
  private buffer: { event: string; data: any }[] = [];
  private buffering = true;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  private bufferedEmit(event: string, data: any): void {
    if (this.buffering) {
      this.buffer.push({ event, data });
    }
    this.emit(event, data);
  }

  /** Replay all buffered events to current listeners, then stop buffering. */
  replay(): void {
    this.buffering = false;
    for (const { event, data } of this.buffer) {
      this.emit(event, data);
    }
    this.buffer = [];
  }

  log(message: string): void {
    this.bufferedEmit("message", { type: "log", message });
  }
  error(message: string): void {
    this.bufferedEmit("message", { type: "error", message });
  }
  warn(message: string): void {
    this.bufferedEmit("message", { type: "warn", message });
  }
  progress(percent: number, label: string): void {
    this.bufferedEmit("progress", { percent, label });
  }
  bookStart(asin: string): void {
    this.bufferedEmit("book-start", { asin });
  }
  bookProgress(asin: string, percent: number): void {
    this.bufferedEmit("book-progress", { asin, percent });
  }
  bookDone(asin: string, success: boolean): void {
    this.bufferedEmit("book-done", { asin, success });
  }
  done(result?: { success: boolean; summary?: string }): void {
    this.bufferedEmit("done", result ?? { success: true });
  }
}
