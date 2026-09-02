import * as React from "react";
import { useOperationContext } from "../OperationContext.tsx";
import { ProgressBar } from "./StatusBadge.tsx";

/** The floating operation log — closed until opened from the topbar's Log
 * button, matching the old UI's #log-float behavior (layout.ts / app.js).
 * A running or just-finished operation only lights up the toggle's dot;
 * the panel itself never pops open on its own. */
export function LogPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { logs, progress, running, result } = useOperationContext();
  const bodyRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [open, logs.length]);

  return (
    <div id="log-float" role="region" aria-label="Operation log" className={open ? "visible" : ""}>
      <div id="log-float-header">
        <span id="log-float-title">Operation Log</span>
        <div>
          <button id="log-float-close" title="Close" aria-label="Close operation log" onClick={onClose}>
            &times;
          </button>
        </div>
      </div>
      <div id="progress-panel" ref={bodyRef}>
        {progress && (
          <div className="progress-bar progress-bar-lg" style={{ marginBottom: "0.5rem" }}>
            <ProgressBar percent={progress.percent} />
          </div>
        )}
        <div className="log-panel">
          {logs.map((line, i) => (
            <div key={i} className={`log-line ${line.type}`}>
              {line.message}
            </div>
          ))}
          {!running && result && (
            <div className={`log-done ${result.success ? "success" : "error"}`}>
              {result.summary || "Done"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The topbar button that opens the panel above — a plain dot that tracks
 * running/done/failed, same semantics as the old #log-indicator. */
export function LogToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { running, result } = useOperationContext();
  const state = running ? "running" : open ? null : result ? (result.success ? "done" : "failed") : null;

  return (
    <button
      id="log-toggle"
      className="btn btn-sm btn-ghost"
      type="button"
      aria-expanded={open}
      aria-controls="log-float"
      title="Show the operation log"
      onClick={onToggle}
    >
      Log{" "}
      {state && (
        <span id="log-indicator" className={`log-dot ${state}`} />
      )}
    </button>
  );
}
