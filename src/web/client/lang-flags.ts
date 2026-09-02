/**
 * Audible reports a book's language as a lowercase English name (e.g.
 * "english", "german"), not a marketplace or dialect — so this is a
 * best-effort single representative flag per language, not a precise
 * country mapping. Languages with no entry here fall back to their plain
 * text rather than guessing.
 */
const LANGUAGE_FLAGS: Record<string, string> = {
  english: "🇬🇧",
  german: "🇩🇪",
  french: "🇫🇷",
  spanish: "🇪🇸",
  italian: "🇮🇹",
  portuguese: "🇵🇹",
  dutch: "🇳🇱",
  japanese: "🇯🇵",
  chinese: "🇨🇳",
  korean: "🇰🇷",
  russian: "🇷🇺",
  hindi: "🇮🇳",
  tamil: "🇮🇳",
  polish: "🇵🇱",
  danish: "🇩🇰",
  swedish: "🇸🇪",
  norwegian: "🇳🇴",
  finnish: "🇫🇮",
  czech: "🇨🇿",
  greek: "🇬🇷",
  turkish: "🇹🇷",
  arabic: "🇸🇦",
  hebrew: "🇮🇱",
};

export function languageFlag(language: string | null): string | null {
  if (!language) return null;
  return LANGUAGE_FLAGS[language.toLowerCase().trim()] ?? null;
}
