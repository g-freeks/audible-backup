import { layout } from "./layout.ts";
import { getAllBooks, type AudiobookRow } from "../../db.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getStatus(book: AudiobookRow, convertibleAsins: Set<string>): string {
  if (book.ignored_at) return "ignored";
  if (!book.downloaded_at) return "not-downloaded";
  if (!book.converted_at && convertibleAsins.has(book.asin)) return "convertible";
  if (!book.converted_at) return "downloaded";
  return "converted";
}

function statusBadge(status: string): string {
  switch (status) {
    case "ignored": return '<span class="badge badge-danger">Ignored</span>';
    case "not-downloaded": return '<span class="badge badge-muted">Not Downloaded</span>';
    case "convertible": return '<span class="badge badge-warn">Ready</span>';
    case "downloaded": return '<span class="badge badge-warn">Downloaded</span>';
    case "converted": return '<span class="badge badge-success">Converted</span>';
    default: return "";
  }
}

function actionButtons(book: AudiobookRow, status: string): string {
  const buttons: string[] = [];

  switch (status) {
    case "ignored":
      buttons.push(`<form method="post" action="/api/unignore/${book.asin}" style="display:inline"><button class="btn btn-sm btn-ghost" type="submit" title="Remove from ignored list">Unignore</button></form>`);
      break;
    case "not-downloaded":
      buttons.push(`<button class="btn btn-sm btn-primary" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-vals='{"asin":"${book.asin}"}' title="Download this audiobook from Audible">Download</button>`);
      buttons.push(`<form method="post" action="/api/ignore/${book.asin}" style="display:inline"><button class="btn btn-sm btn-ghost" type="submit" title="Hide this book from the library">Ignore</button></form>`);
      break;
    case "convertible":
      buttons.push(`<button class="btn btn-sm btn-primary" hx-post="/convert/${book.asin}" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" title="Convert AAX to chapter-split MP3s">Convert</button>`);
      buttons.push(`<form method="post" action="/api/delete/${book.asin}" style="display:inline" onsubmit="return confirm('Delete files for this book?')"><button class="btn btn-sm btn-danger" type="submit" title="Delete downloaded AAX and related files">Delete</button></form>`);
      break;
    case "downloaded":
      buttons.push(`<form method="post" action="/api/delete/${book.asin}" style="display:inline" onsubmit="return confirm('Delete files for this book?')"><button class="btn btn-sm btn-danger" type="submit" title="Delete downloaded AAX and related files">Delete</button></form>`);
      break;
    case "converted":
      buttons.push(`<form method="post" action="/api/delete/${book.asin}" style="display:inline" onsubmit="return confirm('Delete all files for this book?')"><button class="btn btn-sm btn-danger" type="submit" title="Delete all downloaded and converted files">Delete</button></form>`);
      break;
  }

  return buttons.join(" ");
}

