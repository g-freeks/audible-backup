import { Menu } from "@base-ui/react/menu";
import type { Book } from "../types.ts";
import { useConfirm } from "../components/ConfirmDialog.tsx";

export interface BookActions {
  prepare: (asin: string) => void;
  reconvert: (asin: string) => void;
  redownload: (asin: string) => void;
  ignore: (asin: string) => void;
  unignore: (asin: string) => void;
  deleteBook: (asin: string) => void;
}

/** One primary action per row plus an overflow menu, mirroring
 * actionButtons() in the old books.ts exactly: which actions are offered
 * depends only on the book's status. */
export function RowActions({ book, actions }: { book: Book; actions: BookActions }) {
  const confirm = useConfirm();
  const { asin, status } = book;

  const deleteWithConfirm = async () => {
    if (await confirm("Delete files for this book?")) actions.deleteBook(asin);
  };

  const items: { label: string; onClick: () => void; danger?: boolean }[] = [];
  let primaryLabel: string | null = null;
  let primaryHref: string | null = null;
  let primaryOnClick: (() => void) | null = null;

  switch (status) {
    case "not-downloadable":
      primaryLabel = "Retry";
      primaryOnClick = () => actions.prepare(asin);
      items.push({ label: "Ignore", onClick: () => actions.ignore(asin) });
      break;
    case "not-downloaded":
      primaryLabel = "Download";
      primaryOnClick = () => actions.prepare(asin);
      items.push({ label: "Ignore", onClick: () => actions.ignore(asin) });
      break;
    case "downloaded":
    case "convertible":
      primaryLabel = "Download";
      primaryOnClick = () => actions.prepare(asin);
      items.push(
        { label: "Save original AAX", onClick: () => (location.href = `/download/aax/${asin}`) },
        { label: "Fetch again from Audible", onClick: () => actions.redownload(asin) },
        { label: "Ignore", onClick: () => actions.ignore(asin) },
        { label: "Delete", onClick: deleteWithConfirm, danger: true },
      );
      break;
    case "converted":
      primaryLabel = "Download";
      primaryHref = `/download/converted/${asin}`;
      items.push(
        { label: "Convert again", onClick: () => actions.reconvert(asin) },
        { label: "Save original AAX", onClick: () => (location.href = `/download/aax/${asin}`) },
        { label: "Fetch again from Audible", onClick: () => actions.redownload(asin) },
        { label: "Ignore", onClick: () => actions.ignore(asin) },
        { label: "Delete", onClick: deleteWithConfirm, danger: true },
      );
      break;
    case "ignored":
      primaryLabel = "Unignore";
      primaryOnClick = () => actions.unignore(asin);
      items.push({ label: "Delete", onClick: deleteWithConfirm, danger: true });
      break;
  }

  if (!primaryLabel) return null;

  const primary = primaryHref ? (
    <a
      className="btn btn-sm btn-primary split-main"
      href={primaryHref}
      title="Download the chapter MP3s as a ZIP"
    >
      {primaryLabel}
    </a>
  ) : (
    <button type="button" className="btn btn-sm btn-primary split-main" onClick={primaryOnClick ?? undefined}>
      {primaryLabel}
    </button>
  );

  if (items.length === 0) return primary;

  return (
    <div className="split-btn">
      {primary}
      <Menu.Root>
        <Menu.Trigger className="btn btn-sm btn-primary split-caret" aria-label="More actions">
          &#9662;
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={2}>
            <Menu.Popup className="dropdown-menu">
              {items.map((item) => (
                <Menu.Item
                  key={item.label}
                  className={`dropdown-item${item.danger ? " danger" : ""}`}
                  onClick={item.onClick}
                >
                  {item.label}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
