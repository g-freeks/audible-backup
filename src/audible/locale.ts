/**
 * Audible marketplaces.
 *
 * Ported from the `audible` Python package's localization module. These three
 * values per marketplace are all the sign-in and API flows need: the country
 * code names the assoc handle, the domain picks the Amazon and Audible hosts,
 * and the marketplace id is sent with the OAuth request.
 */

export interface Locale {
  countryCode: string;
  domain: string;
  marketPlaceId: string;
}

export const LOCALES: Record<string, Locale> = {
  de: { countryCode: "de", domain: "de", marketPlaceId: "AN7V1F1VY261K" },
  us: { countryCode: "us", domain: "com", marketPlaceId: "AF2M0KC94RCEA" },
  uk: { countryCode: "uk", domain: "co.uk", marketPlaceId: "A2I9A3Q2GNFNGQ" },
  fr: { countryCode: "fr", domain: "fr", marketPlaceId: "A2728XDNODOQ8T" },
  ca: { countryCode: "ca", domain: "ca", marketPlaceId: "A2CQZ5RBY40XE" },
  it: { countryCode: "it", domain: "it", marketPlaceId: "A2N7FU2W2BU2ZC" },
  au: { countryCode: "au", domain: "com.au", marketPlaceId: "AN7EY7DTAW63G" },
  in: { countryCode: "in", domain: "in", marketPlaceId: "AJO3FBRUE6J4S" },
  jp: { countryCode: "jp", domain: "co.jp", marketPlaceId: "A1QAP3MOU4173J" },
  es: { countryCode: "es", domain: "es", marketPlaceId: "ALMIKO4SZCSAR" },
  br: { countryCode: "br", domain: "com.br", marketPlaceId: "A10J1VAYUDTYRN" },
};

export const MARKETPLACES = Object.keys(LOCALES);

export function getLocale(marketplace: string): Locale {
  const locale = LOCALES[marketplace];
  if (!locale) throw new Error(`Unknown marketplace: ${marketplace}`);
  return locale;
}