export function booksPage(convertibleAsins: Set<string>): string {
  const books = getAllBooks();
  const hasNotDownloaded = books.some((b) => !b.downloaded_at && !b.ignored_at);

  const content = `
    <div class="library-layout">
      <h1>Books</h1>

      <div class="actions">
        <button class="btn btn-primary" hx-post="/library/sync" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" title="Fetch latest library listing from Audible">
          Sync Library
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>
        ${hasNotDownloaded ? `
        <button class="btn btn-primary" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-include="[name='asin']:checked" title="Download checked books from Audible">
          Download Selected
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>
        <button class="btn" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" style="background:var(--surface);border:1px solid var(--border);color:var(--text)" title="Download all not-yet-downloaded books">
          Download All
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>` : ""}
        <button class="btn" hx-post="/convert/all" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" style="background:var(--surface);border:1px solid var(--border);color:var(--text)" title="Convert all ready AAX files to chapter-split MP3s">
          Convert All
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>
      </div>

      <div class="filter-bar">
        <input type="text" id="search-input" placeholder="Search by title, author, or ASIN..." autocomplete="off">
        <div class="filter-pills">
          <button class="filter-btn active" data-filter="all">All (${books.length})</button>
          <button class="filter-btn" data-filter="not-downloaded">Not Downloaded (${books.filter((b) => !b.downloaded_at && !b.ignored_at).length})</button>
          <button class="filter-btn" data-filter="downloaded">Downloaded (${books.filter((b) => b.downloaded_at && !b.converted_at && !b.ignored_at && !convertibleAsins.has(b.asin)).length})</button>
          <button class="filter-btn" data-filter="convertible">Convertible (${books.filter((b) => b.downloaded_at && !b.converted_at && !b.ignored_at && convertibleAsins.has(b.asin)).length})</button>
          <button class="filter-btn" data-filter="converted">Converted (${books.filter((b) => b.converted_at && !b.ignored_at).length})</button>
          <button class="filter-btn" data-filter="ignored">Ignored (${books.filter((b) => b.ignored_at).length})</button>
        </div>
      </div>

      ${books.length > 0 ? `
      <div class="table-scroll">
        <table id="books-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="select-all"></th>
              <th class="sortable" data-sort-col="1" data-sort-type="string">Title</th>
              <th class="sortable" data-sort-col="2" data-sort-type="string">Author</th>
              <th class="sortable" data-sort-col="3" data-sort-type="string">ASIN</th>
              <th class="sortable" data-sort-col="4" data-sort-type="status">Status</th>
              <th class="sortable" data-sort-col="5" data-sort-type="string">Downloaded</th>
              <th class="sortable" data-sort-col="6" data-sort-type="number">Chapters</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${books.map((book) => {
              const status = getStatus(book, convertibleAsins);
              const title = escapeHtml(book.title || book.asin);
              const author = escapeHtml(book.author || "");
              const date = book.downloaded_at ? new Date(book.downloaded_at + "Z").toLocaleDateString() : "";
              const dateSortVal = book.downloaded_at || "";
              const chapters = book.chapter_count ?? "";
              const searchData = `${title} ${author} ${book.asin}`.toLowerCase();
              return `<tr data-status="${status}" data-search="${escapeHtml(searchData)}">
                <td><input type="checkbox" name="asin" value="${book.asin}"></td>
                <td data-sort-val="${escapeHtml(title.toLowerCase())}">${title}</td>
                <td data-sort-val="${escapeHtml(author.toLowerCase())}">${author}</td>
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

    <script>
      // Search filtering
      const searchInput = document.getElementById('search-input');
      const tbody = document.querySelector('#books-table tbody');
      let activeFilter = 'all';

      function getRows() {
        return Array.from(document.querySelectorAll('#books-table tbody tr[data-status]'));
      }

      function applyFilters() {
        const query = searchInput.value.toLowerCase();
        getRows().forEach(row => {
          const matchesSearch = !query || row.dataset.search.includes(query);
          const matchesFilter = activeFilter === 'all' || row.dataset.status === activeFilter;
          row.style.display = (matchesSearch && matchesFilter) ? '' : 'none';
        });
      }

      searchInput?.addEventListener('input', applyFilters);

      // Filter pills
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeFilter = btn.dataset.filter;
          applyFilters();
        });
      });

      // Select-all checkbox (only affects visible rows)
      document.getElementById('select-all')?.addEventListener('change', (e) => {
        getRows().forEach(row => {
          if (row.style.display !== 'none') {
            const cb = row.querySelector('input[name="asin"]');
            if (cb) cb.checked = e.target.checked;
          }
        });
      });

      // Column sorting
      const statusOrder = { 'not-downloaded': 0, 'convertible': 1, 'downloaded': 2, 'converted': 3, 'ignored': 4 };
      let sortCol = null;
      let sortDir = 'asc';

      document.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
          const col = parseInt(th.dataset.sortCol);
          const type = th.dataset.sortType;

          if (sortCol === col) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            sortCol = col;
            sortDir = 'asc';
          }

          document.querySelectorAll('th.sortable').forEach(h => h.classList.remove('asc', 'desc'));
          th.classList.add(sortDir);

          const rows = getRows();
          rows.sort((a, b) => {
            const aVal = a.children[col]?.dataset.sortVal || '';
            const bVal = b.children[col]?.dataset.sortVal || '';
            let cmp = 0;
            if (type === 'number') {
              cmp = (parseFloat(aVal) || 0) - (parseFloat(bVal) || 0);
            } else if (type === 'status') {
              cmp = (statusOrder[aVal] ?? 99) - (statusOrder[bVal] ?? 99);
            } else {
              cmp = aVal.localeCompare(bVal);
            }
            return sortDir === 'asc' ? cmp : -cmp;
          });

          rows.forEach(row => tbody.appendChild(row));
          applyFilters();
        });
      });
    </script>
  `;

  return layout("Books", content);
}
