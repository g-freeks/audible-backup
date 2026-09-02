import * as React from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, sortableKeyboardCoordinates, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { OutputFormat, FormatRow, FormatSegment, TagDef } from "../types.ts";
import { BOOK_TAGS, CHAPTER_TAGS } from "../types.ts";

const ALL_TAGS = [...BOOK_TAGS, ...CHAPTER_TAGS];
function tagLabel(key: string): string {
  return ALL_TAGS.find((t) => t.key === key)?.label || key;
}

function sanitizePreviewName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderRowValue(row: FormatRow, values: Record<string, string>): string {
  return row.map((seg) => (seg.type === "tag" ? values[seg.value] || "" : seg.value)).join("");
}

const PREVIEW_SAMPLE: Record<string, string> = {
  title: "The Final Empire",
  author: "Brandon Sanderson",
  series: "Mistborn",
  seriesEntry: "1",
  narrator: "Michael Kramer",
  language: "English",
  asin: "B002V1O3XG",
  year: "2006",
};
const PREVIEW_CHAPTER = { chapterNumber: "01", chapterName: "Prologue" };

type ChipId = `${"directory" | "filename"}:${number}:${number}`;

function Chip({
  section,
  rowIndex,
  blockIndex,
  seg,
  onChange,
  onRemove,
}: {
  section: "directory" | "filename";
  rowIndex: number;
  blockIndex: number;
  seg: FormatSegment;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const id: ChipId = `${section}:${rowIndex}:${blockIndex}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { section, rowIndex },
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <span
      ref={setNodeRef}
      style={style}
      className={`format-chip${seg.type === "text" ? " format-chip-text" : ""}`}
      {...attributes}
      {...listeners}
    >
      {seg.type === "tag" ? (
        <span className="format-chip-label">{tagLabel(seg.value)}</span>
      ) : (
        <input
          type="text"
          className="chip-text-input"
          value={seg.value}
          size={Math.max(2, seg.value.length)}
          onChange={(e) => onChange(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
      <button type="button" className="chip-remove" aria-label="Remove" onClick={onRemove}>
        &times;
      </button>
    </span>
  );
}

function RowBlocks({
  section,
  rowIndex,
  row,
  availableTags,
  onAddTag,
  onAddText,
  onChangeChip,
  onRemoveChip,
}: {
  section: "directory" | "filename";
  rowIndex: number;
  row: FormatRow;
  availableTags: TagDef[];
  onAddTag: (key: string) => void;
  onAddText: () => void;
  onChangeChip: (blockIndex: number, value: string) => void;
  onRemoveChip: (blockIndex: number) => void;
}) {
  const droppableId = `${section}:${rowIndex}`;
  const { setNodeRef } = useDroppable({ id: droppableId, data: { section, rowIndex } });
  const chipIds: ChipId[] = row.map((_, i) => `${section}:${rowIndex}:${i}`);

  return (
    <div className="format-blocks" ref={setNodeRef}>
      <SortableContext items={chipIds} strategy={verticalListSortingStrategy}>
        {row.map((seg, i) => (
          <Chip
            key={chipIds[i]}
            section={section}
            rowIndex={rowIndex}
            blockIndex={i}
            seg={seg}
            onChange={(v) => onChangeChip(i, v)}
            onRemove={() => onRemoveChip(i)}
          />
        ))}
      </SortableContext>
      <select
        className="format-add-tag"
        value=""
        onChange={(e) => {
          if (e.target.value) onAddTag(e.target.value);
        }}
      >
        <option value="">+ Tag</option>
        {availableTags.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-sm btn-ghost format-add-text" onClick={onAddText}>
        + Text
      </button>
    </div>
  );
}

function DirectoryRow({
  rowIndex,
  row,
  removable,
  onAddTag,
  onAddText,
  onChangeChip,
  onRemoveChip,
  onRemoveRow,
}: {
  rowIndex: number;
  row: FormatRow;
  removable: boolean;
  onAddTag: (key: string) => void;
  onAddText: () => void;
  onChangeChip: (blockIndex: number, value: string) => void;
  onRemoveChip: (blockIndex: number) => void;
  onRemoveRow: () => void;
}) {
  const gripId = `directory-row:${rowIndex}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: gripId,
    data: { type: "row", rowIndex },
  });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };

  return (
    <div className="format-row" ref={setNodeRef} style={style}>
      <div className="format-row-main">
        <span className="format-row-grip" title="Drag to reorder folder levels" {...attributes} {...listeners}>
          &#8942;&#8942;
        </span>
        <RowBlocks
          section="directory"
          rowIndex={rowIndex}
          row={row}
          availableTags={BOOK_TAGS}
          onAddTag={onAddTag}
          onAddText={onAddText}
          onChangeChip={onChangeChip}
          onRemoveChip={onRemoveChip}
        />
      </div>
      <div className="format-row-controls">
        {removable && (
          <button type="button" className="btn btn-sm btn-ghost format-remove-row" title="Remove this folder level" onClick={onRemoveRow}>
            &times;
          </button>
        )}
      </div>
    </div>
  );
}

