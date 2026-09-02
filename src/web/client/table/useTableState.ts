import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SortingState,
  ColumnFiltersState,
  VisibilityState,
  ColumnOrderState,
  ColumnSizingState,
  RowSelectionState,
} from "@tanstack/react-table";
import { api } from "../api.ts";
import { HIDEABLE_COLUMN_IDS } from "./columns.tsx";

export interface PersistedTableState {
  sorting: SortingState;
  columnFilters: ColumnFiltersState;
  globalFilter: string;
  columnVisibility: VisibilityState;
  columnOrder: ColumnOrderState;
  columnSizing: ColumnSizingState;
}

const DEFAULT_STATE: PersistedTableState = {
  sorting: [],
  columnFilters: [],
  globalFilter: "",
  columnVisibility: {},
  columnOrder: ["select", "title", ...HIDEABLE_COLUMN_IDS, "actions"],
  columnSizing: {},
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Reconciles a saved column order against the columns that actually exist
 * today: drops stale keys, appends anything new since the save (same logic
 * as getColumnOrder() in the old app.js). */
function reconcileOrder(saved: unknown): ColumnOrderState {
  // "select" and "actions" are pinned first/last regardless of what was
  // saved — only the reorderable data columns in between come from state.
  const reorderable = ["title", ...HIDEABLE_COLUMN_IDS];
  const savedArr = Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  const kept = savedArr.filter((id) => reorderable.includes(id));
  const missing = reorderable.filter((id) => !kept.includes(id));
  return ["select", ...kept, ...missing, "actions"];
}

/**
 * Owns the books table's full client-side state and persists it to
 * /api/table-state (per-account, since the desktop app's port changes every
 * launch and localStorage alone would reset on every restart — see
 * users.ts's TableState). Row selection is deliberately NOT persisted (it
 * never was, even in the old column-prefs storage — it's a this-session
 * concept).
 */
export function useTableState() {
  const [state, setState] = useState<PersistedTableState>(DEFAULT_STATE);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.tableState
      .get()
      .then((saved) => {
        if (cancelled || !isPlainObject(saved)) return;
        setState({
          sorting: Array.isArray(saved.sorting) ? (saved.sorting as SortingState) : [],
          columnFilters: Array.isArray(saved.columnFilters) ? (saved.columnFilters as ColumnFiltersState) : [],
          globalFilter: typeof saved.globalFilter === "string" ? saved.globalFilter : "",
          columnVisibility: isPlainObject(saved.columnVisibility) ? (saved.columnVisibility as VisibilityState) : {},
          columnOrder: reconcileOrder(saved.columnOrder),
          columnSizing: isPlainObject(saved.columnSizing) ? (saved.columnSizing as ColumnSizingState) : {},
        });
      })
      .catch(() => {
        // legacy mode (no account) or a transient error — defaults stand.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced save whenever state changes after the initial load, so a burst
  // of column drags or filter keystrokes doesn't fire one request each.
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.tableState.save(state as unknown as Record<string, unknown>).catch(() => {});
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state, loaded]);

  const patch = useCallback(<K extends keyof PersistedTableState>(key: K, value: PersistedTableState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
  }, []);

  return { state, patch, rowSelection, setRowSelection, loaded };
}
