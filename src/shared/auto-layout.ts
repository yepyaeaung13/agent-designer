import type { DesignNode } from './design';
import { solveGrid } from './grid-layout';
const sizeMode = (n: DesignNode, axis: 'width' | 'height') =>
  (n.layout ?? n.layoutItem)?.[axis === 'width' ? 'widthMode' : 'heightMode'] ??
  'FIXED';
const clamp = (n: DesignNode, axis: 'width' | 'height', size: number) => {
  const minimum = Math.max(
    1,
    n.layoutItem?.[axis === 'width' ? 'minWidth' : 'minHeight'] ?? 1,
  );
  const maximum = Math.min(
    10000,
    n.layoutItem?.[axis === 'width' ? 'maxWidth' : 'maxHeight'] ?? 10000,
  );
  if (minimum > maximum)
    throw Error(
      'Auto-layout size constraints exceed the supported node bounds.',
    );
  return Math.min(maximum, Math.max(minimum, size));
};

export type TextMeasurer = (
  node: DesignNode,
  axis: 'width' | 'height',
) => { width: number; height: number };
// Operates on the transaction's clone; the editor supplies font-backed measurement.
export function recalculateAutoLayout(
  nodes: DesignNode[],
  previous: DesignNode[] = nodes,
  measureText?: TextMeasurer,
) {
  const oldSizes = new Map(
    previous.map((n) => [n.id, { width: n.width, height: n.height }]),
  );
  const base = new Map(
    nodes.map((n) => [
      n.id,
      { x: n.x, y: n.y, width: n.width, height: n.height },
    ]),
  );
  const byId = new Map(nodes.map((n) => [n.id, n])),
    children = new Map<string, DesignNode[]>();
  for (const n of nodes)
    if (n.parentId) {
      const list = children.get(n.parentId) ?? [];
      list.push(n);
      children.set(n.parentId, list);
    }
  function solve(node: DesignNode, depth = 0, inFlow = false) {
    if (depth > 128)
      throw Error('Auto-layout nesting exceeds the supported depth.');
    const list = children.get(node.id) ?? [];
    if (!node.visible) return;
    if (inFlow && node.type === 'text' && measureText) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      const stretchedWidth =
        node.layoutItem?.align === 'STRETCH' &&
        parent?.layout?.direction === 'vertical';
      const stretchedHeight =
        node.layoutItem?.align === 'STRETCH' &&
        parent?.layout?.direction === 'horizontal';
      if (sizeMode(node, 'width') === 'HUG' && !stretchedWidth)
        node.width = clamp(node, 'width', measureText(node, 'width').width);
      if (sizeMode(node, 'height') === 'HUG' && !stretchedHeight)
        node.height = clamp(node, 'height', measureText(node, 'height').height);
    }
    const layout = node.layout;
    if (!layout?.enabled) {
      for (const child of list) solve(child, depth + 1);
      return;
    }
    if (!['horizontal', 'vertical', 'grid'].includes(layout.direction))
      throw Error('Live layout supports horizontal, vertical and grid frames.');
    if (node.locked || list.some((n) => n.visible && n.locked))
      throw Error(
        'Unlock the frame and its visible children before recalculating layout.',
      );
    if (node.rotation !== 0 || list.some((n) => n.visible && n.rotation !== 0))
      throw Error(
        'Rotated layers need saved positioning; disable live layout for this frame.',
      );
    if (layout.gap < 0 || Object.values(layout.padding).some((v) => v < 0))
      throw Error('Live layout requires nonnegative gaps and padding.');
    if (
      !['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'].includes(layout.justify) ||
      !['MIN', 'CENTER', 'MAX'].includes(layout.align)
    )
      throw Error('This layout alignment is not supported by the live engine.');
    const flow = list.filter(
      (n) => n.visible && n.layoutItem?.positioning !== 'absolute',
    );
    if (flow.some((n) => n.layoutItem?.positioning !== 'flow'))
      throw Error(
        'Recover or set child flow/absolute positioning before enabling live layout.',
      );
    const oldWidth = oldSizes.get(node.id)?.width ?? node.width,
      oldHeight = oldSizes.get(node.id)?.height ?? node.height;
    if (layout.direction === 'grid')
      solveGrid(
        node,
        flow,
        (child) => solve(child, depth + 1, true),
        clamp,
        sizeMode,
      );
    else {
      const horizontal = layout.direction === 'horizontal',
        main = horizontal ? 'width' : 'height',
        cross = horizontal ? 'height' : 'width';
      const mainStart = horizontal ? layout.padding.left : layout.padding.top,
        mainEnd = horizontal ? layout.padding.right : layout.padding.bottom;
      const crossStart = horizontal ? layout.padding.top : layout.padding.left,
        crossEnd = horizontal ? layout.padding.bottom : layout.padding.right;
      for (const axis of [main, cross] as const)
        if (
          sizeMode(node, axis) === 'HUG' &&
          flow.some(
            (n) =>
              sizeMode(n, axis) === 'FILL' ||
              (axis === cross && n.layoutItem?.align === 'STRETCH'),
          )
        )
          throw Error(
            'A hug axis cannot contain fill/stretch children on that same axis. Use a fixed parent size.',
          );
      if (layout.wrap && sizeMode(node, main) === 'HUG')
        throw Error('Wrapped layout needs a fixed or fill main-axis size.');
      for (const child of flow) {
        child.width = clamp(child, 'width', child.width);
        child.height = clamp(child, 'height', child.height);
        solve(child, depth + 1, true);
      }
      const settled = new Map(
        flow.map((n) => [n.id, { width: n.width, height: n.height }]),
      );
      let available = Math.max(0, node[main] - mainStart - mainEnd);
      const lines: DesignNode[][] = [[]];
      let occupied = 0;
      for (const child of flow) {
        const extent =
          sizeMode(child, main) === 'FILL'
            ? (child.layoutItem?.[
                main === 'width' ? 'minWidth' : 'minHeight'
              ] ?? 1)
            : child[main];
        const line = lines[lines.length - 1];
        if (
          layout.wrap &&
          line.length &&
          occupied + layout.gap + extent > available + 0.001
        ) {
          lines.push([child]);
          occupied = extent;
        } else {
          occupied += line.length ? layout.gap : 0;
          occupied += extent;
          line.push(child);
        }
      }
      if (!flow.length) lines.length = 0;
      const lineSizes: {
        nodes: DesignNode[];
        mainSize: number;
        crossSize: number;
      }[] = [];
      for (const line of lines) {
        const fill = line.filter((n) => sizeMode(n, main) === 'FILL');
        const fixed =
          line
            .filter((n) => !fill.includes(n))
            .reduce((sum, n) => sum + n[main], 0) +
          Math.max(0, line.length - 1) * layout.gap;
        // Water-fill constrained children: a capped item returns its remainder.
        let remaining = Math.max(0, available - fixed),
          pending = [...fill];
        while (pending.length) {
          const share = remaining / pending.length;
          const bounded = pending.filter(
            (n) => Math.abs(clamp(n, main, share) - share) > 0.0001,
          );
          if (!bounded.length) {
            for (const n of pending) n[main] = clamp(n, main, share);
            break;
          }
          for (const n of bounded) {
            n[main] = clamp(n, main, share);
            remaining = Math.max(0, remaining - n[main]);
          }
          pending = pending.filter((n) => !bounded.includes(n));
        }
        const crossAvailable = Math.max(1, node[cross] - crossStart - crossEnd);
        for (const child of line) {
          if (
            !layout.wrap &&
            (sizeMode(child, cross) === 'FILL' ||
              child.layoutItem?.align === 'STRETCH')
          )
            child[cross] = clamp(child, cross, crossAvailable);
          const done = settled.get(child.id)!;
          if (child.width !== done.width || child.height !== done.height)
            solve(child, depth + 1, true);
        }
        lineSizes.push({
          nodes: line,
          mainSize:
            line.reduce((sum, n) => sum + n[main], 0) +
            Math.max(0, line.length - 1) * layout.gap,
          crossSize: Math.max(0, ...line.map((n) => n[cross])),
        });
      }
      if (sizeMode(node, main) === 'HUG')
        node[main] = clamp(
          node,
          main,
          Math.max(0, ...lineSizes.map((l) => l.mainSize)) +
            mainStart +
            mainEnd,
        );
      const totalCross =
        lineSizes.reduce((sum, l) => sum + l.crossSize, 0) +
        Math.max(0, lineSizes.length - 1) * layout.gap;
      if (sizeMode(node, cross) === 'HUG')
        node[cross] = clamp(node, cross, totalCross + crossStart + crossEnd);
      available = Math.max(0, node[main] - mainStart - mainEnd);
      let crossCursor = crossStart;
      for (const line of lineSizes) {
        const free = Math.max(0, available - line.mainSize);
        let cursor =
          mainStart +
          (layout.justify === 'CENTER'
            ? free / 2
            : layout.justify === 'MAX'
              ? free
              : 0);
        const gap =
          layout.justify === 'SPACE_BETWEEN' && line.nodes.length > 1
            ? layout.gap + free / (line.nodes.length - 1)
            : layout.gap;
        const lineCross = layout.wrap
          ? line.crossSize
          : Math.max(0, node[cross] - crossStart - crossEnd);
        for (const child of line.nodes) {
          const align =
            child.layoutItem?.align === 'INHERIT' || !child.layoutItem?.align
              ? layout.align
              : child.layoutItem.align;
          if (
            layout.wrap &&
            (sizeMode(child, cross) === 'FILL' || align === 'STRETCH')
          ) {
            const beforeCross = child[cross];
            child[cross] = clamp(child, cross, lineCross);
            if (beforeCross !== child[cross]) solve(child, depth + 1, true);
          }
          const offset =
            align === 'CENTER'
              ? (lineCross - child[cross]) / 2
              : align === 'MAX'
                ? lineCross - child[cross]
                : 0;
          child[horizontal ? 'x' : 'y'] = cursor;
          child[horizontal ? 'y' : 'x'] = crossCursor + offset;
          cursor += child[main] + gap;
        }
        crossCursor += line.crossSize + layout.gap;
      }
    }
    for (const child of list.filter(
      (n) => n.visible && n.layoutItem?.positioning === 'absolute',
    )) {
      for (const [axis, pos, oldSize] of [
        ['width', 'x', oldWidth],
        ['height', 'y', oldHeight],
      ] as const) {
        const constraint =
            child.layoutItem?.constraints?.[
              axis === 'width' ? 'horizontal' : 'vertical'
            ],
          delta = node[axis] - oldSize;
        const original = base.get(child.id)!;
        if (constraint === 'end') child[pos] = original[pos] + delta;
        else if (constraint === 'center')
          child[pos] = original[pos] + delta / 2;
        else if (constraint === 'stretch')
          child[axis] = clamp(child, axis, original[axis] + delta);
        else if (constraint === 'scale') {
          child[pos] = (original[pos] * node[axis]) / oldSize;
          child[axis] = clamp(
            child,
            axis,
            (original[axis] * node[axis]) / oldSize,
          );
        }
      }
      solve(child, depth + 1);
    }
  }
  for (const root of nodes.filter((n) => !n.parentId || !byId.has(n.parentId)))
    solve(root);
}
