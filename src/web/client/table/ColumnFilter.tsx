import * as React from "react";
import { Popover } from "@base-ui/react/popover";
import type { Column } from "@tanstack/react-table";
import type { Book } from "../types.ts";
import { FACETED_COLUMN_IDS, DATE_COLUMN_IDS, NUMBER_COLUMN_IDS } from "./columns.tsx";
import type { features } from "./features.ts";

type BookColumn = Column<typeof features, Book, unknown>;

function FacetedFilter({ column }: { column: BookColumn }) {
  const options = React.useMemo(() => {
    const values = [...column.getFacetedUniqueValues().keys()].filter(
      (v): v is string => typeof v === "string" && v !== "",
    );
    values.sort();
    return values;
  }, [column]);
  const selected = new Set((column.getFilterValue() as string[] | undefined) ?? []);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    column.setFilterValue(next.size ? [...next] : undefined);
  };

  return (
    <div className="column-filter-list">
      {options.length === 0 && <div className="hint">No values yet</div>}
      {options.map((value) => (
        <label key={value} className="dropdown-item checkbox-item">
          <input type="checkbox" checked={selected.has(value)} onChange={() => toggle(value)} />
          {value} <span className="hint">({column.getFacetedUniqueValues().get(value)})</span>
        </label>
      ))}
    </div>
  );
}

function RangeFilter({
  column,
  type,
}: {
  column: BookColumn;
  type: "date" | "number";
}) {
  const [min, max] = (column.getFilterValue() as [unknown, unknown] | undefined) ?? [undefined, undefined];
  const set = (next: [unknown, unknown]) => {
    column.setFilterValue(next[0] == null && next[1] == null ? undefined : next);
  };
  return (
    <div className="column-filter-range">
      <label>
        From
        <input
          type={type === "date" ? "date" : "number"}
          value={(min as string | number | undefined) ?? ""}
          onChange={(e) => set([e.target.value || undefined, max])}
        />
      </label>
      <label>
        To
        <input
          type={type === "date" ? "date" : "number"}
          value={(max as string | number | undefined) ?? ""}
          onChange={(e) => set([min, e.target.value || undefined])}
        />
      </label>
    </div>
  );
}

function TextFilter({ column }: { column: BookColumn }) {
  const value = (column.getFilterValue() as string | undefined) ?? "";
  return (
    <input
      type="text"
      className="column-filter-text"
      placeholder="Contains…"
      value={value}
      onChange={(e) => column.setFilterValue(e.target.value || undefined)}
      autoFocus
    />
  );
}

/** A small filter icon on sortable/filterable headers, opening a popover
 * with the control appropriate to that column's data — text-contains,
 * faceted checkboxes, or a min/max range. */
export function ColumnFilter({ column }: { column: BookColumn }) {
  const active = column.getIsFiltered();
  const id = column.id;

  return (
    <Popover.Root>
      <Popover.Trigger
        className={`th-filter-btn${active ? " active" : ""}`}
        aria-label={`Filter ${id}`}
        title="Filter this column"
        onClick={(e) => e.stopPropagation()}
      >
        &#9662;
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={4}>
          <Popover.Popup className="dropdown-menu column-filter-popup">
            {FACETED_COLUMN_IDS.has(id) ? (
              <FacetedFilter column={column} />
            ) : DATE_COLUMN_IDS.has(id) ? (
              <RangeFilter column={column} type="date" />
            ) : NUMBER_COLUMN_IDS.has(id) ? (
              <RangeFilter column={column} type="number" />
            ) : (
              <TextFilter column={column} />
            )}
            {active && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ marginTop: "0.4rem", width: "100%" }}
                onClick={() => column.setFilterValue(undefined)}
              >
                Clear filter
              </button>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
