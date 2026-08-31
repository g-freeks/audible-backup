import { randomBytes } from "node:crypto";
import { isDesktopMode } from "../config.ts";

/**
 * Desktop mode serves on localhost, and localhost is not a security boundary:
 * any process on the machine could otherwise reach an app holding Audible
 * credentials. The launcher receives this per-launch secret in the URL it
 * opens; the browser then carries it as a cookie.
 */

let token: string | null = null;

export function desktopToken(): string | null {
  if (!isDesktopMode()) return null;
  if (!token) {
    token = process.env.AUDIBLE_DESKTOP_TOKEN || randomBytes(24).toString("hex");
  }
  return token;
}

export const DESKTOP_COOKIE = "desktop_token";
