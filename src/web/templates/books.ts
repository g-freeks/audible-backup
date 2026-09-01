import { layout, type UserNav } from "./layout.ts";
import { getAllBooks, type AudiobookRow } from "../../db.ts";
import { escapeHtml } from "./html.ts";
import { statusBadge } from "./components.ts";

function formatRuntime(minutes: number | null): string {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  // downloaded_at is SQLite's bare datetime('now') — "YYYY-MM-DD HH:MM:SS",
  // with no timezone, so it needs "Z" appended to parse as UTC (same as the
  // existing Downloaded column). Audible's own dates (release_date,
  // purchase_date) are already a plain ISO date or a full ISO timestamp
  // with their own "Z", so appending one more is harmless/ignored there.
  return new Date(iso.endsWith("Z") ? iso : `${iso}Z`).toLocaleDateString();
}

function getStatus(book: AudiobookRow, convertibleAsins: Set<string>, convertedAsins: Map<string, number>): string {
  if (book.ignored_at) return "ignored";
  if (book.not_downloadable_at) return "not-downloadable";
  if (!book.downloaded_at) return "not-downloaded";
  if (!convertedAsins.has(book.asin) && convertibleAsins.has(book.asin)) return "convertible";
  if (!convertedAsins.has(book.asin)) return "downloaded";
  return "converted";
}

/**
 * One primary action per row: download the MP3s. It fetches from Audible and
 * converts as needed, then the browser starts the ZIP download by itself.
 * Books already converted skip straight to the download link.
 */
function getMp3sButton(asin: string, converted: boolean): string {
  if (converted) {
    return `<a class="btn btn-sm btn-primary split-main" href="/download/converted/${asin}" title="Download the chapter MP3s as a ZIP">Download</a>`;
  }
  return `<button class="btn btn-sm btn-primary split-main" hx-post="/prepare/${asin}" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" title="Fetch from Audible if needed, convert, then download the MP3s">Download</button>`;
}

function downloadAaxItem(asin: string): string {
  return `<a class="dropdown-item" href="/download/aax/${asin}" title="Download the original, still encrypted Audible file">Save original AAX</a>`;
}

function reconvertItem(asin: string): string {
  return `<button class="dropdown-item" hx-post="/convert/${asin}" hx-target="#progress-panel" hx-swap="innerHTML" hx-vals='{"force":"true"}'>Convert again</button>`;
}

function redownloadItem(asin: string): string {
  return `<button class="dropdown-item" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-vals='{"asin":"${asin}","force":"true"}'>Fetch again from Audible</button>`;
}

function ignoreItem(asin: string): string {
  return `<button class="dropdown-item" data-action-url="/api/ignore/${asin}">Ignore</button>`;
}

function deleteItem(asin: string): string {
  return `<button class="dropdown-item danger" data-action-url="/api/delete/${asin}" data-confirm="Delete files for this book?">Delete</button>`;
}

/** Material's "refresh" glyph — used instead of a text label on Sync Library.
 * While a sync is running it spins in place; hovering it then swaps to
 * ICON_CANCEL (below) so the button reads as "cancel" without ever needing
 * to give up its icon for the word "Cancel" the way text buttons do. */
const REFRESH_ICON = `<svg class="icon-refresh" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 01-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>`;

