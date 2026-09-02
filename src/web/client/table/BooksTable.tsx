import * as React from "react";
import { flexRender, type Table } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Book } from "../types.ts";
import type { features } from "./features.ts";
import { formatDate, formatRuntime, seriesLabel } from "./columns.tsx";
import { ColumnFilter } from "./ColumnFilter.tsx";
import { RowActions, type BookActions } from "./RowActions.tsx";
import { StatusCell } from "../components/StatusBadge.tsx";
import { useOperationContext } from "../OperationContext.tsx";

type BooksTableInstance = Table<typeof features, Book>;

function DraggableHeader({
  header,
}: {
  header: ReturnType<BooksTableInstance["getHeaderGroups"]>[number]["headers"][number];
}) {
  const column = header.column;
  const sortable = column.id !== "select" && column.id !== "actions" && column.getCanSort();
  const draggable = sortable; // same set as "reorderable" in the old UI

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !draggable,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    width: header.getSize(),
    opacity: isDragging ? 0.4 : 1,
    cursor: draggable ? "grab" : undefined,
  };

  const sortDir = column.getIsSorted();

  return (
    <th
      ref={draggable ? setNodeRef : undefined}
      style={style}
      className={sortable ? `sortable${sortDir ? ` ${sortDir}` : ""}` : undefined}
      // The click handler lives on the <th> itself, not the inner span —
      // .th-inner only wraps its text, so a click anywhere else in the
      // cell's padding (most of a wide column like Title) would otherwise
      // miss it entirely, unlike the old UI where the whole header cell was
      // clickable.
      onClick={sortable ? column.getToggleSortingHandler() : undefined}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
    >
      {header.isPlaceholder ? null : (
        <span className="th-inner">{flexRender(header.column.columnDef.header, header.getContext())}</span>
      )}
      {column.getCanFilter() && <ColumnFilter column={column} />}
    </th>
  );
}

/** The books table: virtualized rows, drag-to-reorder + click-to-sort +
 * per-column filter popovers on headers, row selection, live per-row status
 * from the shared operation stream, and the row action menu. */
export function BooksTable({ table, actions }: { table: BooksTableInstance; actions: BookActions }) {
  const { books: opBooks } = useOperationContext();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 41,
    overscan: 10,
    getItemKey: (index) => rows[index]!.id,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columnOrder = table.state.columnOrder;
  const dragIds = table
    .getHeaderGroups()[0]!
    .headers.map((h) => h.column.id)
    .filter((id) => id !== "select" && id !== "actions");

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const order = columnOrder.length ? columnOrder : dragIds;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const next = order.slice();
    next.splice(from, 1);
    next.splice(to, 0, String(active.id));
    table.setColumnOrder(next);
  };

  const visibleRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = visibleRows.length > 0 ? visibleRows[0]!.start : 0;
  const paddingBottom = visibleRows.length > 0 ? totalSize - visibleRows[visibleRows.length - 1]!.end : 0;

  if (rows.length === 0) {
    return <div className="empty">No books in database. Sync your library to get started.</div>;
  }

  return (
    <div className="table-scroll" ref={scrollRef}>
      <table id="books-table">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                <SortableContext items={dragIds} strategy={horizontalListSortingStrategy}>
                  {group.headers.map((header) => (
                    <DraggableHeader key={header.id} header={header} />
                  ))}
                </SortableContext>
              </tr>
            ))}
          </thead>
        </DndContext>
        <tbody>
          {paddingTop > 0 && (
            <tr>
              <td style={{ height: paddingTop, padding: 0, border: 0 }} colSpan={table.getVisibleLeafColumns().length} />
            </tr>
          )}
          {visibleRows.map((virtualRow) => {
            const row = rows[virtualRow.index]!;
            const book = row.original;
            return (
              <tr key={row.id} data-index={virtualRow.index}>
                {row.getVisibleCells().map((cell) => {
                  if (cell.column.id === "select") {
                    return (
                      <td key={cell.id}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${book.title || book.asin}`}
                          checked={row.getIsSelected()}
                          onChange={row.getToggleSelectedHandler()}
                        />
                      </td>
                    );
                  }
                  if (cell.column.id === "status") {
                    return (
                      <td key={cell.id}>
                        <StatusCell status={book.status} op={opBooks[book.asin]} />
                      </td>
                    );
                  }
                  if (cell.column.id === "actions") {
                    return (
                      <td key={cell.id}>
                        <RowActions book={book} actions={actions} />
                      </td>
                    );
                  }
                  if (cell.column.id === "title" || cell.column.id === "author") {
                    const text = cell.column.id === "title" ? book.title || book.asin : book.author || "";
                    return (
                      <td key={cell.id} className={`col-${cell.column.id}`} title={text}>
                        {text}
                      </td>
                    );
                  }
                  if (cell.column.id === "series") {
                    const text = seriesLabel(book);
                    return (
                      <td key={cell.id} className="col-author" title={text}>
                        {text}
                      </td>
                    );
                  }
                  if (cell.column.id === "narrator") {
                    return (
                      <td key={cell.id} className="col-author" title={book.narrators || ""}>
                        {book.narrators}
                      </td>
                    );
                  }
                  if (cell.column.id === "asin") {
                    return (
                      <td key={cell.id}>
                        <code>{book.asin}</code>
                      </td>
                    );
                  }
                  if (["downloaded", "purchased", "released"].includes(cell.column.id)) {
                    const raw =
                      cell.column.id === "downloaded"
                        ? book.downloaded_at
                        : cell.column.id === "purchased"
                          ? book.added_to_library_at
                          : book.released_at;
                    return <td key={cell.id}>{formatDate(raw)}</td>;
                  }
                  if (cell.column.id === "runtime") {
                    return <td key={cell.id}>{formatRuntime(book.runtime_minutes)}</td>;
                  }
                  return <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>;
                })}
              </tr>
            );
          })}
          {paddingBottom > 0 && (
            <tr>
              <td style={{ height: paddingBottom, padding: 0, border: 0 }} colSpan={table.getVisibleLeafColumns().length} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
