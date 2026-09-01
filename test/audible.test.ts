import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { getLocale, MARKETPLACES } from "../src/audible/locale.ts";
import {
  buildClientId,
  buildDeviceSerial,
  buildOAuthUrl,
  createCodeChallenge,
  createCodeVerifier,
  extractCodeFromUrl,
} from "../src/audible/login.ts";
import { signRequest, signatureDate, Authenticator } from "../src/audible/auth.ts";
import { decryptVoucher } from "../src/audible/client.ts";

/**
 * The TypeScript Audible client is a port of the `audible` Python package, and
 * the parts that matter cannot be exercised without a real account: PKCE, the
 * OAuth URL, the ADP request signature and the licence voucher either match
 * what Amazon expects exactly or fail in production.
 *
 * So they are checked against vectors produced by the package being replaced —
 * see scripts/generate-audible-vectors.py. Agreement with the implementation
 * that is known to work is the strongest evidence available offline.
 */

const vectors = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, "resources", "audible-vectors.json"),
    "utf8",
  ),
);

describe("PKCE, against the Python implementation", () => {
  it("derives the same S256 challenge", () => {
    const verifier = Buffer.from(vectors.pkce.verifier, "utf8");
    assert.equal(createCodeChallenge(verifier), vectors.pkce.challenge);
  });

  it("derives the same client id from a serial", () => {
    assert.equal(buildClientId(vectors.clientId.serial), vectors.clientId.clientId);
  });

  it("generates verifiers of the shape Amazon accepts", () => {
    const verifier = createCodeVerifier();
    // base64url of 32 bytes, unpadded — 43 characters.
    assert.match(verifier.toString("utf8"), /^[A-Za-z0-9_-]{43}$/);
  });

  it("generates serials of the shape Amazon accepts", () => {
    assert.match(buildDeviceSerial(), /^[0-9A-F]{32}$/);
  });
});

describe("OAuth sign-in URL, against the Python implementation", () => {
  for (const marketplace of Object.keys(vectors.oauthUrls)) {
    it(`matches byte for byte for ${marketplace}`, () => {
      const { url } = buildOAuthUrl(
        getLocale(marketplace),
        vectors.clientId.serial,
        Buffer.from(vectors.pkce.verifier, "utf8"),
      );
      // Query parameter order is part of the comparison: this asserts the
      // whole URL, not a set of parameters.
      assert.equal(url, vectors.oauthUrls[marketplace]);
    });
  }

  it("covers every marketplace the app offers", () => {
    for (const marketplace of MARKETPLACES) {
      const { url } = buildOAuthUrl(getLocale(marketplace), vectors.clientId.serial);
      assert.match(url, /^https:\/\/www\.amazon\./);
    }
    assert.equal(MARKETPLACES.length, 11);
  });
});

describe("the redirect URL the user pastes back", () => {
  it("extracts the authorization code", () => {
    const url =
      "https://www.amazon.de/ap/maplanding?openid.oa2.authorization_code=ABC123" +
      "&openid.mode=id_res&serial=X";
    assert.equal(extractCodeFromUrl(url), "ABC123");
  });

  it("rejects a URL that has no code, rather than proceeding", () => {
    assert.throws(
      () => extractCodeFromUrl("https://www.amazon.de/ap/maplanding?openid.mode=id_res"),
      /no authorization code/,
    );
    assert.throws(() => extractCodeFromUrl("not a url"), /not a valid URL/);
  });
});

