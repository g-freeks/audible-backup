import { layout } from "./layout.ts";
import { getAllBooks, type AudiobookRow } from "../../db.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getStatus(book: AudiobookRow, convertibleAsins: Set<string>): string {
  if (book.ignored_at) return "ignored";
  if (book.not_downloadable_at) return "not-downloadable";
  if (!book.downloaded_at) return "not-downloaded";
  if (!book.converted_at && convertibleAsins.has(book.asin)) return "convertible";
  if (!book.converted_at) return "downloaded";
  return "converted";
}

function statusBadge(status: string): string {
  switch (status) {
    case "ignored": return '<span class="badge badge-danger">Ignored</span>';
    case "not-downloadable": return '<span class="badge badge-danger">Not Downloadable</span>';
    case "not-downloaded": return '<span class="badge badge-muted">Not Downloaded</span>';
    case "convertible": return '<span class="badge badge-warn">Ready</span>';
    case "downloaded": return '<span class="badge badge-warn">Downloaded</span>';
    case "converted": return '<span class="badge badge-success">Converted</span>';
    default: return "";
  }
}

function redownloadItem(asin: string): string {
  return `<button class="dropdown-item" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-vals='{"asin":"${asin}","force":"true"}'>Re-download</button>`;
}

function ignoreItem(asin: string): string {
  return `<button class="dropdown-item" onclick="fetch('/api/ignore/${asin}',{method:'POST'}).then(()=>location.reload())">Ignore</button>`;
}

function deleteItem(asin: string): string {
  return `<button class="dropdown-item danger" onclick="if(confirm('Delete files for this book?'))fetch('/api/delete/${asin}',{method:'POST'}).then(()=>location.reload())">Delete</button>`;
}

function actionButtons(book: AudiobookRow, status: string): string {
  const asin = book.asin;
  let primary = "";
  const items: string[] = [];

  switch (status) {
    case "not-downloadable":
      primary = `<button class="btn btn-sm btn-primary split-main" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-vals='{"asin":"${asin}"}' title="Retry downloading this audiobook">Retry</button>`;
      items.push(ignoreItem(asin));
      break;
    case "not-downloaded":
      primary = `<button class="btn btn-sm btn-primary split-main" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-vals='{"asin":"${asin}"}' title="Download this audiobook from Audible">Download</button>`;
      items.push(ignoreItem(asin));
      break;
    case "downloaded":
      primary = `<button class="btn btn-sm btn-primary split-main" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-vals='{"asin":"${asin}","force":"true"}' title="Re-download with overwrite">Re-download</button>`;
      items.push(ignoreItem(asin));
      items.push(deleteItem(asin));
      break;
    case "convertible":
      primary = `<button class="btn btn-sm btn-primary split-main" hx-post="/convert/${asin}" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" title="Convert AAX to chapter-split MP3s">Convert</button>`;
      items.push(redownloadItem(asin));
      items.push(ignoreItem(asin));
      items.push(deleteItem(asin));
      break;
    case "converted":
      primary = `<button class="btn btn-sm btn-primary split-main" hx-post="/convert/${asin}" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-vals='{"force":"true"}' title="Re-convert AAX to chapter-split MP3s">Re-convert</button>`;
      items.push(redownloadItem(asin));
      items.push(ignoreItem(asin));
      items.push(deleteItem(asin));
      break;
    case "ignored":
      primary = `<button class="btn btn-sm btn-primary split-main" onclick="fetch('/api/unignore/${asin}',{method:'POST'}).then(()=>location.reload())" title="Remove from ignored list">Unignore</button>`;
      items.push(deleteItem(asin));
      break;
  }

  if (!primary) return "";
  if (items.length === 0) return primary;

  return `<div class="action-dropdown"><div class="split-btn">${primary}<button class="btn btn-sm btn-primary split-caret" type="button" onclick="event.stopPropagation();this.closest('.action-dropdown').classList.toggle('open')">&#9662;</button></div><div class="dropdown-menu">${items.join("")}</div></div>`;
}

export function booksPage(convertibleAsins: Set<string>): string {
  const books = getAllBooks();
  const hasNotDownloaded = books.some((b) => !b.downloaded_at && !b.ignored_at && !b.not_downloadable_at);

  const statusCounts: Record<string, number> = {};
  books.forEach(book => {
    const s = getStatus(book, convertibleAsins);
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });
  const statusDefs = [
    { value: "not-downloaded", label: "Not Downloaded" },
    { value: "not-downloadable", label: "Not Downloadable" },
    { value: "downloaded", label: "Downloaded" },
    { value: "convertible", label: "Ready" },
    { value: "converted", label: "Converted" },
    { value: "ignored", label: "Ignored" },
  ];
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
          ${statusDefs.map(s =>
            `<button class="filter-btn active" data-status="${s.value}">${s.label} (${statusCounts[s.value] || 0})</button>`
          ).join("\n          ")}
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
      const searchInput = document.getElementById('search-input');
      const tbody = document.querySelector('#books-table tbody');
      const allStatuses = ['not-downloaded','not-downloadable','downloaded','convertible','converted','ignored'];
      const activeStatuses = new Set(allStatuses);

      function getRows() {
        return Array.from(document.querySelectorAll('#books-table tbody tr[data-status]'));
      }

      function applyFilters() {
        const query = searchInput?.value.toLowerCase() || '';
        getRows().forEach(row => {
          const matchesSearch = !query || row.dataset.search.includes(query);
          const matchesFilter = activeStatuses.has(row.dataset.status);
          row.style.display = (matchesSearch && matchesFilter) ? '' : 'none';
        });
      }

      searchInput?.addEventListener('input', applyFilters);

      // Status filter pills (inline, multi-select)
      document.querySelectorAll('.filter-btn[data-status]').forEach(btn => {
        btn.addEventListener('click', () => {
          const status = btn.dataset.status;
          if (btn.classList.contains('active')) {
            btn.classList.remove('active');
            activeStatuses.delete(status);
          } else {
            btn.classList.add('active');
            activeStatuses.add(status);
          }
          applyFilters();
        });
      });

      // Close action dropdowns on outside click
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.split-caret')) {
          document.querySelectorAll('.action-dropdown.open').forEach(d => d.classList.remove('open'));
        }
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
      const statusOrder = { 'not-downloaded': 0, 'not-downloadable': 1, 'convertible': 2, 'downloaded': 3, 'converted': 4, 'ignored': 5 };
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
