import { layout } from "./layout.ts";
import { getAllAudiobooks, getDownloadedAsins, getConvertedAsins, getAllIgnoredBooks } from "../../db.ts";

export function dashboardPage(): string {
  const all = getAllAudiobooks();
  const downloaded = getDownloadedAsins();
  const converted = getConvertedAsins();
  const ignored = getAllIgnoredBooks();
  const pending = downloaded.size - converted.size;

  const recent = all.slice(0, 8);

  const content = `
    <h1>Dashboard</h1>
    <div class="cards">
      <div class="card">
        <div class="label">Total Books</div>
        <div class="value">${all.length}</div>
      </div>
      <div class="card">
        <div class="label">Downloaded</div>
        <div class="value">${downloaded.size}</div>
      </div>
      <div class="card">
        <div class="label">Converted</div>
        <div class="value" style="color: var(--success)">${converted.size}</div>
      </div>
      <div class="card">
        <div class="label">Pending Conversion</div>
        <div class="value" style="color: ${pending > 0 ? "var(--warn)" : "var(--text-muted)"}">${pending}</div>
      </div>
      <div class="card">
        <div class="label">Ignored</div>
        <div class="value" style="color: var(--text-muted)">${ignored.length}</div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-primary" hx-post="/library/sync" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this">
        Sync Library
        <span class="htmx-indicator"><span class="spinner"></span></span>
      </button>
      <button class="btn btn-primary" hx-post="/convert/all" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this">
        Convert All
        <span class="htmx-indicator"><span class="spinner"></span></span>
      </button>
    </div>
    <div id="progress-panel"></div>

    ${recent.length > 0 ? `
    <h2>Recent Books</h2>
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Author</th>
          <th>ASIN</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${recent.map((book) => {
          const status = book.converted_at
            ? '<span class="badge badge-success">Converted</span>'
            : '<span class="badge badge-warn">Downloaded</span>';
          const title = escapeHtml(book.title || book.asin);
          const author = escapeHtml(book.author || "");
          return `<tr><td>${title}</td><td>${author}</td><td><code>${book.asin}</code></td><td>${status}</td></tr>`;
        }).join("")}
      </tbody>
    </table>` : '<div class="empty">No books tracked yet. Sync your library to get started.</div>'}
  `;

  return layout("Dashboard", content);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