export function OutputFormatBuilder({
  value,
  onChange,
}: {
  value: OutputFormat;
  onChange: (next: OutputFormat) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const updateRow = (section: "directory" | "filename", rowIndex: number, row: FormatRow) => {
    if (section === "filename") {
      onChange({ ...value, filename: row });
    } else {
      const directory = value.directory.slice();
      directory[rowIndex] = row;
      onChange({ ...value, directory });
    }
  };

  const rowOf = (section: "directory" | "filename", rowIndex: number): FormatRow =>
    section === "filename" ? value.filename : value.directory[rowIndex]!;

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current as { type?: string; section?: "directory" | "filename"; rowIndex?: number };

    if (activeData.type === "row") {
      const overData = over.data.current as { type?: string; rowIndex?: number };
      if (overData?.type !== "row" || activeData.rowIndex === overData.rowIndex) return;
      onChange({ ...value, directory: arrayMove(value.directory, activeData.rowIndex!, overData.rowIndex!) });
      return;
    }

    // Chip drag: active/over ids are "section:rowIndex:blockIndex" or a
    // droppable row id "section:rowIndex" when dropped on an empty area.
    const [fromSection, fromRowStr, fromBlockStr] = String(active.id).split(":");
    const fromRow = Number(fromRowStr);
    const fromBlock = Number(fromBlockStr);
    const sourceRow = rowOf(fromSection as "directory" | "filename", fromRow);
    const moved = sourceRow[fromBlock];
    if (!moved) return;

    const overParts = String(over.id).split(":");
    const toSection = overParts[0] as "directory" | "filename";
    const toRow = Number(overParts[1]);
    const toBlock = overParts.length > 2 ? Number(overParts[2]) : undefined;

    if (fromSection === toSection && fromRow === toRow) {
      if (toBlock === undefined || toBlock === fromBlock) return;
      updateRow(toSection, toRow, arrayMove(sourceRow, fromBlock, toBlock));
      return;
    }

    // Moving between two different rows (possibly across directory/filename)
    // touches two row slots in one edit — both must land in a single
    // onChange, since two sequential onChange calls here would each start
    // from the same stale `value` closure and the first edit would be lost.
    const newSource = sourceRow.slice();
    newSource.splice(fromBlock, 1);
    const destRow = rowOf(toSection, toRow).slice();
    const insertAt = toBlock ?? destRow.length;
    destRow.splice(insertAt, 0, moved);

    const next: OutputFormat = { directory: value.directory.slice(), filename: value.filename };
    const setRow = (section: "directory" | "filename", rowIndex: number, row: FormatRow) => {
      if (section === "filename") next.filename = row;
      else next.directory[rowIndex] = row;
    };
    setRow(fromSection as "directory" | "filename", fromRow, newSource);
    setRow(toSection, toRow, destRow);
    onChange(next);
  };

  const preview = React.useMemo(() => {
    const segments = value.directory
      .map((row) => sanitizePreviewName(renderRowValue(row, PREVIEW_SAMPLE)))
      .filter((s) => s.length > 0);
    const dirPart = segments.length ? segments.join(" / ") : sanitizePreviewName(PREVIEW_SAMPLE.title) || `Book_${PREVIEW_SAMPLE.asin}`;
    const chapterValues = { ...PREVIEW_SAMPLE, ...PREVIEW_CHAPTER };
    const filenameRaw = renderRowValue(value.filename, chapterValues).trim();
    const filename = sanitizePreviewName(filenameRaw) || `${PREVIEW_CHAPTER.chapterNumber} - ${PREVIEW_CHAPTER.chapterName}`;
    return `${dirPart} / ${filename}.mp3`;
  }, [value]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="format-section">
        <label>
          Folder structure <span className="hint">(each level becomes one folder; empty levels — e.g. no series — are skipped)</span>
        </label>
        <div id="directory-rows">
          <SortableContext
            items={value.directory.map((_, i) => `directory-row:${i}`)}
            strategy={verticalListSortingStrategy}
          >
            {value.directory.map((row, i) => (
              <DirectoryRow
                key={`directory-row:${i}`}
                rowIndex={i}
                row={row}
                removable={value.directory.length > 1}
                onAddTag={(key) => updateRow("directory", i, [...row, { type: "tag", value: key }])}
                onAddText={() => updateRow("directory", i, [...row, { type: "text", value: " - " }])}
                onChangeChip={(blockIndex, text) => {
                  const next = row.slice();
                  next[blockIndex] = { type: "text", value: text };
                  updateRow("directory", i, next);
                }}
                onRemoveChip={(blockIndex) => {
                  const next = row.slice();
                  next.splice(blockIndex, 1);
                  updateRow("directory", i, next);
                }}
                onRemoveRow={() => onChange({ ...value, directory: value.directory.filter((_, j) => j !== i) })}
              />
            ))}
          </SortableContext>
        </div>
        <button
          type="button"
          id="add-folder-level"
          className="btn btn-sm btn-ghost"
          onClick={() => onChange({ ...value, directory: [...value.directory, []] })}
        >
          + Add folder level
        </button>
      </div>
      <div className="format-section">
        <label>Chapter filename</label>
        <div id="filename-row">
          <RowBlocks
            section="filename"
            rowIndex={0}
            row={value.filename}
            availableTags={ALL_TAGS}
            onAddTag={(key) => updateRow("filename", 0, [...value.filename, { type: "tag", value: key }])}
            onAddText={() => updateRow("filename", 0, [...value.filename, { type: "text", value: " - " }])}
            onChangeChip={(blockIndex, text) => {
              const next = value.filename.slice();
              next[blockIndex] = { type: "text", value: text };
              updateRow("filename", 0, next);
            }}
            onRemoveChip={(blockIndex) => {
              const next = value.filename.slice();
              next.splice(blockIndex, 1);
              updateRow("filename", 0, next);
            }}
          />
        </div>
      </div>
      <div className="format-section">
        <label>Preview</label>
        <div id="format-preview" className="format-preview" aria-live="polite">
          {preview}
        </div>
      </div>
    </DndContext>
  );
}
