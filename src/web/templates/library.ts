import { layout } from "./layout.ts";
import { getAllAudiobooks } from "../../db.ts";

export function libraryPage(): string {
  const all = getAllAudiobooks();

  const content = `
    <h1>Library</h1>

    <div class="actions">
      <button class="btn btn-primary" hx-post="/library/sync" hx-target="#progress-panel" hx-swap="innerHTML" hx-disabled-elt="this">
        Sync Library
        <span class="htmx-indicator"><span class="spinner"></span></span>
      </button>
    </div>
    <div id="progress-panel"></div>

    ${all.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Author</th>
          <th>ASIN</th>
          <th>Status</th>
          <th>Downloaded</th>
          <th>Chapters</th>
        </tr>
      </thead>
      <tbody>
        ${all.map((book) => {
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
          </tr>`;
        }).join("")}
      </tbody>
    </table>` : '<div class="empty">No books in database. Sync your library to get started.</div>'}
  `;

  return layout("Library", content);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
