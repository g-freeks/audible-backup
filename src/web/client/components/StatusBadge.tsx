import type { BookStatus } from "../types.ts";
import type { BookOpStatus } from "../useOperation.ts";

const LABELS: Record<BookStatus, { kind: string; label: string }> = {
  ignored: { kind: "danger", label: "Ignored" },
  "not-downloadable": { kind: "danger", label: "Not Downloadable" },
  "not-downloaded": { kind: "muted", label: "Not Downloaded" },
  convertible: { kind: "warn", label: "Ready" },
  downloaded: { kind: "warn", label: "Downloaded" },
  converted: { kind: "success", label: "Converted" },
};

function Badge({ kind, label }: { kind: string; label: string }) {
  return <span className={`badge badge-${kind}`}>{label}</span>;
}

export function ProgressBar({ percent }: { percent?: number }) {
  const known = percent !== undefined;
  return (
    <div
      className="progress-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? percent : undefined}
    >
      <div
        className="progress-bar-fill"
        style={known ? { width: `${percent}%`, animation: "none" } : undefined}
      />
    </div>
  );
}

/** One status cell: the live operation state for this ASIN (if any) takes
 * priority over the book's resting status, mirroring the SSE-driven OOB
 * swaps the old UI did per-row. */
export function StatusCell({ status, op }: { status: BookStatus; op?: BookOpStatus }) {
  if (op) {
    switch (op.state) {
      case "queued":
        return <Badge kind="muted" label="Queued" />;
      case "processing":
        return (
          <>
            <Badge kind="warn" label={op.percent !== undefined ? `${op.percent}%` : "Processing…"} />
            <ProgressBar percent={op.percent} />
          </>
        );
      case "done":
        return <Badge kind="success" label="Done" />;
      case "failed":
        return <Badge kind="danger" label="Failed" />;
    }
  }
  const { kind, label } = LABELS[status];
  return <Badge kind={kind} label={label} />;
}
