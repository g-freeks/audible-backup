import { spawn } from "child_process";
import * as path from "path";
import { currentUserName, userDirs } from "./users.ts";
import { operationSignal } from "./operations.ts";

/**
 * Wrapper around helper/audible_helper.py — a JSON-over-stdout bridge to the
 * `audible` Python package. Used for structured library listings and AAXC
 * downloads with decryption vouchers. When the helper (or its Python
 * dependency) is unavailable, callers fall back to the audible-cli path.
 */

export interface HelperEvent {
  type: string;
  ok?: boolean;
  reason?: string;
  message?: string;
  [key: string]: unknown;
}

export interface HelperLibraryItem {
  asin: string;
  title: string;
  authors: string;
  downloadable: boolean;
}

/** Thrown when the helper can't run at all (no python3, missing package). */
export class HelperUnavailableError extends Error {}

const HELPER_PATH = path.resolve(import.meta.dirname, "..", "helper", "audible_helper.py");

function helperCommand(): string[] {
  // Test hook: AUDIBLE_HELPER="python3 /path/to/fake_helper.py"
  const override = process.env.AUDIBLE_HELPER;
  if (override) return override.split(" ");
  return ["python3", HELPER_PATH];
}

function helperEnv(): NodeJS.ProcessEnv {
  const userName = currentUserName();
  if (userName) {
    return { ...process.env, AUDIBLE_CONFIG_DIR: userDirs(userName).authDir };
  }
  return process.env;
}

export function runHelper(
  args: string[],
  onEvent?: (event: HelperEvent) => void,
): Promise<HelperEvent> {
  return new Promise((resolve, reject) => {
    const [cmd, ...preArgs] = helperCommand();
    const signal = operationSignal();
    const proc = spawn(cmd, [...preArgs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: helperEnv(),
      signal,
    });

    let doneEvent: HelperEvent | null = null;
    let buffer = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: HelperEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // ignore stray non-JSON output
        }
        if (event.type === "done") {
          doneEvent = event;
        } else {
          onEvent?.(event);
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      // An abort is a cancellation, not a missing helper.
      if (signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      reject(new HelperUnavailableError(`Helper could not start: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (doneEvent) {
        if (doneEvent.ok === false && doneEvent.reason === "missing_dependency") {
          reject(new HelperUnavailableError(doneEvent.message || "missing dependency"));
        } else {
          resolve(doneEvent);
        }
      } else {
        reject(
          new Error(`Helper exited (code ${code}) without result: ${stderr.slice(-300)}`),
        );
      }
    });
  });
}