/** Material's "close" glyph — the hover-to-cancel state for icon buttons. */
const CANCEL_ICON = `<svg class="icon-cancel" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;

/** Columns a user can hide; Title, Actions and the checkbox column always stay put. */
const HIDEABLE_COLUMNS: { key: string; label: string }[] = [
  { key: "series", label: "Series" },
  { key: "author", label: "Author" },
  { key: "narrator", label: "Narrator" },
  { key: "asin", label: "ASIN" },
  { key: "status", label: "Status" },
  { key: "downloaded", label: "Downloaded" },
  { key: "purchased", label: "Purchased" },
  { key: "released", label: "Released" },
  { key: "runtime", label: "Runtime" },
  { key: "format", label: "Format" },
  { key: "language", label: "Language" },
  { key: "chapters", label: "Chapters" },
];

function columnsMenu(): string {
  const items = HIDEABLE_COLUMNS.map(
    (c) => `<label class="dropdown-item checkbox-item"><input type="checkbox" data-col-toggle="${c.key}" checked> ${c.label}</label>`,
  ).join("");
  return `<div class="action-dropdown">
    <button class="btn btn-sm btn-ghost" type="button" data-dropdown-toggle aria-haspopup="true" aria-expanded="false" title="Show or hide table columns">Columns &#9662;</button>
    <div class="dropdown-menu">${items}</div>
  </div>`;
}

function actionButtons(book: AudiobookRow, status: string): string {
  const asin = book.asin;
  let primary = "";
  const items: string[] = [];

  switch (status) {
    case "not-downloadable":
      primary = `<button class="btn btn-sm btn-primary split-main" hx-post="/prepare/${asin}" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" title="Try again: fetch from Audible, convert, then download">Retry</button>`;
      items.push(ignoreItem(asin));
      break;
    case "not-downloaded":
      primary = getMp3sButton(asin, false);
      items.push(ignoreItem(asin));
      break;
    case "downloaded":
      primary = getMp3sButton(asin, false);
      items.push(downloadAaxItem(asin));
      items.push(redownloadItem(asin));
      items.push(ignoreItem(asin));
      items.push(deleteItem(asin));
      break;
    case "convertible":
      primary = getMp3sButton(asin, false);
      items.push(downloadAaxItem(asin));
      items.push(redownloadItem(asin));
      items.push(ignoreItem(asin));
      items.push(deleteItem(asin));
      break;
    case "converted":
      primary = getMp3sButton(asin, true);
      items.push(reconvertItem(asin));
      items.push(downloadAaxItem(asin));
      items.push(redownloadItem(asin));
      items.push(ignoreItem(asin));
      items.push(deleteItem(asin));
      break;
    case "ignored":
      primary = `<button class="btn btn-sm btn-primary split-main" data-action-url="/api/unignore/${asin}" title="Remove from ignored list">Unignore</button>`;
      items.push(deleteItem(asin));
      break;
  }

  if (!primary) return "";
  if (items.length === 0) return primary;

  return `<div class="action-dropdown"><div class="split-btn">${primary}<button class="btn btn-sm btn-primary split-caret" type="button" data-dropdown-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions">&#9662;</button></div><div class="dropdown-menu">${items.join("")}</div></div>`;
}

export interface BooksPageOptions {
  /** Fire the sync request as soon as the page loads (right after connecting
   * an Audible account), on top of its normal click trigger. */
  autoSync?: boolean;
  /** Whether an operation is already running for this user, so the topbar's
   * log indicator can render as active from the very first paint. */
  operationRunning?: boolean;
  /** This account's saved column visibility/order, if any — seeds the
   * client's cache on load so it's correct even if browser storage was
   * just wiped (e.g. the desktop app's port changes every launch). */
  columnPrefs?: { hidden: string[]; order: string[] };
}

