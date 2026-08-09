import { EventReporter } from "./progress.ts";
import { currentUserName } from "./users.ts";

interface ActiveOperation {
  type: string;
  /** Owning user in multi-tenant mode; undefined in legacy single-user mode. */
  user?: string;
  reporter: EventReporter;
  finished: boolean;
  cancelled: boolean;
  /** Aborting kills every child process spawned for this operation. */
  controller: AbortController;
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
  activeOperation = {
    type,
    user: currentUserName(),
    reporter,
    finished: false,
    cancelled: false,
    controller: new AbortController(),
  };
  return reporter;
}

/**
 * Signal for child processes belonging to the running operation. Passing it to
 * `spawn` means cancelling kills ffmpeg, audible-cli and the Python helper.
 * Undefined outside an operation (the CLI), where nothing can cancel.
 */
export function operationSignal(): AbortSignal | undefined {
  if (!activeOperation || activeOperation.finished) return undefined;
  return activeOperation.controller.signal;
}

/** Returns false when there was nothing to cancel. */
export function cancelOperation(): boolean {
  if (!activeOperation || activeOperation.finished) return false;
  activeOperation.cancelled = true;
  activeOperation.reporter.warn("Cancelling…");
  activeOperation.controller.abort();
  return true;
}

/** Whether the operation currently finishing was cancelled by the user. */
export function wasCancelled(): boolean {
  return activeOperation?.cancelled ?? false;
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
