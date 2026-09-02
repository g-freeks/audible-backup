import type { AudiobookRow } from "../db.ts";

export type BookStatus =
  | "ignored"
  | "not-downloadable"
  | "not-downloaded"
  | "convertible"
  | "downloaded"
  | "converted";

/** Derives a book's one-word status from its DB row plus the two sets/maps
 * the caller already had to compute (which ASINs have files ready to
 * convert, and which ASINs have already-converted chapters on disk). Shared
 * between the books page and the JSON API so both agree on the same rules. */
export function getBookStatus(
  book: AudiobookRow,
  convertibleAsins: Set<string>,
  convertedAsins: Map<string, number>,
): BookStatus {
  if (book.ignored_at) return "ignored";
  if (book.not_downloadable_at) return "not-downloadable";
  if (!book.downloaded_at) return "not-downloaded";
  if (!convertedAsins.has(book.asin) && convertibleAsins.has(book.asin)) return "convertible";
  if (!convertedAsins.has(book.asin)) return "downloaded";
  return "converted";
}
