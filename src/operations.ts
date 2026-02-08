import { EventReporter } from "./progress.ts";

interface ActiveOperation {
  type: string;
  reporter: EventReporter;
}

let activeOperation: ActiveOperation | null = null;

export function isOperationRunning(): boolean {
  return activeOperation !== null;
}

export function getActiveOperation(): ActiveOperation | null {
  return activeOperation;
}

export function startOperation(type: string): EventReporter {
  const reporter = new EventReporter();
  activeOperation = { type, reporter };
  return reporter;
}

export function clearOperation(): void {
  activeOperation = null;
}
