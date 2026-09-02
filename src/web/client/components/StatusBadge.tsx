import type { ReactNode } from "react";
import type { BookStatus } from "../types.ts";
import type { BookOpStatus } from "../useOperation.ts";

type IconProps = { className?: string };

function IgnoredIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <line x1="5" y1="19" x2="19" y2="5" />
    </svg>
  );
}

function AlertIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3L2 20h20L12 3z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TrayDownloadIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="12" y1="3" x2="12" y2="14" />
      <polyline points="7 9 12 14 17 9" />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </svg>
  );
}

/** Ready to convert — the two circles-and-crossed-blades shape reads as
 * "about to split into chapters", which is what this status means. */
function ScissorsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  );
}

function CheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CheckCircleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="8 12 11 15 16 9" />
    </svg>
  );
}

function ClockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

function XCircleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  );
}

/** A ring with a gap, spun by the same @keyframes spin the sync button
 * uses — reads as "in progress" without needing a percent to show one. */
function SpinnerIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...props}>
      <circle cx="12" cy="12" r="9" strokeDasharray="34 20" />
    </svg>
  );
}

const STATUS_ICONS: Record<BookStatus, { kind: string; label: string; Icon: (p: IconProps) => ReactNode }> = {
  ignored: { kind: "danger", label: "Ignored", Icon: IgnoredIcon },
  "not-downloadable": { kind: "danger", label: "Not Downloadable", Icon: AlertIcon },
  "not-downloaded": { kind: "muted", label: "Not Downloaded", Icon: TrayDownloadIcon },
  convertible: { kind: "warn", label: "Ready to convert", Icon: ScissorsIcon },
  downloaded: { kind: "warn", label: "Downloaded", Icon: CheckIcon },
  converted: { kind: "success", label: "Converted", Icon: CheckCircleIcon },
};

/** An icon-only badge instead of a text pill — the old text labels ("Not
 * Downloadable" worst of all) wrapped onto two lines in the Status column at
 * any reasonable width. The full label is still available as a tooltip and
 * to screen readers; the facet filter for this column reads the underlying
 * status value, not this label, so it is unaffected by the wording here. */
function IconBadge({
  kind,
  label,
  Icon,
  suffix,
  spin,
}: {
  kind: string;
  label: string;
  Icon: (p: IconProps) => ReactNode;
  suffix?: string;
  spin?: boolean;
}) {
  return (
    <span className="status-cell" title={label} aria-label={label}>
      <span className={`badge badge-${kind} badge-icon`}>
        <Icon className={spin ? "spin" : undefined} />
      </span>
      {suffix && <span className="status-suffix">{suffix}</span>}
    </span>
  );
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
        return <IconBadge kind="muted" label="Queued" Icon={ClockIcon} />;
      case "processing":
        return (
          <>
            <IconBadge
              kind="warn"
              label={op.percent !== undefined ? `Processing (${op.percent}%)` : "Processing"}
              Icon={SpinnerIcon}
              suffix={op.percent !== undefined ? `${op.percent}%` : undefined}
              spin
            />
            <ProgressBar percent={op.percent} />
          </>
        );
      case "done":
        return <IconBadge kind="success" label="Done" Icon={CheckCircleIcon} />;
      case "failed":
        return <IconBadge kind="danger" label="Failed" Icon={XCircleIcon} />;
    }
  }
  const { kind, label, Icon } = STATUS_ICONS[status];
  return <IconBadge kind={kind} label={label} Icon={Icon} />;
}