export function booksPage(
  convertibleAsins: Set<string>,
  convertedAsins: Map<string, number>,
  userNav?: UserNav,
  opts: BooksPageOptions = {},
): string {
  const books = getAllBooks();
  const savedHidden = (opts.columnPrefs?.hidden || []).join(",");
  const savedOrder = (opts.columnPrefs?.order || []).join(",");

  const topbarExtra = `
    <div id="column-prefs-data" hidden data-hidden="${escapeHtml(savedHidden)}" data-order="${escapeHtml(savedOrder)}"></div>
    <button id="sync-library-btn" class="btn btn-sm btn-icon btn-ghost" hx-post="/library/sync" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this"${opts.autoSync ? ' hx-trigger="click, load"' : ""} aria-label="Sync Library" title="Fetch latest library listing from Audible">
      ${REFRESH_ICON}${CANCEL_ICON}
    </button>
    <div class="search-wrap">
      <input type="text" id="search-input" placeholder="Search by title, author, or ASIN..." autocomplete="off">
      <button type="button" id="search-clear" class="search-clear" aria-label="Clear search" hidden>&times;</button>
    </div>
    <button id="download-selected-btn" class="btn btn-sm btn-primary" hx-post="/library/download-all" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-include="[name='asin']:checked" disabled title="Fetch checked books from Audible and convert them, same as the row Download button">
      Download Selected
      <span class="htmx-indicator"><span class="spinner"></span></span>
    </button>
    <button id="download-all-btn" class="btn btn-sm btn-primary" hx-post="/library/download-all" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-confirm="Download every remaining book from Audible and convert everything that's ready? This may take a while." title="Fetch every not-yet-downloaded book, then convert everything ready for conversion">
      Download All
      <span class="htmx-indicator"><span class="spinner"></span></span>
    </button>
    ${columnsMenu()}
  `;

  const content = `
    <!-- Refresher lives OUTSIDE .library-layout on purpose: hx-select is an
         inherited attribute, so placing it on the container would apply it to
         every action button's response and swap in nothing. -->
    <div hx-get="/" hx-select=".library-layout" hx-target=".library-layout" hx-swap="outerHTML" hx-trigger="refresh-books from:body"></div>
    <div class="library-layout">
      ${books.length > 0 ? `
      <div class="table-scroll">
        <table id="books-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="select-all" aria-label="Select all visible books"></th>
              <th class="sortable col-title" data-col="title" draggable="true" data-sort-type="string">Title</th>
              <th class="sortable col-author" data-col="series" draggable="true" data-sort-type="string">Series</th>
              <th class="sortable col-author" data-col="author" draggable="true" data-sort-type="string">Author</th>
              <th class="sortable col-author" data-col="narrator" draggable="true" data-sort-type="string">Narrator</th>
              <th class="sortable" data-col="asin" draggable="true" data-sort-type="string">ASIN</th>
              <th class="sortable" data-col="status" draggable="true" data-sort-type="status">Status</th>
              <th class="sortable" data-col="downloaded" draggable="true" data-sort-type="string">Downloaded</th>
              <th class="sortable" data-col="purchased" draggable="true" data-sort-type="string">Purchased</th>
              <th class="sortable" data-col="released" draggable="true" data-sort-type="string">Released</th>
              <th class="sortable" data-col="runtime" draggable="true" data-sort-type="number">Runtime</th>
              <th class="sortable" data-col="format" draggable="true" data-sort-type="string">Format</th>
              <th class="sortable" data-col="language" draggable="true" data-sort-type="string">Language</th>
              <th class="sortable" data-col="chapters" draggable="true" data-sort-type="number">Chapters</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${books.map((book) => {
              const status = getStatus(book, convertibleAsins, convertedAsins);
              const title = escapeHtml(book.title || book.asin);
              const author = escapeHtml(book.author || "");
              const narrators = escapeHtml(book.narrators || "");
              const series = escapeHtml(
                book.series_title ? `${book.series_title}${book.series_sequence ? ` #${book.series_sequence}` : ""}` : "",
              );
              const format = escapeHtml(book.format_type || "");
              const language = escapeHtml(book.language || "");
              const date = formatDate(book.downloaded_at);
              const dateSortVal = book.downloaded_at || "";
              const purchased = formatDate(book.added_to_library_at);
              const released = formatDate(book.released_at);
              const runtime = formatRuntime(book.runtime_minutes);
              const chapters = convertedAsins.get(book.asin) ?? "";
              const searchData = `${title} ${author} ${narrators} ${series} ${book.asin}`.toLowerCase();
              return `<tr data-search="${escapeHtml(searchData)}">
                <td><input type="checkbox" name="asin" value="${book.asin}" aria-label="Select ${title}"></td>
                <td class="col-title" data-col="title" data-sort-val="${escapeHtml(title.toLowerCase())}" title="${title}">${title}</td>
                <td class="col-author" data-col="series" data-sort-val="${escapeHtml((book.series_title || "").toLowerCase())}" title="${series}">${series}</td>
                <td class="col-author" data-col="author" data-sort-val="${escapeHtml(author.toLowerCase())}" title="${author}">${author}</td>
                <td class="col-author" data-col="narrator" data-sort-val="${escapeHtml(narrators.toLowerCase())}" title="${narrators}">${narrators}</td>
                <td data-col="asin" data-sort-val="${book.asin}"><code>${book.asin}</code></td>
                <td data-col="status" data-sort-val="${status}"><span id="status-${book.asin}">${statusBadge(status)}</span></td>
                <td data-col="downloaded" data-sort-val="${dateSortVal}">${date}</td>
                <td data-col="purchased" data-sort-val="${book.added_to_library_at || ""}">${purchased}</td>
                <td data-col="released" data-sort-val="${book.released_at || ""}">${released}</td>
                <td data-col="runtime" data-sort-val="${book.runtime_minutes ?? ""}">${runtime}</td>
                <td data-col="format" data-sort-val="${format}">${format}</td>
                <td data-col="language" data-sort-val="${language}">${language}</td>
                <td data-col="chapters" data-sort-val="${chapters}">${chapters}</td>
                <td>${actionButtons(book, status)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>` : '<div class="empty">No books in database. Sync your library to get started.</div>'}

    </div>

  `;

  return layout("Books", content, userNav, topbarExtra, opts.operationRunning ?? false);
}
