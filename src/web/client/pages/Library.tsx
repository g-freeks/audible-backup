import * as React from "react";
import { useTable, functionalUpdate } from "@tanstack/react-table";
import { Topbar } from "../components/Topbar.tsx";
import { useToast } from "../components/Toaster.tsx";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { useOperationContext } from "../OperationContext.tsx";
import { api, ApiRequestError } from "../api.ts";
import type { Book } from "../types.ts";
import { columns } from "../table/columns.tsx";
import { features } from "../table/features.ts";
import { useTableState } from "../table/useTableState.ts";
import { BooksTable } from "../table/BooksTable.tsx";
import { ColumnsMenu } from "../table/ColumnsMenu.tsx";
import type { BookActions } from "../table/RowActions.tsx";

const EMPTY_BOOKS: Book[] = [];

export function LibraryPage() {
  const [books, setBooks] = React.useState<Book[]>(EMPTY_BOOKS);
  const [loaded, setLoaded] = React.useState(false);
  const toast = useToast();
  const op = useOperationContext();
  const { state, patch, rowSelection, setRowSelection } = useTableState();

  const refetchBooks = React.useCallback(() => {
    api.books
      .list()
      .then(setBooks)
      .catch((err) => {
        if (!(err instanceof ApiRequestError)) toast("Could not load the library", true);
      })
      .finally(() => setLoaded(true));
  }, [toast]);

  React.useEffect(() => {
    refetchBooks();
  }, [refetchBooks]);

  // Same trigger as the old "refresh-books" event: refetch once an
  // operation finishes, whether it succeeded or failed.
  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    if (wasRunning.current && !op.running) refetchBooks();
    wasRunning.current = op.running;
  }, [op.running, refetchBooks]);

  const table = useTable({
    features,
    columns,
    data: books,
    getRowId: (row) => row.asin,
    enableMultiSort: true,
    enableSortingRemoval: true,
    state: {
      sorting: state.sorting,
      columnFilters: state.columnFilters,
      globalFilter: state.globalFilter,
      columnVisibility: state.columnVisibility,
      columnOrder: state.columnOrder,
      columnSizing: state.columnSizing,
      rowSelection,
    },
    onSortingChange: (updater) => patch("sorting", functionalUpdate(updater, state.sorting)),
    onColumnFiltersChange: (updater) => patch("columnFilters", functionalUpdate(updater, state.columnFilters)),
    onGlobalFilterChange: (updater) => patch("globalFilter", functionalUpdate(updater, state.globalFilter)),
    onColumnVisibilityChange: (updater) =>
      patch("columnVisibility", functionalUpdate(updater, state.columnVisibility)),
    onColumnOrderChange: (updater) => patch("columnOrder", functionalUpdate(updater, state.columnOrder)),
    onColumnSizingChange: (updater) => patch("columnSizing", functionalUpdate(updater, state.columnSizing)),
    onRowSelectionChange: (updater) => setRowSelection(functionalUpdate(updater, rowSelection)),
  });

  const runOperation = React.useCallback(
    async (starter: () => Promise<{ type: string; queued: string[] }>) => {
      try {
        await op.start(starter);
      } catch (err) {
        toast(err instanceof ApiRequestError ? err.message : "Could not start the operation", true);
      }
    },
    [op, toast],
  );

  const actions: BookActions = React.useMemo(
    () => ({
      prepare: (asin) => runOperation(() => api.operation.prepare(asin)),
      reconvert: (asin) => runOperation(() => api.operation.convert(asin, true)),
      redownload: (asin) => runOperation(() => api.operation.download([asin], true)),
      ignore: (asin) =>
        api.books
          .ignore(asin)
          .then(refetchBooks)
          .catch((err) => toast(err instanceof ApiRequestError ? err.message : "Could not ignore", true)),
      unignore: (asin) =>
        api.books
          .unignore(asin)
          .then(refetchBooks)
          .catch((err) => toast(err instanceof ApiRequestError ? err.message : "Could not unignore", true)),
      deleteBook: (asin) =>
        api.books
          .delete(asin)
          .then(refetchBooks)
          .catch((err) => toast(err instanceof ApiRequestError ? err.message : "Could not delete", true)),
    }),
    [runOperation, refetchBooks, toast],
  );

  const confirm = useConfirm();
  const selectedAsins = Object.keys(rowSelection).filter((id) => rowSelection[id]);

  const syncing = op.running && op.type === "sync";
  const downloadSelected = () => runOperation(() => api.operation.downloadAll(selectedAsins));
  const downloadAllRemaining = async () => {
    if (
      await confirm(
        "Download every remaining book from Audible and convert everything that's ready? This may take a while.",
      )
    ) {
      runOperation(() => api.operation.downloadAll(undefined));
    }
  };

  const center = (
    <>
      <button
        id="sync-library-btn"
        className="btn btn-sm btn-icon btn-ghost"
        aria-label={syncing ? "Cancel sync library" : "Sync Library"}
        title="Fetch latest library listing from Audible"
        disabled={op.running && !syncing}
        data-cancel={syncing ? "true" : undefined}
        onClick={() => (syncing ? op.cancel() : runOperation(() => api.operation.sync()))}
      >
        <SyncIcons />
      </button>
      <div className="search-wrap">
        <input
          type="text"
          id="search-input"
          placeholder="Search by title, author, or ASIN..."
          autoComplete="off"
          value={state.globalFilter}
          onChange={(e) => patch("globalFilter", e.target.value)}
        />
        {state.globalFilter && (
          <button
            id="search-clear"
            type="button"
            className="search-clear"
            aria-label="Clear search"
            onClick={() => patch("globalFilter", "")}
          >
            &times;
          </button>
        )}
      </div>
      <button
        id="download-selected-btn"
        className="btn btn-sm btn-primary"
        disabled={op.running || selectedAsins.length === 0}
        onClick={downloadSelected}
      >
        Download Selected
      </button>
      <button
        id="download-all-btn"
        className="btn btn-sm btn-primary"
        disabled={op.running}
        onClick={downloadAllRemaining}
      >
        Download All
      </button>
      <ColumnsMenu table={table} />
    </>
  );

  return (
    <>
      <Topbar center={center} />
      <main>
        <div className="library-layout">
          {loaded && <BooksTable table={table} actions={actions} />}
        </div>
      </main>
    </>
  );
}

/** Both icons stay in the DOM at all times — theme.css's
 * .btn-icon[data-cancel] rules swap which one shows via CSS (spinning
 * refresh normally, a red X on hover), matching the old REFRESH_ICON/
 * CANCEL_ICON pair in books.ts exactly. */
function SyncIcons() {
  return (
    <>
      <svg className="icon-refresh" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08a5.99 5.99 0 01-5.65 4c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
      </svg>
      <svg className="icon-cancel" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
      </svg>
    </>
  );
}
