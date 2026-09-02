// Mirrors server-side types (src/db.ts, src/converter.ts, src/users.ts)
// without importing them — those modules pull in node:fs/child_process and
// have no business in a browser bundle. Duplication here is small and worth
// the isolation.

export interface Book {
  asin: string;
  author: string | null;
  title: string | null;
  downloaded_at: string | null;
  ignored_at: string | null;
  not_downloadable_at: string | null;
  released_at: string | null;
  added_to_library_at: string | null;
  runtime_minutes: number | null;
  narrators: string | null;
  format_type: string | null;
  language: string | null;
  series_title: string | null;
  series_sequence: string | null;
  status: BookStatus;
  chapterCount: number | null;
}

export type BookStatus =
  | "ignored"
  | "not-downloadable"
  | "not-downloaded"
  | "convertible"
  | "downloaded"
  | "converted";

export interface LibraryStatus {
  total: number;
  downloaded: number;
  converted: number;
  pending: number;
}

export interface UserListEntry {
  name: string;
  hasPassword: boolean;
}

export interface SessionState {
  desktop: boolean;
  current: string | null;
  others: UserListEntry[];
  legacy?: boolean;
}

export type AudioFormat = "mp3" | "flac" | "aac";
export type AudioQuality = "low" | "medium" | "high";

export interface AudioSettings {
  format: AudioFormat;
  quality: AudioQuality;
  customArgs?: string;
}

export type FormatSegmentType = "tag" | "text";

export interface FormatSegment {
  type: FormatSegmentType;
  value: string;
}

export type FormatRow = FormatSegment[];

export interface OutputFormat {
  directory: FormatRow[];
  filename: FormatRow;
}

export interface TagDef {
  key: string;
  label: string;
}

export interface AudibleStatus {
  available: boolean;
  linked: boolean;
  marketplace?: string;
  pending?: { url: string; marketplace: string };
}

export interface SettingsState {
  userName: string;
  activationBytes: string;
  hasPassword: boolean;
  audible: AudibleStatus;
  desktop: boolean;
  audioSettings: AudioSettings;
  outputFormat: OutputFormat;
  version: string;
}

export interface OperationStatus {
  running: boolean;
  type?: string;
}

export interface OperationStartResult {
  type: string;
  queued: string[];
}

export interface ApiError {
  error: string;
}

export const AUDIO_FORMATS: AudioFormat[] = ["mp3", "flac", "aac"];
export const AUDIO_QUALITIES: AudioQuality[] = ["low", "medium", "high"];

/** Available in both the directory and filename templates. */
export const BOOK_TAGS: TagDef[] = [
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "series", label: "Series" },
  { key: "seriesEntry", label: "Series Entry #" },
  { key: "narrator", label: "Narrator" },
  { key: "language", label: "Language" },
  { key: "asin", label: "ASIN" },
  { key: "year", label: "Year" },
];

/** Only meaningful per-chapter, so only offered in the filename template. */
export const CHAPTER_TAGS: TagDef[] = [
  { key: "chapterNumber", label: "Chapter #" },
  { key: "chapterName", label: "Chapter Name" },
];

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = {
  directory: [[{ type: "tag", value: "title" }]],
  filename: [
    { type: "tag", value: "chapterNumber" },
    { type: "text", value: " - " },
    { type: "tag", value: "chapterName" },
  ],
};

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = { format: "mp3", quality: "medium" };

interface AudioPreset {
  args: string[];
  estimate: string;
}

/** Mirrors src/converter.ts's AUDIO_PRESETS exactly — the ffmpeg args shown/
 * edited in Settings are cosmetic (the server is the source of truth for
 * what actually runs), so a client-side copy of this static catalog is
 * fine, the same way BOOK_TAGS/CHAPTER_TAGS above are. */
export const AUDIO_PRESETS: Record<AudioFormat, Record<AudioQuality, AudioPreset>> = {
  mp3: {
    low: { args: ["-c:a", "libmp3lame", "-b:a", "64k"], estimate: "~28 MB per hour of runtime" },
    medium: { args: ["-c:a", "libmp3lame", "-b:a", "128k"], estimate: "~58 MB per hour of runtime" },
    high: { args: ["-c:a", "libmp3lame", "-b:a", "256k"], estimate: "~115 MB per hour of runtime" },
  },
  aac: {
    low: { args: ["-c:a", "aac", "-b:a", "48k"], estimate: "~22 MB per hour of runtime" },
    medium: { args: ["-c:a", "aac", "-b:a", "96k"], estimate: "~43 MB per hour of runtime" },
    high: { args: ["-c:a", "aac", "-b:a", "192k"], estimate: "~86 MB per hour of runtime" },
  },
  flac: {
    low: {
      args: ["-c:a", "flac", "-compression_level", "1"],
      estimate: "~350–400 MB per hour (lossless — size depends on the source; this only trades encode speed)",
    },
    medium: {
      args: ["-c:a", "flac", "-compression_level", "5"],
      estimate: "~350–400 MB per hour (lossless — size depends on the source; this only trades encode speed)",
    },
    high: {
      args: ["-c:a", "flac", "-compression_level", "8"],
      estimate: "~350–400 MB per hour (lossless — slowest, marginally smallest)",
    },
  },
};

/** What the settings UI shows (and lets the user hand-edit) for these
 * settings — the custom string verbatim, or the preset rendered as text. */
export function audioArgsString(settings: AudioSettings): string {
  if (settings.customArgs?.trim()) return settings.customArgs.trim();
  return AUDIO_PRESETS[settings.format][settings.quality].args.join(" ");
}
