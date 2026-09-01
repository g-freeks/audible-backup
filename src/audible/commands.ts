import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getLocale, MARKETPLACES } from "./locale.ts";
import {
  buildOAuthUrl,
  extractCodeFromUrl,
  register,
  type Registration,
} from "./login.ts";
import { Authenticator, storedMarketplace } from "./auth.ts";
import { apiRequest, decryptVoucher } from "./client.ts";

/**
 * The commands the app asks of Audible, in the same JSON-event shape the
 * Python helper used. Keeping that contract means the rest of the application
 * — routes, library, progress reporting — did not have to change when the
 * Python implementation was replaced.
 */

export interface HelperEvent {
  type: string;
  ok?: boolean;
  reason?: string;
  message?: string;
  [key: string]: unknown;
}

export type EmitFn = (event: HelperEvent) => void;

/** Carries a machine-readable reason, as the Python helper's failures did. */
export class CommandError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

const USER_AGENT = "Audible/671 CFNetwork/1240.0.4 Darwin/20.6.0";

function requireLocale(marketplace: string) {
  if (!MARKETPLACES.includes(marketplace)) {
    throw new CommandError("bad_args", `Unknown marketplace: ${marketplace}`);
  }
  return getLocale(marketplace);
}

function loadAuth(configDir: string): Authenticator {
  try {
    return Authenticator.load(configDir);
  } catch (err) {
    throw new CommandError("no_config", (err as Error).message);
  }
}

// --- sign-in ------------------------------------------------------------

export function loginUrl(marketplace: string): HelperEvent {
  const locale = requireLocale(marketplace);
  const { url, serial, codeVerifier } = buildOAuthUrl(locale);
  return {
    type: "done",
    ok: true,
    url,
    serial,
    code_verifier: codeVerifier.toString("base64"),
    marketplace: locale.countryCode,
  };
}

export async function loginComplete(
  marketplace: string,
  serial: string,
  codeVerifierB64: string,
  redirectUrl: string,
  configDir: string,
): Promise<HelperEvent> {
  const locale = requireLocale(marketplace);

  let codeVerifier: Buffer;
  try {
    codeVerifier = Buffer.from(codeVerifierB64, "base64");
    if (codeVerifier.length === 0) throw new Error("empty");
  } catch {
    throw new CommandError("bad_args", "Malformed code verifier");
  }

  let authorizationCode: string;
  try {
    authorizationCode = extractCodeFromUrl(redirectUrl);
  } catch {
    throw new CommandError(
      "bad_redirect_url",
      "That URL has no authorization code. Copy the full address bar " +
        "contents of the page Audible redirected you to after signing in.",
    );
  }

  let registration: Registration;
  try {
    registration = await register(authorizationCode, codeVerifier, locale, serial);
  } catch (err) {
    throw new CommandError("auth_error", (err as Error).message);
  }

  const auth = Authenticator.fromRegistration(registration, locale, configDir);
  auth.save();

  const customer = registration.customerInfo || {};
  return {
    type: "done",
    ok: true,
    marketplace: locale.countryCode,
    account: customer.name || customer.given_name || "",
  };
}

export function loginStatus(configDir: string): HelperEvent {
  const linked = Authenticator.isLinked(configDir);
  return {
    type: "done",
    ok: true,
    linked,
    marketplace: linked ? storedMarketplace(configDir) : "",
  };
}

// --- library ------------------------------------------------------------

interface LibrarySeries {
  title?: string;
  sequence?: string;
}

interface LibraryItem {
  asin?: string;
  title?: string;
  authors?: { name?: string }[];
  narrators?: { name?: string }[];
  content_delivery_type?: string;
  release_date?: string;
  purchase_date?: string;
  runtime_length_min?: number;
  language?: string;
  format_type?: string;
  series?: LibrarySeries[];
}

/**
 * An item can belong to more than one series at once — e.g. an umbrella
 * "universe" series with no sequence number, plus the actual numbered
 * series. Prefer the entry that has a sequence, since that's the one
 * meaningful for sort order.
 */
function pickSeries(series: LibrarySeries[] | undefined): LibrarySeries | undefined {
  if (!series || series.length === 0) return undefined;
  return series.find((s) => s.sequence) || series[0];
}

