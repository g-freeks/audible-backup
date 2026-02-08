import { EventEmitter } from "node:events";

export interface ProgressReporter {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
}

export const consoleReporter: ProgressReporter = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
  warn: (msg) => console.warn(msg),
};

export class EventReporter extends EventEmitter implements ProgressReporter {
  log(message: string): void {
    this.emit("message", { type: "log", message });
  }
  error(message: string): void {
    this.emit("message", { type: "error", message });
  }
  warn(message: string): void {
    this.emit("message", { type: "warn", message });
  }
  done(result?: { success: boolean; summary?: string }): void {
    this.emit("done", result ?? { success: true });
  }
}
