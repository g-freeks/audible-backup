import { EventReporter } from "./progress.ts";

interface ActiveOperation {
  type: string;
  reporter: EventReporter;
  finished: boolean;
}

let activeOperation: ActiveOperation | null = null;

export function isOperationRunning(): boolean {
  return activeOperation !== null && !activeOperation.finished;
}

export function getActiveOperation(): ActiveOperation | null {
  return activeOperation;
}

export function startOperation(type: string): EventReporter {
  const reporter = new EventReporter();
  activeOperation = { type, reporter, finished: false };
  return reporter;
}

export function clearOperation(): void {
  if (activeOperation) {
    activeOperation.finished = true;
    // Keep the operation around so the SSE stream endpoint can still find it
    // and replay buffered events. Clean up after a delay.
    const op = activeOperation;
    setTimeout(() => {
      if (activeOperation === op) {
        activeOperation = null;
      }
    }, 5000);
  }
}
