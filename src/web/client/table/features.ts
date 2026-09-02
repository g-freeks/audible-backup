import {
  tableFeatures,
  rowSortingFeature,
  createSortedRowModel,
  sortFn_alphanumeric,
  sortFn_basic,
  columnFilteringFeature,
  createFilteredRowModel,
  filterFn_includesString,
  filterFn_arrHas,
  filterFn_inNumberRange,
  filterFn_inDateRange,
  globalFilteringFeature,
  columnFacetingFeature,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFacetedMinMaxValues,
  columnVisibilityFeature,
  columnOrderingFeature,
  columnSizingFeature,
  rowSelectionFeature,
} from "@tanstack/react-table";

/** Every table feature the books table uses, registered explicitly (v9 is
 * tree-shakable — nothing ships that isn't listed here). See
 * node_modules/@tanstack/table-core/skills/table-features/SKILL.md. */
export const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },

  columnFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: {
    includesString: filterFn_includesString,
    arrHas: filterFn_arrHas,
    inNumberRange: filterFn_inNumberRange,
    inDateRange: filterFn_inDateRange,
  },

  globalFilteringFeature,

  columnFacetingFeature,
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
  facetedMinMaxValues: createFacetedMinMaxValues(),

  columnVisibilityFeature,
  columnOrderingFeature,
  columnSizingFeature,
  rowSelectionFeature,
});
