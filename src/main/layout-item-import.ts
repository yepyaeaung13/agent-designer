import { layoutItemSchema, type LayoutItem } from '../shared/layout-item';
import type { DesignNode } from '../shared/design';
import { gridSchema, gridCellSchema } from '../shared/grid';
export function importedGrid(raw: Record<string, unknown>) {
  if (raw.layoutMode !== 'GRID') return undefined;
  const tracks = (input: unknown) =>
    Array.isArray(input)
      ? input.map((t) => {
          const track = t as { type?: unknown; value?: unknown };
          return track?.type === 'HUG'
            ? { mode: 'HUG' }
            : track?.type === 'FLEX'
              ? { mode: 'FILL', value: track.value ?? 1 }
              : { mode: track?.type, value: track?.value };
        })
      : undefined;
  const result = gridSchema.safeParse({
    columns: tracks(raw.gridColumnSizes),
    rows: tracks(raw.gridRowSizes),
    columnGap: raw.gridColumnGap,
    rowGap: raw.gridRowGap,
  });
  return result.success ? result.data : undefined;
}
function importedGridCell(raw: Record<string, unknown>) {
  const result = gridCellSchema.safeParse({
    row: raw.gridRowAnchorIndex,
    column: raw.gridColumnAnchorIndex,
    rowSpan: raw.gridRowSpan ?? 1,
    columnSpan: raw.gridColumnSpan ?? 1,
    horizontalAlign: raw.gridChildHorizontalAlign,
    verticalAlign: raw.gridChildVerticalAlign,
  });
  return result.success ? result.data : undefined;
}

export function importedLayoutItem(
  raw: Record<string, unknown>,
  parent?: Record<string, unknown> | null,
  frame = false,
) {
  const item: LayoutItem = {};
  if (parent?.layoutMode === 'GRID') item.grid = importedGridCell(raw);
  const mode = (value: unknown) =>
    value === 'FIXED' || value === 'HUG' || value === 'FILL'
      ? value
      : undefined;
  if (!frame) {
    item.widthMode = mode(raw.layoutSizingHorizontal);
    item.heightMode = mode(raw.layoutSizingVertical);
  }
  const auto =
    parent?.layoutMode === 'HORIZONTAL' ||
    parent?.layoutMode === 'VERTICAL' ||
    parent?.layoutMode === 'GRID';
  if (raw.layoutPositioning === 'ABSOLUTE') item.positioning = 'absolute';
  else if (
    raw.layoutPositioning === 'AUTO' ||
    (raw.layoutPositioning === undefined && auto)
  )
    item.positioning = 'flow';
  if (
    typeof raw.layoutAlign === 'string' &&
    ['INHERIT', 'STRETCH', 'MIN', 'CENTER', 'MAX'].includes(raw.layoutAlign)
  )
    item.align = raw.layoutAlign as LayoutItem['align'];
  if (
    typeof raw.layoutGrow === 'number' &&
    Number.isFinite(raw.layoutGrow) &&
    raw.layoutGrow >= 0 &&
    raw.layoutGrow <= 1
  )
    item.grow = raw.layoutGrow;
  for (const axis of ['Width', 'Height'] as const) {
    const min = raw[`min${axis}`],
      max = raw[`max${axis}`];
    if (typeof min === 'number' && Number.isFinite(min) && min >= 0)
      item[`min${axis}`] = min;
    if (typeof max === 'number' && Number.isFinite(max) && max >= 0)
      item[`max${axis}`] = max;
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      delete item[`min${axis}`];
      delete item[`max${axis}`];
    }
  }
  const constraints = raw.constraints;
  if (
    constraints &&
    typeof constraints === 'object' &&
    !Array.isArray(constraints)
  ) {
    const source = constraints as Record<string, unknown>;
    const translate = (value: unknown, axis: 'horizontal' | 'vertical') => {
      if (value === 'MIN' || value === (axis === 'horizontal' ? 'LEFT' : 'TOP'))
        return 'start';
      if (
        value === 'MAX' ||
        value === (axis === 'horizontal' ? 'RIGHT' : 'BOTTOM')
      )
        return 'end';
      if (value === 'CENTER') return 'center';
      if (
        value === 'STRETCH' ||
        value === (axis === 'horizontal' ? 'LEFT_RIGHT' : 'TOP_BOTTOM')
      )
        return 'stretch';
      if (value === 'SCALE') return 'scale';
      return undefined;
    };
    const horizontal = translate(source.horizontal, 'horizontal'),
      vertical = translate(source.vertical, 'vertical');
    if (horizontal || vertical)
      item.constraints = {
        ...(horizontal ? { horizontal } : {}),
        ...(vertical ? { vertical } : {}),
      };
  }
  const compact = Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined),
  );
  return Object.keys(compact).length
    ? layoutItemSchema.parse(compact)
    : undefined;
}

// Explicit recovery only. Missing blocks can be restored, but existing neutral
// metadata, edits, geometry, layout modes, names and text are never overwritten.
export function recoverLayoutItems(
  nodes: DesignNode[],
  rootId: string,
  source: unknown,
  sourceRootId?: string,
) {
  if (!nodes.some((n) => n.id === rootId))
    throw Error('Node not found on this page.');
  const ids = new Set([rootId]);
  let count = 0;
  while (count !== ids.size) {
    count = ids.size;
    for (const node of nodes)
      if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
  }
  const original = new Map<
    string,
    { node: Record<string, unknown>; parent: Record<string, unknown> | null }
  >();
  const data = source as {
    response?: { nodes?: Record<string, { document?: unknown }> };
  } | null;
  function visit(
    value: unknown,
    parent: Record<string, unknown> | null,
    depth = 0,
  ) {
    if (
      depth > 64 ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      return;
    const node = value as Record<string, unknown>;
    if (typeof node.id === 'string') original.set(node.id, { node, parent });
    if (Array.isArray(node.children))
      for (const child of node.children) visit(child, node, depth + 1);
  }
  if (sourceRootId)
    visit(data?.response?.nodes?.[sourceRootId]?.document, null);
  let recovered = 0;
  for (const node of nodes)
    if (
      ids.has(node.id) &&
      !node.locked &&
      node.layout?.direction === 'grid' &&
      !node.layout.grid &&
      node.source
    ) {
      const raw = original.get(node.source.nodeId);
      const grid = raw && importedGrid(raw.node);
      if (grid) {
        node.layout.grid = grid;
        recovered++;
      }
    }
  for (const node of nodes) {
    if (
      !ids.has(node.id) ||
      node.locked ||
      node.layoutItem !== undefined ||
      !node.source
    )
      continue;
    const raw = original.get(node.source.nodeId);
    if (!raw) continue;
    const item = importedLayoutItem(
      raw.node,
      raw.parent,
      node.type === 'frame',
    );
    if (item) {
      node.layoutItem = item;
      recovered++;
    }
  }
  return recovered;
}
