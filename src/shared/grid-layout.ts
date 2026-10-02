import type { DesignNode } from './design';
import type { z } from 'zod';
import type { gridTrackSchema } from './grid';
type Axis = 'width' | 'height';
type Track = z.infer<typeof gridTrackSchema>;
export function solveGrid(
  node: DesignNode,
  flow: DesignNode[],
  solve: (child: DesignNode) => void,
  clamp: (node: DesignNode, axis: Axis, size: number) => number,
  mode: (node: DesignNode, axis: Axis) => string,
) {
  const layout = node.layout!,
    grid = layout.grid;
  if (!grid)
    throw Error(
      'Grid tracks are missing. Define rows and columns before enabling live layout.',
    );
  if (layout.wrap || layout.align !== 'MIN' || layout.justify !== 'MIN')
    throw Error(
      'Grid uses explicit tracks and cell alignment; container wrap/distribution is unsupported.',
    );
  const occupied = new Set<string>(),
    cells = new Map<
      string,
      { row: number; column: number; rowSpan: number; columnSpan: number }
    >();
  const settled = new Map<string, { width: number; height: number }>();
  const resolve = (child: DesignNode) => {
    const before = settled.get(child.id);
    if (
      !before ||
      before.width !== child.width ||
      before.height !== child.height
    )
      solve(child);
    settled.set(child.id, { width: child.width, height: child.height });
  };
  function reserve(
    child: DesignNode,
    cell: { row: number; column: number; rowSpan: number; columnSpan: number },
  ) {
    if (
      cell.row + cell.rowSpan > grid!.rows.length ||
      cell.column + cell.columnSpan > grid!.columns.length
    )
      throw Error('A grid cell extends beyond the defined tracks.');
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++)
      for (let c = cell.column; c < cell.column + cell.columnSpan; c++) {
        const key = `${r}:${c}`;
        if (occupied.has(key)) throw Error('Grid cell placements overlap.');
        occupied.add(key);
      }
    cells.set(child.id, cell);
  }
  for (const child of flow)
    if (child.layoutItem?.grid) reserve(child, child.layoutItem.grid);
  for (const child of flow)
    if (!cells.has(child.id)) {
      let found = false;
      for (let r = 0; r < grid.rows.length && !found; r++)
        for (let c = 0; c < grid.columns.length; c++)
          if (!occupied.has(`${r}:${c}`)) {
            reserve(child, { row: r, column: c, rowSpan: 1, columnSpan: 1 });
            found = true;
            break;
          }
      if (!found)
        throw Error(
          'The grid has no free cells. Add tracks or set explicit placement.',
        );
    }
  for (const child of flow) {
    child.width = clamp(child, 'width', child.width);
    child.height = clamp(child, 'height', child.height);
    resolve(child);
  }
  function tracks(
    axis: Axis,
    definitions: Track[],
    gap: number,
    start: number,
    end: number,
  ) {
    if (
      mode(node, axis) === 'HUG' &&
      definitions.some((t) => t.mode === 'FILL')
    )
      throw Error('A hug grid axis cannot contain fill tracks.');
    const sizes = definitions.map((t) =>
      t.mode === 'FIXED' ? t.value : t.mode === 'HUG' ? 1 : 0,
    );
    for (const child of flow) {
      const cell = cells.get(child.id)!,
        index = axis === 'width' ? cell.column : cell.row,
        span = axis === 'width' ? cell.columnSpan : cell.rowSpan;
      const subset = definitions.slice(index, index + span);
      if (subset.some((t) => t.mode === 'HUG')) {
        if (span !== 1)
          throw Error(
            'Spanning hug tracks are not supported yet. Use fixed or fill tracks.',
          );
        if (mode(child, axis) === 'FILL')
          throw Error(
            'Fill children cannot determine a hug grid track on the same axis.',
          );
        sizes[index] = Math.max(sizes[index], child[axis]);
      }
    }
    if (mode(node, axis) === 'HUG')
      node[axis] = clamp(
        node,
        axis,
        sizes.reduce((a, b) => a + b, 0) +
          gap * (sizes.length - 1) +
          start +
          end,
      );
    const totalWeight = definitions.reduce(
      (sum, t) => sum + (t.mode === 'FILL' ? t.value : 0),
      0,
    );
    const remaining = Math.max(
      0,
      node[axis] -
        start -
        end -
        gap * (sizes.length - 1) -
        sizes.reduce((a, b) => a + b, 0),
    );
    return definitions.map((t, i) =>
      t.mode === 'FILL'
        ? Math.max(1, (remaining * t.value) / totalWeight)
        : Math.max(1, sizes[i]),
    );
  }
  const columns = tracks(
    'width',
    grid.columns,
    grid.columnGap,
    layout.padding.left,
    layout.padding.right,
  );
  const extent = (sizes: number[], index: number, span: number, gap: number) =>
    sizes.slice(index, index + span).reduce((a, b) => a + b, 0) +
    gap * (span - 1);
  for (const child of flow) {
    const cell = cells.get(child.id)!;
    if (mode(child, 'width') === 'FILL')
      child.width = clamp(
        child,
        'width',
        extent(columns, cell.column, cell.columnSpan, grid.columnGap),
      );
    resolve(child);
  }
  const rows = tracks(
    'height',
    grid.rows,
    grid.rowGap,
    layout.padding.top,
    layout.padding.bottom,
  );
  const offset = (align: string | undefined, available: number, size: number) =>
    align === 'CENTER'
      ? (available - size) / 2
      : align === 'MAX'
        ? available - size
        : 0;
  for (const child of flow) {
    const cell = cells.get(child.id)!,
      width = extent(columns, cell.column, cell.columnSpan, grid.columnGap),
      height = extent(rows, cell.row, cell.rowSpan, grid.rowGap);
    if (mode(child, 'height') === 'FILL')
      child.height = clamp(child, 'height', height);
    resolve(child);
    child.x =
      layout.padding.left +
      columns.slice(0, cell.column).reduce((a, b) => a + b, 0) +
      grid.columnGap * cell.column +
      offset(child.layoutItem?.grid?.horizontalAlign, width, child.width);
    child.y =
      layout.padding.top +
      rows.slice(0, cell.row).reduce((a, b) => a + b, 0) +
      grid.rowGap * cell.row +
      offset(child.layoutItem?.grid?.verticalAlign, height, child.height);
  }
}
