import { layout } from "./layout.ts";
import { config } from "../../config.ts";
import { Converter, type BookFiles } from "../../converter.ts";
import { isConverted, getIgnoredAsins } from "../../db.ts";

export function convertPage(): string {
  let books: BookFiles[] = [];
  let error = "";

  try {
    const converter = new Converter(
      config.targetDir,
      config.outputDir,
      config.activationBytes,
    );
    books = converter.findBookFiles();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const ignoredAsins = getIgnoredAsins();
  const activeBooks = books.filter((b) => !ignoredAsins.has(b.asin));
  const unconverted = activeBooks.filter((b) => !isConverted(b.asin));
  const alreadyConverted = activeBooks.filter((b) => isConverted(b.asin));

  const content = `
    <h1>Convert</h1>

    <div class="actions">
      <button class="btn btn-primary"
        hx-post="/convert/all"
        hx-target="#progress-panel"
        hx-swap="innerHTML"
        hx-disabled-elt="this"
        ${unconverted.length === 0 ? "disabled" : ""}>
        Convert All (${unconverted.length})
        <span class="htmx-indicator"><span class="spinner"></span></span>
      </button>
    </div>
    <div id="progress-panel"></div>

    ${error ? `<div class="card" style="border-color: var(--danger); margin-bottom: 1.5rem;"><span style="color: var(--danger)">${escapeHtml(error)}</span></div>` : ""}

    ${unconverted.length > 0 ? `
    <h2>Ready for Conversion</h2>
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>ASIN</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${unconverted.map((book) => {
          const name = escapeHtml(book.bookTitle || book.asin);
          return `<tr>
            <td>${name}</td>
            <td><code>${book.asin}</code></td>
            <td>
              <button class="btn btn-primary btn-sm"
                hx-post="/convert/${book.asin}"
                hx-target="#progress-panel"
                hx-swap="innerHTML"
                hx-disabled-elt="this">
                Convert
              </button>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>` : '<div class="empty">No books pending conversion.</div>'}

    ${alreadyConverted.length > 0 ? `
    <h2 style="margin-top: 2rem;">Already Converted</h2>
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>ASIN</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${alreadyConverted.map((book) => {
          const name = escapeHtml(book.bookTitle || book.asin);
          return `<tr>
            <td>${name}</td>
            <td><code>${book.asin}</code></td>
            <td><span class="badge badge-success">Converted</span></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>` : ""}
  `;

  return layout("Convert", content);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
