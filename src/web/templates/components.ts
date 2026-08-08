import { escapeHtml } from "./html.ts";

/** Shared badge / progress fragments used by page templates, SSE events, and OOB swaps. */

export type BadgeKind = "success" | "warn" | "danger" | "muted";

export function badge(kind: BadgeKind, label: string): string {
  return `<span class="badge badge-${kind}">${escapeHtml(label)}</span>`;
}

export function statusBadge(status: string): string {
  switch (status) {
    case "ignored": return badge("danger", "Ignored");
    case "not-downloadable": return badge("danger", "Not Downloadable");
    case "not-downloaded": return badge("muted", "Not Downloaded");
    case "convertible": return badge("warn", "Ready");
    case "downloaded": return badge("warn", "Downloaded");
    case "converted": return badge("success", "Converted");
    default: return "";
  }
}

export function progressBar(percent?: number): string {
  const aria = 'role="progressbar" aria-valuemin="0" aria-valuemax="100"';
  if (percent === undefined) {
    return `<div class="progress-bar" ${aria}><div class="progress-bar-fill"></div></div>`;
  }
  return `<div class="progress-bar" ${aria} aria-valuenow="${percent}"><div class="progress-bar-fill" style="width:${percent}%;animation:none"></div></div>`;
}

/** Out-of-band status cell swap for a book row. */
export function bookStatusSwap(asin: string, inner: string): string {
  return `<span id="status-${escapeHtml(asin)}" hx-swap-oob="true">${inner}</span>`;
}

export function queuedSwap(asin: string): string {
  return bookStatusSwap(asin, badge("muted", "Queued"));
}
