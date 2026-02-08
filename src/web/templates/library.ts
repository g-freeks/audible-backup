import { layout } from "./layout.ts";
import { getAllAudiobooks, getAllIgnoredBooks, getNotDownloadedBooks } from "../../db.ts";

export function libraryPage(): string {
  const all = getAllAudiobooks();
  const ignored = getAllIgnoredBooks();
  const notDownloaded = getNotDownloadedBooks();
  const downloaded = all.filter((b) => b.downloaded_at);

  const content = `
    <h1>Library</h1>

    <div class="actions">
      <button class="btn btn-primary" hx-post="/library/sync" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this">
        Sync Library
        <span class="htmx-indicator"><span class="spinner"></span></span>
      </button>
    </div>
    <div id="progress-panel"></div>

    ${notDownloaded.length > 0 ? `
    <h2>Not Downloaded (${notDownloaded.length})</h2>
    <form method="post" action="/library/download">
      <div class="actions" style="margin-bottom: 1rem;">
        <button class="btn btn-primary" type="submit" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this" hx-include="[name='asin']:checked">
          Download Selected
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>
        <button class="btn" type="button" hx-post="/library/download" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this">
          Download All
          <span class="htmx-indicator"><span class="spinner"></span></span>
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" id="select-all"></th>
            <th>Title</th>
            <th>Author</th>
            <th>ASIN</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${notDownloaded.map((book) => {
            const title = escapeHtml(book.title || book.asin);
            const author = escapeHtml(book.author || "");
            return `<tr>
              <td><input type="checkbox" name="asin" value="${book.asin}"></td>
              <td>${title}</td>
              <td>${author}</td>
              <td><code>${book.asin}</code></td>
              <td>
                <form method="post" action="/api/ignore/${book.asin}" style="display:inline">
                  <button class="btn btn-sm" type="submit">Ignore</button>
                </form>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </form>
    <script>
      document.querySelector('#select-all')?.addEventListener('change', (e) => {
        document.querySelectorAll('input[name="asin"]').forEach(cb => cb.checked = e.target.checked);
      });
    </script>` : ""}

    ${downloaded.length > 0 ? `
    <h2>Downloaded (${downloaded.length})</h2>
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Author</th>
          <th>ASIN</th>
          <th>Status</th>
          <th>Downloaded</th>
          <th>Chapters</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${downloaded.map((book) => {
          const status = book.converted_at
            ? '<span class="badge badge-success">Converted</span>'
            : '<span class="badge badge-warn">Downloaded</span>';
          const title = escapeHtml(book.title || book.asin);
          const author = escapeHtml(book.author || "");
          const date = book.downloaded_at ? new Date(book.downloaded_at + "Z").toLocaleDateString() : "";
          const chapters = book.chapter_count ?? "";
          return `<tr>
            <td>${title}</td>
            <td>${author}</td>
            <td><code>${book.asin}</code></td>
            <td>${status}</td>
            <td>${date}</td>
            <td>${chapters}</td>
            <td>
              <form method="post" action="/api/ignore/${book.asin}" style="display:inline">
                <button class="btn btn-sm" type="submit">Ignore</button>
              </form>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>` : `${notDownloaded.length === 0 ? '<div class="empty">No books in database. Sync your library to get started.</div>' : ""}`}

    ${ignored.length > 0 ? `
    <details style="margin-top: 2rem;">
      <summary><h2 style="display:inline">Ignored (${ignored.length})</h2></summary>
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Author</th>
            <th>ASIN</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${ignored.map((book) => {
            const title = escapeHtml(book.title || book.asin);
            const author = escapeHtml(book.author || "");
            return `<tr>
              <td>${title}</td>
              <td>${author}</td>
              <td><code>${book.asin}</code></td>
              <td>
                <form method="post" action="/api/unignore/${book.asin}" style="display:inline">
                  <button class="btn btn-sm" type="submit">Unignore</button>
                </form>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </details>` : ""}
  `;

  return layout("Library", content);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