describe("request signing, against the Python implementation", () => {
  const v = vectors.signing;

  it("signs exactly the string the Python implementation signs", () => {
    // signRequest does not expose the string it signs, so prove it indirectly:
    // sign with our own key, then verify that signature against the string
    // *Python* produced. It only verifies if the two strings are identical —
    // field order, separators and date format included.
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const headers = signRequest(
      v.method,
      v.path,
      v.body,
      v.adpToken,
      privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      v.date,
    );

    // The header is "<base64>:<date>", and the date itself contains colons —
    // base64 never does, so the first colon is the separator.
    const header = headers["x-adp-signature"];
    const separator = header.indexOf(":");
    const signature = header.slice(0, separator);
    const date = header.slice(separator + 1);
    assert.equal(date, v.date, "the header carries the date that was signed");
    assert.equal(headers["x-adp-token"], v.adpToken);

    const ok = createVerify("RSA-SHA256")
      .update(v.signedString)
      .verify(publicKey, Buffer.from(signature, "base64"));
    assert.ok(ok, "our signature must cover the same bytes Python signs");
  });

  it("verifies a signature Python produced", () => {
    // If Node's RSA-SHA256 verify accepts Python's signature, both agree on
    // the hash and the PKCS#1 v1.5 padding — the parts easiest to get wrong.
    const ok = createVerify("RSA-SHA256")
      .update(v.signedString)
      .verify(v.publicKeyPem, Buffer.from(v.signature, "base64"));
    assert.ok(ok, "Node must verify a signature made by the Python implementation");
  });

  it("rejects a signature over tampered data", () => {
    const ok = createVerify("RSA-SHA256")
      .update(v.signedString.replace("library", "libraryX"))
      .verify(v.publicKeyPem, Buffer.from(v.signature, "base64"));
    assert.equal(ok, false, "the vector must not verify against anything");
  });

  it("sends the algorithm header Audible expects", () => {
    assert.equal(v.algHeader, "SHA256withRSA:1.0");
  });

  it("reproduces Python's unusual date format", () => {
    // `datetime.now(UTC).isoformat("T") + "Z"` yields microseconds, a +00:00
    // offset *and* a trailing Z. JavaScript's toISOString() does not, and the
    // same string is both signed and sent — so the oddity has to be copied.
    const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00Z$/;
    assert.match(vectors.dateFormatExample, shape, "the vector itself");
    assert.match(signatureDate(), shape, "our own output");

    const fixed = new Date("2026-01-02T03:04:05.678Z");
    assert.equal(signatureDate(fixed), "2026-01-02T03:04:05.678000+00:00Z");
  });
});

describe("licence voucher, against the Python implementation", () => {
  const v = vectors.voucher;
  const auth = new Authenticator(
    {
      adp_token: "x",
      device_private_key: "x",
      access_token: "x",
      refresh_token: "x",
      expires: 0,
      website_cookies: null,
      store_authentication_cookie: null,
      device_info: { device_serial_number: v.deviceSerial, device_type: v.deviceType },
      customer_info: { user_id: v.customerId },
      locale_code: "de",
    },
    "/nonexistent",
  );

  it("decrypts a voucher the Python implementation encrypted", () => {
    const decrypted = decryptVoucher(auth, v.asin, v.encrypted);
    assert.equal(decrypted.key, v.decrypted.key);
    assert.equal(decrypted.iv, v.decrypted.iv);
  });

  it("derives the key from all four inputs", () => {
    // Each one is part of the SHA-256 material; getting any wrong yields a
    // different key, and the decryption becomes garbage rather than silently
    // producing a usable-looking result.
    for (const wrong of [
      { ...v, asin: "B0DIFFERENT" },
      { ...v, customerId: "amzn1.account.SOMEONEELSE" },
      { ...v, deviceSerial: "0000000000000000000000000000ABCD" },
      { ...v, deviceType: "A0000000000000" },
    ]) {
      const other = new Authenticator(
        {
          ...auth.data,
          device_info: {
            device_serial_number: wrong.deviceSerial,
            device_type: wrong.deviceType,
          },
          customer_info: { user_id: wrong.customerId },
        },
        "/nonexistent",
      );
      assert.throws(
        () => decryptVoucher(other, wrong.asin, v.encrypted),
        /Failed to parse the licence voucher/,
      );
    }
  });
});
