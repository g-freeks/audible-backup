import { createColumnHelper, type SortFn } from "@tanstack/react-table";
import type { Book, BookStatus } from "../types.ts";
import { features } from "./features.ts";

const helper = createColumnHelper<typeof features, Book>();

export function formatRuntime(minutes: number | null): string {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.endsWith("Z") || iso.includes("T") ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export function seriesLabel(book: Book): string {
  if (!book.series_title) return "";
  return book.series_sequence ? `${book.series_title} #${book.series_sequence}` : book.series_title;
}

/** Same fixed order as the old app.js statusOrder map — not alphabetical. */
const STATUS_ORDER: Record<BookStatus, number> = {
  "not-downloaded": 0,
  "not-downloadable": 1,
  convertible: 2,
  downloaded: 3,
  converted: 4,
  ignored: 5,
};

const sortByStatusOrder: SortFn<typeof features, Book> = (a, b) => {
  return STATUS_ORDER[a.getValue<BookStatus>("status")] - STATUS_ORDER[b.getValue<BookStatus>("status")];
};

/** Column metadata beyond what ColumnDef covers — the label shown in the
 * Columns menu and whether a column can be hidden at all (Title, the
 * checkbox column and Actions always stay put, same as the old UI). */
declare module "@tanstack/react-table" {
  interface ColumnMeta {
    label?: string;
  }
}

export const columns = [
  helper.display({
    id: "select",
    size: 32,
    enableHiding: false,
    header: ({ table }) => (
      <input
        type="checkbox"
        id="select-all"
        aria-label="Select all visible books"
        checked={table.getIsAllRowsSelected()}
        ref={(el) => {
          if (el) el.indeterminate = table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected();
        }}
        onChange={table.getToggleAllRowsSelectedHandler()}
      />
    ),
  }),
  helper.accessor("title", {
    id: "title",
    header: "Title",
    sortingFn: "alphanumeric",
    filterFn: "includesString",
    enableHiding: false,
    meta: { label: "Title" },
  }),
  helper.accessor((row) => seriesLabel(row), {
    id: "series",
    header: "Series",
    sortingFn: "alphanumeric",
    filterFn: "includesString",
    meta: { label: "Series" },
  }),
  helper.accessor("author", {
    id: "author",
    header: "Author",
    sortingFn: "alphanumeric",
    filterFn: "includesString",
    meta: { label: "Author" },
  }),
  helper.accessor("narrators", {
    id: "narrator",
    header: "Narrator",
    sortingFn: "alphanumeric",
    filterFn: "includesString",
    meta: { label: "Narrator" },
  }),
  helper.accessor("asin", {
    id: "asin",
    header: "ASIN",
    sortingFn: "alphanumeric",
    filterFn: "includesString",
    meta: { label: "ASIN" },
  }),
  helper.accessor("status", {
    id: "status",
    header: "Status",
    sortingFn: sortByStatusOrder,
    filterFn: "arrHas",
    meta: { label: "Status" },
  }),
  helper.accessor("downloaded_at", {
    id: "downloaded",
    header: "Downloaded",
    sortingFn: "alphanumeric",
    filterFn: "inDateRange",
    meta: { label: "Downloaded" },
  }),
  helper.accessor("added_to_library_at", {
    id: "purchased",
    header: "Purchased",
    sortingFn: "alphanumeric",
    filterFn: "inDateRange",
    meta: { label: "Purchased" },
  }),
  helper.accessor("released_at", {
    id: "released",
    header: "Released",
    sortingFn: "alphanumeric",
    filterFn: "inDateRange",
    meta: { label: "Released" },
  }),
  helper.accessor("runtime_minutes", {
    id: "runtime",
    header: "Runtime",
    sortingFn: "basic",
    filterFn: "inNumberRange",
    meta: { label: "Runtime" },
  }),
  helper.accessor("format_type", {
    id: "format",
    header: "Format",
    sortingFn: "alphanumeric",
    filterFn: "arrHas",
    meta: { label: "Format" },
  }),
  helper.accessor("language", {
    id: "language",
    header: "Language",
    sortingFn: "alphanumeric",
    filterFn: "arrHas",
    meta: { label: "Language" },
  }),
  helper.accessor("chapterCount", {
    id: "chapters",
    header: "Chapters",
    sortingFn: "basic",
    filterFn: "inNumberRange",
    meta: { label: "Chapters" },
  }),
  helper.display({
    id: "actions",
    header: "Actions",
    size: 160,
    enableHiding: false,
  }),
];

/** Columns a user can hide/reorder — everything except the checkbox, Title
 * and Actions, same set as HIDEABLE_COLUMNS in the old books.ts. */
export const HIDEABLE_COLUMN_IDS = columns
  .filter((c) => c.id !== "select" && c.id !== "title" && c.id !== "actions")
  .map((c) => c.id as string);

/** Columns offering a faceted (checkbox-list) filter rather than free text. */
export const FACETED_COLUMN_IDS = new Set(["status", "format", "language"]);
export const DATE_COLUMN_IDS = new Set(["downloaded", "purchased", "released"]);
export const NUMBER_COLUMN_IDS = new Set(["runtime", "chapters"]);