/** Shapes one raw API library item into the flat, ready-to-use form callers expect. */
export function mapLibraryItem(item: LibraryItem): Record<string, unknown> | null {
  if (!item.asin) return null;
  const delivery = item.content_delivery_type || "";
  const series = pickSeries(item.series);
  return {
    asin: item.asin,
    title: item.title || item.asin,
    authors: (item.authors || [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(", "),
    narrators: (item.narrators || [])
      .map((n) => n.name)
      .filter(Boolean)
      .join(", "),
    downloadable: delivery !== "PodcastParent" && delivery !== "Periodical",
    releaseDate: item.release_date,
    addedToLibraryDate: item.purchase_date,
    runtimeMinutes: item.runtime_length_min,
    language: item.language,
    formatType: item.format_type,
    seriesTitle: series?.title,
    seriesSequence: series?.sequence,
  };
}

export async function library(configDir: string): Promise<HelperEvent> {
  const auth = loadAuth(configDir);
  await auth.refreshIfNeeded();

  const items: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const response = await apiRequest<{ items?: LibraryItem[] }>(auth, "GET", "library", {
      query: {
        num_results: 1000,
        page,
        // 'contributors' carries authors/narrators, 'product_desc' carries
        // release_date, 'product_attrs' carries runtime/language/format, and
        // 'series' carries series membership — without each, the
        // corresponding field comes back missing/null.
        response_groups: "contributors,product_desc,product_attrs,series",
      },
    });

    const batch = response.items || [];
    for (const item of batch) {
      const mapped = mapLibraryItem(item);
      if (mapped) items.push(mapped);
    }
    if (batch.length < 1000) break;
  }

  return { type: "done", ok: true, items };
}

// --- download -----------------------------------------------------------

function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

async function downloadTo(
  url: string,
  destination: string,
  emit: EmitFn,
  asin?: string,
): Promise<void> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new CommandError(
      "download_failed",
      `Download failed with HTTP ${response.status}`,
    );
  }

  const total = Number(response.headers.get("content-length") || 0);
  let received = 0;
  let lastPercent = -1;

  const source = Readable.fromWeb(response.body as any);
  if (total && asin) {
    source.on("data", (chunk: Buffer) => {
      received += chunk.length;
      const percent = Math.floor((received * 100) / total);
      if (percent !== lastPercent) {
        lastPercent = percent;
        emit({ type: "progress", asin, pct: percent });
      }
    });
  }

  await pipeline(source, fs.createWriteStream(destination));
}

export async function download(
  asin: string,
  targetDir: string,
  title: string,
  configDir: string,
  emit: EmitFn,
): Promise<HelperEvent> {
  const auth = loadAuth(configDir);
  await auth.refreshIfNeeded();
  fs.mkdirSync(targetDir, { recursive: true });

  const licenseResponse = await apiRequest<any>(
    auth,
    "POST",
    `content/${asin}/licenserequest`,
    {
      body: { drm_type: "Adrm", consumption_type: "Download", quality: "High" },
    },
  );

  const contentLicense = licenseResponse.content_license || {};
  if (contentLicense.status_code === "Denied") {
    throw new CommandError(
      "not_downloadable",
      `License denied: ${JSON.stringify(contentLicense.license_denial_reasons || [])}`,
    );
  }

  const contentUrl = contentLicense.content_metadata?.content_url?.offline_url;
  if (!contentUrl) {
    throw new CommandError(
      "not_downloadable",
      "License response contained no download URL",
    );
  }

  const voucher = decryptVoucher(auth, contentLicense.asin || asin, contentLicense.license_response);

  const chapters = await apiRequest<unknown>(auth, "GET", `content/${asin}/metadata`, {
    query: { response_groups: "chapter_info,content_reference", quality: "High" },
  });

  let coverUrl: string | undefined;
  try {
    const product = await apiRequest<any>(auth, "GET", `catalog/products/${asin}`, {
      query: { response_groups: "media", image_sizes: "500" },
    });
    coverUrl = product.product?.product_images?.["500"];
  } catch {
    // A missing cover is not worth failing a download over.
  }

  const stem = title ? `${asin}_${safeFilename(title)}` : asin;
  const aaxcFile = path.join(targetDir, `${stem}.aaxc`);
  const voucherFile = path.join(targetDir, `${stem}.voucher`);
  const chaptersFile = path.join(targetDir, `${asin}-chapters.json`);
  const coverFile = path.join(targetDir, `${asin}_(500).jpg`);

  emit({ type: "log", message: `Downloading AAXC for ${asin}...` });
  await downloadTo(contentUrl, aaxcFile, emit, asin);

  fs.writeFileSync(voucherFile, JSON.stringify(voucher, null, 2));
  fs.writeFileSync(chaptersFile, JSON.stringify(chapters, null, 2));

  let coverWritten = false;
  if (coverUrl) {
    try {
      await downloadTo(coverUrl, coverFile, emit);
      coverWritten = true;
    } catch (err) {
      emit({ type: "log", message: `Cover download failed: ${(err as Error).message}` });
    }
  }

  return {
    type: "done",
    ok: true,
    files: {
      aaxc: aaxcFile,
      voucher: voucherFile,
      chapters: chaptersFile,
      cover: coverWritten ? coverFile : null,
    },
  };
}
