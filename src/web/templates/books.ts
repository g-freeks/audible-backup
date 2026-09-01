import { layout, type UserNav } from "./layout.ts";
import { getAllBooks, type AudiobookRow } from "../../db.ts";
import { escapeHtml } from "./html.ts";
import { statusBadge } from "./components.ts";

function getStatus(book: AudiobookRow, convertibleAsins: Set<string>, convertedAsins: Map<string, number>): string {
  if (book.ignored_at) return "ignored";
  if (book.not_downloadable_at) return "not-downloadable";
  if (!book.downloaded_at) return "not-downloaded";
  if (!convertedAsins.has(book.asin) && convertibleAsins.has(book.asin)) return "convertible";
  if (!convertedAsins.has(book.asin)) return "downloaded";
  return "converted";
}

/**
 * One primary action per row: get the MP3s. It fetches from Audible and
 * converts as needed, then the browser starts the ZIP download by itself.
 * Books already converted skip straight to the download link.
 */
function getMp3sButton(asin: string, converted: boolean): string {
  if (converted) {
    return `<a class="btn btn-sm btn-primary split-main" href="/download/converted/${asin}" title="Download the chapter MP3s as a ZIP">Get MP3s</a>`;
  }
  return `<button class="btn btn-sm btn-primary split-main" hx-post="/prepare/${asin}" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" title="Fetch from Audible if needed, convert, then download the MP3s">Get MP3s</button>`;
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

export function booksPage(convertibleAsins: Set<string>, convertedAsins: Map<string, number>, userNav?: UserNav): string {
  const books = getAllBooks();
  const hasNotDownloaded = books.some((b) => !b.downloaded_at && !b.ignored_at && !b.not_downloadable_at);

  const content = `
    <!-- Refresher lives OUTSIDE .library-layout on purpose: hx-select is an
         inherited attribute, so placing it on the container would apply it to
         every action button's response and swap in nothing. -->
    <div hx-get="/" hx-select=".library-layout" hx-target=".library-layout" hx-swap="outerHTML" hx-trigger="refresh-books from:body"></div>
    <div class="library-layout">
      <div class="actions">
        <button class="btn btn-primary" hx-post="/library/sync" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" title="Fetch latest library listing from Audible">
          Sync Library
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>
        ${hasNotDownloaded ? `
        <button class="btn btn-primary" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-include="[name='asin']:checked" title="Fetch checked books from Audible to the server">
          Fetch Selected
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>
        <button class="btn" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" style="background:var(--surface);border:1px solid var(--border);color:var(--text)" title="Fetch every not-yet-fetched book from Audible to the server">
          Fetch All
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>` : ""}
        <button class="btn" hx-post="/convert/all" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" style="background:var(--surface);border:1px solid var(--border);color:var(--text)" title="Convert all ready AAX files to chapter-split MP3s">
          Convert All
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>
      </div>

      <div class="filter-bar">
        <div class="search-wrap">
          <input type="text" id="search-input" placeholder="Search by title, author, or ASIN..." autocomplete="off">
          <button type="button" id="search-clear" class="search-clear" aria-label="Clear search" hidden>&times;</button>
        </div>
      </div>

      ${books.length > 0 ? `
      <div class="table-scroll">
        <table id="books-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="select-all" aria-label="Select all visible books"></th>
              <th class="sortable" data-sort-col="1" data-sort-type="string">Title</th>
              <th class="sortable col-author" data-sort-col="2" data-sort-type="string">Author</th>
              <th class="sortable" data-sort-col="3" data-sort-type="string">ASIN</th>
              <th class="sortable" data-sort-col="4" data-sort-type="status">Status</th>
              <th class="sortable" data-sort-col="5" data-sort-type="string">Downloaded</th>
              <th class="sortable" data-sort-col="6" data-sort-type="number">Chapters</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${books.map((book) => {
              const status = getStatus(book, convertibleAsins, convertedAsins);
              const title = escapeHtml(book.title || book.asin);
              const author = escapeHtml(book.author || "");
              const date = book.downloaded_at ? new Date(book.downloaded_at + "Z").toLocaleDateString() : "";
              const dateSortVal = book.downloaded_at || "";
              const chapters = convertedAsins.get(book.asin) ?? "";
              const searchData = `${title} ${author} ${book.asin}`.toLowerCase();
              return `<tr data-search="${escapeHtml(searchData)}">
                <td><input type="checkbox" name="asin" value="${book.asin}" aria-label="Select ${title}"></td>
                <td data-sort-val="${escapeHtml(title.toLowerCase())}">${title}</td>
                <td class="col-author" data-sort-val="${escapeHtml(author.toLowerCase())}" title="${author}">${author}</td>
                <td data-sort-val="${book.asin}"><code>${book.asin}</code></td>
                <td data-sort-val="${status}"><span id="status-${book.asin}">${statusBadge(status)}</span></td>
                <td data-sort-val="${dateSortVal}">${date}</td>
                <td data-sort-val="${chapters}">${chapters}</td>
                <td>${actionButtons(book, status)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>` : '<div class="empty">No books in database. Sync your library to get started.</div>'}

    </div>

  `;

  return layout("Books", content, userNav);
}
