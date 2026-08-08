import { randomBytes } from "node:crypto";

// In-memory session store: token -> username. Sessions don't survive a
// server restart; users just sign in again.
const sessions = new Map<string, string>();

export function createSession(userName: string): string {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, userName);
  return token;
}

export function getSessionUser(token: string | undefined): string | undefined {
  return token ? sessions.get(token) : undefined;
}

export function destroySession(token: string | undefined): void {
  if (token) sessions.delete(token);
}
