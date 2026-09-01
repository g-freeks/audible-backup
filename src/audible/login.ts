import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Locale } from "./locale.ts";

/**
 * Signing in to Audible, without ever seeing the password.
 *
 * Amazon's OAuth flow with PKCE: we build a sign-in URL, the user completes it
 * on Amazon's own page, and Amazon redirects to a URL carrying an
 * authorization code. Exchanging that code registers a "device" and returns
 * the long-lived credentials the API needs.
 *
 * Ported from the `audible` Python package (login.py, register.py). The
 * constants below are that package's, and are what makes Audible treat this as
 * an iPhone app; they are not arbitrary.
 */

const DEVICE_TYPE = "A2CZJZGLK2JJVM";
const APP_VERSION = "3.56.2";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** PKCE verifier: 32 random bytes, base64url-encoded without padding. */
export function createCodeVerifier(): Buffer {
  return Buffer.from(base64url(randomBytes(32)));
}

/** PKCE S256 challenge: base64url(sha256(verifier)), unpadded. */
export function createCodeChallenge(verifier: Buffer): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function buildDeviceSerial(): string {
  return randomUUID().replace(/-/g, "").toUpperCase();
}

/** The serial and device type, hex-encoded — Amazon's "device:" client id. */
export function buildClientId(serial: string): string {
  return Buffer.from(`${serial}#${DEVICE_TYPE}`, "utf8").toString("hex");
}

export interface OAuthRequest {
  url: string;
  serial: string;
  codeVerifier: Buffer;
}

/** `serial` and `verifier` are injectable so the URL can be tested exactly. */
export function buildOAuthUrl(
  locale: Locale,
  serial?: string,
  verifier?: Buffer,
): OAuthRequest {
  const deviceSerial = serial || buildDeviceSerial();
  const codeVerifier = verifier || createCodeVerifier();

  const params = new URLSearchParams({
    "openid.oa2.response_type": "code",
    "openid.oa2.code_challenge_method": "S256",
    "openid.oa2.code_challenge": createCodeChallenge(codeVerifier),
    "openid.return_to": `https://www.amazon.${locale.domain}/ap/maplanding`,
    "openid.assoc_handle": `amzn_audible_ios_${locale.countryCode}`,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    pageId: "amzn_audible_ios",
    accountStatusPolicy: "P1",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.mode": "checkid_setup",
    "openid.ns.oa2": "http://www.amazon.com/ap/ext/oauth/2",
    "openid.oa2.client_id": `device:${buildClientId(deviceSerial)}`,
    "openid.ns.pape": "http://specs.openid.net/extensions/pape/1.0",
    marketPlaceId: locale.marketPlaceId,
    "openid.oa2.scope": "device_auth_access",
    forceMobileLayout: "true",
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.pape.max_auth_age": "0",
  });

  return {
    url: `https://www.amazon.${locale.domain}/ap/signin?${params}`,
    serial: deviceSerial,
    codeVerifier,
  };
}

/**
 * Pulls the authorization code out of the URL Amazon redirects to. That page
 * fails to load — it is a deep link into the iOS app — so the user copies the
 * address bar contents back to us.
 */
export function extractCodeFromUrl(redirectUrl: string): string {
  let query: URLSearchParams;
  try {
    query = new URL(redirectUrl).searchParams;
  } catch {
    throw new Error("That is not a valid URL");
  }
  const code = query.get("openid.oa2.authorization_code");
  if (!code) throw new Error("That URL has no authorization code");
  return code;
}

export interface Registration {
  adpToken: string;
  devicePrivateKey: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds, matching the Python implementation's `expires`. */
  expires: number;
  websiteCookies: Record<string, string> | null;
  storeAuthenticationCookie: unknown;
  deviceInfo: Record<string, string>;
  customerInfo: Record<string, string>;
}

/** Registers a dummy Audible device and returns its long-lived credentials. */
export async function register(
  authorizationCode: string,
  codeVerifier: Buffer,
  locale: Locale,
  serial: string,
): Promise<Registration> {
  const body = {
    requested_token_type: [
      "bearer",
      "mac_dms",
      "website_cookies",
      "store_authentication_cookie",
    ],
    cookies: { website_cookies: [], domain: `.amazon.${locale.domain}` },
    registration_data: {
      domain: "Device",
      app_version: APP_VERSION,
      device_serial: serial,
      device_type: DEVICE_TYPE,
      device_name:
        "%FIRST_NAME%%FIRST_NAME_POSSESSIVE_STRING%%DUPE_STRATEGY_1ST%Audible for iPhone",
      os_version: "15.0.0",
      software_version: "35602678",
      device_model: "iPhone",
      app_name: "Audible",
    },
    auth_data: {
      client_id: buildClientId(serial),
      authorization_code: authorizationCode,
      code_verifier: codeVerifier.toString("utf8"),
      code_algorithm: "SHA-256",
      client_domain: "DeviceLegacy",
    },
    requested_extensions: ["device_info", "customer_info"],
  };

  const response = await fetch(`https://api.amazon.${locale.domain}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await response.json()) as any;
  if (!response.ok) {
    const message =
      json?.response?.error?.message || json?.error_description || response.statusText;
    throw new Error(`Device registration failed: ${message}`);
  }

  const success = json?.response?.success;
  if (!success) throw new Error("Device registration returned no credentials");

  const tokens = success.tokens;
  const cookies = tokens.website_cookies as { Name: string; Value: string }[] | undefined;

  return {
    adpToken: tokens.mac_dms.adp_token,
    devicePrivateKey: tokens.mac_dms.device_private_key,
    accessToken: tokens.bearer.access_token,
    refreshToken: tokens.bearer.refresh_token,
    expires: Date.now() / 1000 + Number(tokens.bearer.expires_in),
    websiteCookies: cookies
      ? Object.fromEntries(cookies.map((c) => [c.Name, c.Value.replace(/"/g, "")]))
      : null,
    storeAuthenticationCookie: tokens.store_authentication_cookie ?? null,
    deviceInfo: success.extensions.device_info,
    customerInfo: success.extensions.customer_info,
  };
}
