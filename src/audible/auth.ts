import * as fs from "node:fs";
import * as path from "node:path";
import { createSign } from "node:crypto";
import { getLocale, type Locale } from "./locale.ts";
import type { Registration } from "./login.ts";

/**
 * The credentials a registered device holds, and how requests are signed
 * with them.
 *
 * The on-disk format is deliberately the one the `audible` Python package
 * writes, so a library signed in through the old helper keeps working without
 * asking the user to sign in again.
 */

export interface AuthData {
  adp_token: string;
  device_private_key: string;
  access_token: string;
  refresh_token: string;
  expires: number;
  website_cookies: Record<string, string> | null;
  store_authentication_cookie: unknown;
  device_info: Record<string, string>;
  customer_info: Record<string, string>;
  locale_code: string;
}

const AUTH_FILE = "audible_backup.json";
const CONFIG_FILE = "config.toml";
const PROFILE = "audible_backup";

/**
 * Python's `datetime.now(UTC).isoformat("T") + "Z"`: microsecond precision, a
 * +00:00 offset *and* a trailing Z. The oddity is load-bearing — this exact
 * string is both signed and sent, and it is what Audible accepts today.
 */
export function signatureDate(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, -1)}000+00:00Z`;
}

export interface SignedHeaders {
  "x-adp-token": string;
  "x-adp-alg": string;
  "x-adp-signature": string;
}

/** RSA-signs one request the way Audible's ADP scheme expects. */
export function signRequest(
  method: string,
  requestPath: string,
  body: string,
  adpToken: string,
  privateKey: string,
  date: string = signatureDate(),
): SignedHeaders {
  const data = `${method}\n${requestPath}\n${date}\n${body}\n${adpToken}`;
  const signature = createSign("RSA-SHA256").update(data).sign(privateKey, "base64");

  return {
    "x-adp-token": adpToken,
    "x-adp-alg": "SHA256withRSA:1.0",
    "x-adp-signature": `${signature}:${date}`,
  };
}

export class Authenticator {
  readonly data: AuthData;
  readonly locale: Locale;
  private readonly configDir: string;

  constructor(data: AuthData, configDir: string) {
    this.data = data;
    this.configDir = configDir;
    this.locale = getLocale(data.locale_code);
  }

  static fromRegistration(
    registration: Registration,
    locale: Locale,
    configDir: string,
  ): Authenticator {
    return new Authenticator(
      {
        adp_token: registration.adpToken,
        device_private_key: registration.devicePrivateKey,
        access_token: registration.accessToken,
        refresh_token: registration.refreshToken,
        expires: registration.expires,
        website_cookies: registration.websiteCookies,
        store_authentication_cookie: registration.storeAuthenticationCookie,
        device_info: registration.deviceInfo,
        customer_info: registration.customerInfo,
        locale_code: locale.countryCode,
      },
      configDir,
    );
  }

  static authFile(configDir: string): string {
    return path.join(configDir, AUTH_FILE);
  }

  /** Reads credentials written by either this code or the Python helper. */
  static load(configDir: string): Authenticator {
    const file = Authenticator.authFile(configDir);
    if (!fs.existsSync(file)) {
      throw new Error(`Not signed in to Audible (no credentials at ${file})`);
    }

    const data = JSON.parse(fs.readFileSync(file, "utf8")) as AuthData;
    if (!data.adp_token || !data.device_private_key) {
      throw new Error(
        "The stored Audible credentials are unusable — sign in again. " +
          "(Encrypted credential files are not supported.)",
      );
    }

    // The Python package keeps the marketplace in config.toml rather than in
    // the auth file, so fall back to reading it from there.
    if (!data.locale_code) {
      data.locale_code = readMarketplace(configDir) || "us";
    }
    return new Authenticator(data, configDir);
  }

  static isLinked(configDir: string): boolean {
    return fs.existsSync(Authenticator.authFile(configDir));
  }

  save(): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(
      Authenticator.authFile(this.configDir),
      JSON.stringify(this.data, null, 2),
    );
    // audible-cli locates the auth file through config.toml. Writing one keeps
    // the command-line tool usable against the same directory.
    fs.writeFileSync(
      path.join(this.configDir, CONFIG_FILE),
      'title = "Audible Config File"\n\n' +
        "[APP]\n" +
        `primary_profile = "${PROFILE}"\n\n` +
        `[profile.${PROFILE}]\n` +
        `auth_file = "${AUTH_FILE}"\n` +
        `country_code = "${this.data.locale_code}"\n`,
    );
  }

  get deviceSerial(): string {
    return this.data.device_info.device_serial_number;
  }

  get deviceType(): string {
    return this.data.device_info.device_type;
  }

  get customerId(): string {
    return this.data.customer_info.user_id;
  }

  sign(method: string, requestPath: string, body: string): SignedHeaders {
    return signRequest(
      method,
      requestPath,
      body,
      this.data.adp_token,
      this.data.device_private_key,
    );
  }

  /**
   * Refreshes the bearer token when it is close to expiry. Signed requests do
   * not use it, so this only matters for the endpoints that do.
   */
  async refreshIfNeeded(): Promise<void> {
    if (this.data.expires - Date.now() / 1000 > 60) return;

    const response = await fetch(`https://api.amazon.${this.locale.domain}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        app_name: "Audible",
        app_version: "3.56.2",
        source_token: this.data.refresh_token,
        requested_token_type: "access_token",
        source_token_type: "refresh_token",
      }),
    });
    if (!response.ok) {
      throw new Error(`Could not refresh the Audible access token (${response.status})`);
    }

    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.data.access_token = json.access_token;
    this.data.expires = Date.now() / 1000 + Number(json.expires_in);
    this.save();
  }
}

/** The `country_code` from an audible-cli style config.toml, if present. */
function readMarketplace(configDir: string): string | undefined {
  const file = path.join(configDir, CONFIG_FILE);
  if (!fs.existsSync(file)) return undefined;
  return fs.readFileSync(file, "utf8").match(/country_code\s*=\s*"([^"]+)"/)?.[1];
}

export function storedMarketplace(configDir: string): string {
  return readMarketplace(configDir) || "";
}
