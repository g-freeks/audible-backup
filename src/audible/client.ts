import { createHash, createDecipheriv } from "node:crypto";
import type { Authenticator } from "./auth.ts";

/**
 * The Audible API, and the one piece of cryptography that makes a download
 * usable: the per-book voucher holding the AAXC decryption key.
 */

const API_VERSION = "1.0";

export interface RequestOptions {
  query?: Record<string, string | number>;
  body?: unknown;
}

/** A signed request to `api.audible.<domain>`. */
export async function apiRequest<T = any>(
  auth: Authenticator,
  method: "GET" | "POST",
  endpoint: string,
  options: RequestOptions = {},
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query || {})) {
    query.set(key, String(value));
  }

  const search = query.toString();
  // The signature covers the path *and* its query string, so both have to be
  // built before signing and then used verbatim.
  const requestPath = `/${API_VERSION}/${endpoint}${search ? `?${search}` : ""}`;
  const body = options.body === undefined ? "" : JSON.stringify(options.body);

  const response = await fetch(`https://api.audible.${auth.locale.domain}${requestPath}`, {
    method,
    headers: {
      Accept: "application/json",
      "Accept-Charset": "utf-8",
      "Content-Type": "application/json",
      ...auth.sign(method, requestPath, body),
    },
    body: method === "POST" ? body : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Audible API ${method} ${endpoint} failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Audible API ${endpoint} returned a non-JSON response`);
  }
}

export interface Voucher {
  key: string;
  iv: string;
  [extra: string]: unknown;
}

/**
 * Decrypts the licence voucher returned with a download.
 *
 * The key is derived from values only the registered device knows, so the
 * voucher is useless to anyone else. AES-128-CBC with no padding, then trailing
 * NULs are stripped — see mkb79/Audible#3.
 */
export function decryptVoucher(
  auth: Authenticator,
  asin: string,
  encryptedVoucher: string,
): Voucher {
  const material = auth.deviceType + auth.deviceSerial + auth.customerId + asin;
  const digest = createHash("sha256").update(material, "ascii").digest();

  const decipher = createDecipheriv("aes-128-cbc", digest.subarray(0, 16), digest.subarray(16, 32));
  decipher.setAutoPadding(false);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedVoucher, "base64")),
    decipher.final(),
  ])
    .toString("utf8")
    .replace(/\0+$/, "");

  try {
    return JSON.parse(plaintext) as Voucher;
  } catch {
    // The plaintext is sometimes truncated mid-object; the two fields that
    // matter come first, so recover them rather than failing the download.
    const match = plaintext.match(/^\{"key":"(?<key>.*?)","iv":"(?<iv>.*?)",/);
    if (!match?.groups) throw new Error("Failed to parse the licence voucher");
    return { key: match.groups.key, iv: match.groups.iv };
  }
}
