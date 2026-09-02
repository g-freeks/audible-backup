import { Menu } from "@base-ui/react/menu";
import type { Table } from "@tanstack/react-table";
import type { Book } from "../types.ts";
import { HIDEABLE_COLUMN_IDS } from "./columns.tsx";
import type { features } from "./features.ts";

/** Show/hide table columns — Title, the checkbox column and Actions can't
 * be hidden (enableHiding: false on those column defs), same restriction
 * the old columnsMenu() in books.ts had. */
export function ColumnsMenu({ table }: { table: Table<typeof features, Book> }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="btn btn-sm btn-ghost" title="Show or hide table columns">
        Columns &#9662;
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={2}>
          <Menu.Popup className="dropdown-menu">
            {HIDEABLE_COLUMN_IDS.map((id) => {
              const column = table.getColumn(id);
              if (!column) return null;
              return (
                <Menu.CheckboxItem
                  key={id}
                  className="dropdown-item checkbox-item"
                  checked={column.getIsVisible()}
                  onCheckedChange={(checked) => column.toggleVisibility(checked)}
                  closeOnClick={false}
                >
                  {column.columnDef.meta?.label ?? id}
                </Menu.CheckboxItem>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
