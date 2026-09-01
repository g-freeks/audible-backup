import { spawn } from "child_process";
import { currentUserName, userDirs } from "./users.ts";
import { operationSignal } from "./operations.ts";
import * as path from "node:path";
import { desktopPaths, isDesktopMode } from "./config.ts";
import * as commands from "./audible/commands.ts";
import { CommandError, type HelperEvent } from "./audible/commands.ts";

/**
 * The Audible bridge.
 *
 * This used to spawn a Python helper built on the `audible` package. That
 * client is now implemented in TypeScript (`src/audible/`), so the default
 * path needs no Python at all. The command names and JSON event shape are
 * unchanged, so callers did not have to move with it.
 *
 * Setting AUDIBLE_HELPER still routes through an external process, which is
 * how the tests drive a fake helper — and how anyone who needs the old Python
 * implementation back can have it.
 */

export type { HelperEvent };

export interface HelperLibraryItem {
  asin: string;
  title: string;
  authors: string;
  downloadable: boolean;
  narrators?: string;
  releaseDate?: string;
  addedToLibraryDate?: string;
  runtimeMinutes?: number;
  language?: string;
  formatType?: string;
  seriesTitle?: string;
  seriesSequence?: string;
}

/** Thrown when the Audible client cannot run at all. */
export class HelperUnavailableError extends Error {}

/** Where this user's Audible credentials live. */
function configDir(): string {
  const userName = currentUserName();
  if (userName) return userDirs(userName).authDir;
  if (process.env.AUDIBLE_CONFIG_DIR) return process.env.AUDIBLE_CONFIG_DIR;
  // Legacy single-user mode: the same default the Python helper used.
  if (isDesktopMode()) return desktopPaths.authDir;
  return path.join(process.env.HOME || "", ".audible");
}

export function runHelper(
  args: string[],
  onEvent?: (event: HelperEvent) => void,
): Promise<HelperEvent> {
  const override = process.env.AUDIBLE_HELPER;
  if (override) return runExternalHelper(override, args, onEvent);
  return runBuiltinHelper(args, onEvent);
}

async function runBuiltinHelper(
  args: string[],
  onEvent?: (event: HelperEvent) => void,
): Promise<HelperEvent> {
  const [command, ...rest] = args;
  const emit = (event: HelperEvent) => onEvent?.(event);
  const dir = configDir();

  try {
    switch (command) {
      case "login-url":
        return commands.loginUrl(rest[0]);
      case "login-complete":
        return await commands.loginComplete(rest[0], rest[1], rest[2], rest[3], dir);
      case "login-status":
        return commands.loginStatus(dir);
      case "library":
        return await commands.library(dir);
      case "download":
        return await commands.download(rest[0], rest[1], rest[2] || "", dir, emit);
      default:
        throw new CommandError("bad_args", `Unknown command: ${command}`);
    }
  } catch (err) {
    if (operationSignal()?.aborted) throw new Error("Cancelled");
    if (err instanceof CommandError) {
      return { type: "done", ok: false, reason: err.reason, message: err.message };
    }
    throw err;
  }
}

/**
 * The original behaviour: spawn a process that speaks one JSON object per
 * line on stdout. Retained for AUDIBLE_HELPER.
 */
function runExternalHelper(
  override: string,
  args: string[],
  onEvent?: (event: HelperEvent) => void,
): Promise<HelperEvent> {
  return new Promise((resolve, reject) => {
    const [cmd, ...preArgs] = override.split(" ");
    const signal = operationSignal();
    const proc = spawn(cmd, [...preArgs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AUDIBLE_CONFIG_DIR: configDir() },
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
