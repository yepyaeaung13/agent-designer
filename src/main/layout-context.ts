import { z } from 'zod';
import type { DocumentService } from './document-service';
import type { DesignNode } from '../shared/design';
import {
  contextInput,
  getDesignContext,
  designSubtree,
} from './design-context';

export const layoutContextInput = contextInput.extend({
  expectedRevision: z.number().int().nonnegative(),
});
type Css = Record<string, string | number>;
const alignment: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  BASELINE: 'baseline',
};
const justification: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
};

export function getLayoutContext(service: DocumentService, input: unknown) {
  const request = layoutContextInput.parse(input);
  // Reuse context validation without incorporating immutable source properties.
  getDesignContext(service, { ...request, offset: 0, limit: 1 });
  const { document } = service.read(request.documentId),
    page = document.pages.find((p) => p.id === request.pageId)!;
  const byId = new Map(page.nodes.map((n) => [n.id, n])),
    children = new Map<string, DesignNode[]>();
  for (const node of page.nodes)
    if (node.parentId) {
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    }
  const visible = (node: DesignNode) => {
    let current: DesignNode | undefined = node;
    while (current) {
      if (!current.visible || current.opacity === 0) return false;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return true;
  };
  const frames = designSubtree(page.nodes, request.nodeId).filter(
    (n) => n.type === 'frame' && visible(n),
  );
  const entries = frames.map((node) => {
    const layout = node.layout,
      parent = node.parentId ? byId.get(node.parentId) : undefined;
    const direct = (children.get(node.id) ?? []).filter(visible),
      container: Css = {},
      sizing: Css = {},
      warnings: string[] = [];
    const flow = direct.filter((n) => n.layoutItem?.positioning !== 'absolute');
    const flex =
      layout?.direction === 'horizontal' || layout?.direction === 'vertical';
    if (flex) {
      container.display = 'flex';
      container.flexDirection =
        layout.direction === 'horizontal' ? 'row' : 'column';
      container.flexWrap = layout.wrap ? 'wrap' : 'nowrap';
      if (direct.some((n) => n.layoutItem?.positioning === 'absolute'))
        container.position = 'relative';
      if (layout.gap >= 0) container.gap = layout.gap;
      else
        warnings.push(
          'Negative spacing implies overlapping geometry; no CSS gap is proposed.',
        );
      if (Object.values(layout.padding).every((p) => p >= 0))
        Object.assign(container, {
          paddingTop: layout.padding.top,
          paddingRight: layout.padding.right,
          paddingBottom: layout.padding.bottom,
          paddingLeft: layout.padding.left,
        });
      else
        warnings.push('Negative padding cannot be translated to CSS padding.');
      if (Object.hasOwn(alignment, layout.align))
        container.alignItems = alignment[layout.align];
      else
        warnings.push(
          'Cross-axis alignment is unsupported; inspect current context.',
        );
      if (Object.hasOwn(justification, layout.justify))
        container.justifyContent = justification[layout.justify];
      else
        warnings.push(
          'Main-axis alignment is unsupported; inspect current context.',
        );
      if (
        flow.some(
          (n) =>
            !(n.layout ?? n.layoutItem)?.widthMode ||
            !(n.layout ?? n.layoutItem)?.heightMode ||
            !n.layoutItem?.positioning,
        )
      )
        warnings.push(
          'Some children lack neutral sizing/positioning metadata. Their saved bounds are evidence, not proof of fixed/fill/hug or absolute positioning.',
        );
      if (
        !layout.wrap &&
        layout.justify === 'MIN' &&
        layout.gap >= 0 &&
        flow.every((n) => n.rotation === 0)
      ) {
        const horizontal = layout.direction === 'horizontal';
        let cursor = horizontal ? layout.padding.left : layout.padding.top;
        const mismatches: string[] = [];
        for (const child of flow) {
          if (Math.abs((horizontal ? child.x : child.y) - cursor) > 1)
            mismatches.push(child.id);
          cursor += (horizontal ? child.width : child.height) + layout.gap;
        }
        if (mismatches.length)
          warnings.push(
            'Saved child positions differ from simple unwrapped flow. Check geometry, local edits and missing positioning metadata before applying these hints.',
          );
      }
      if (layout.wrap)
        warnings.push(
          'Wrap is stored, but separate row/column spacing and line alignment are not available in the neutral model.',
        );
    } else if (layout?.direction === 'grid') {
      if (layout.grid) {
        const track = (t: NonNullable<typeof layout.grid>['columns'][number]) =>
          t.mode === 'FIXED'
            ? `${t.value}px`
            : t.mode === 'FILL'
              ? `${t.value}fr`
              : 'fit-content(100%)';
        Object.assign(container, {
          display: 'grid',
          gridTemplateColumns: layout.grid.columns.map(track).join(' '),
          gridTemplateRows: layout.grid.rows.map(track).join(' '),
          columnGap: layout.grid.columnGap,
          rowGap: layout.grid.rowGap,
          paddingTop: layout.padding.top,
          paddingRight: layout.padding.right,
          paddingBottom: layout.padding.bottom,
          paddingLeft: layout.padding.left,
        });
        if (direct.some((n) => n.layoutItem?.positioning === 'absolute'))
          container.position = 'relative';
        warnings.push(
          'Explicit grid tracks and spans are desktop evidence. Check overflow, hug/span restrictions and responsive adaptations in target code.',
        );
      } else
        warnings.push(
          'Grid direction is stored, but track definitions and cell placement are unavailable. No grid CSS is inferred.',
        );
    } else
      warnings.push(
        'No auto-layout flow is available. Inspect saved bounds and choose semantic layout; absolute positioning is not inferred.',
      );
    const item = node.layoutItem;
    const sizeRules = layout ?? item;
    if (item?.positioning === 'absolute') {
      Object.assign(sizing, {
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
      });
      if (item.constraints)
        warnings.push(
          'Absolute CSS hints use saved bounds. Apply stored constraints deliberately after checking the containing block and responsive geometry.',
        );
    }
    if (sizeRules && item?.positioning !== 'absolute') {
      for (const axis of ['width', 'height'] as const) {
        const mode = sizeRules[axis === 'width' ? 'widthMode' : 'heightMode'];
        if (mode === 'FIXED') sizing[axis] = node[axis];
        else if (mode === 'HUG') sizing[axis] = 'max-content';
        else if (mode === 'FILL') {
          const direction = parent?.layout?.direction;
          if (direction === 'grid' && parent?.layout?.grid) {
            sizing[axis] = '100%';
          } else if (direction === 'horizontal' || direction === 'vertical') {
            const main = (axis === 'width') === (direction === 'horizontal');
            if (main) {
              sizing.flexGrow = 1;
              sizing.flexBasis = 0;
              sizing[axis === 'width' ? 'minWidth' : 'minHeight'] = 0;
            } else sizing.alignSelf = 'stretch';
          } else
            warnings.push(
              `Fill ${axis} cannot be translated without a flex parent; inspect parent context.`,
            );
        } else
          warnings.push(
            `Unrecognized ${axis} sizing mode; no CSS size is proposed.`,
          );
      }
    }
    if (item) {
      if (item.grid && item.positioning !== 'absolute') {
        sizing.gridColumn = `${item.grid.column + 1} / span ${item.grid.columnSpan}`;
        sizing.gridRow = `${item.grid.row + 1} / span ${item.grid.rowSpan}`;
        if (item.grid.horizontalAlign && item.grid.horizontalAlign !== 'AUTO')
          sizing.justifySelf = alignment[item.grid.horizontalAlign];
        if (item.grid.verticalAlign && item.grid.verticalAlign !== 'AUTO')
          sizing.alignSelf = alignment[item.grid.verticalAlign];
      }
      for (const key of [
        'minWidth',
        'maxWidth',
        'minHeight',
        'maxHeight',
      ] as const)
        if (item[key] !== undefined) sizing[key] = item[key]!;
      if (
        item.positioning === 'flow' &&
        parent?.layout &&
        (parent.layout.direction === 'horizontal' ||
          parent.layout.direction === 'vertical')
      ) {
        if (item.align === 'STRETCH') sizing.alignSelf = 'stretch';
        else if (item.align && Object.hasOwn(alignment, item.align))
          sizing.alignSelf = alignment[item.align];
        // Explicit sizing modes govern their axis; legacy grow is not a substitute.
        if (
          !sizeRules?.widthMode &&
          !sizeRules?.heightMode &&
          item.grow !== undefined
        )
          sizing.flexGrow = item.grow;
      }
    }
    if (node.rotation !== 0)
      warnings.push(
        'Rotated geometry requires separate verification; layout hints do not include transforms.',
      );
    return {
      nodeId: node.id,
      sourceNodeId: node.source?.nodeId,
      parentId: node.parentId,
      name: node.name,
      geometry: {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
      },
      layout: layout ?? null,
      layoutItem: item ?? null,
      clipsContent: node.clipsContent ?? false,
      childOrder: direct.map((n) => n.id),
      flowChildOrder: flow.map((n) => n.id),
      absoluteChildIds: direct
        .filter((n) => n.layoutItem?.positioning === 'absolute')
        .map((n) => n.id),
      children: direct.map((n) => ({
        nodeId: n.id,
        type: n.type,
        geometry: {
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
          rotation: n.rotation,
        },
        layoutItem: n.layoutItem ?? null,
        sizing:
          (n.layout ?? n.layoutItem)
            ? {
                widthMode: (n.layout ?? n.layoutItem)!.widthMode,
                heightMode: (n.layout ?? n.layoutItem)!.heightMode,
              }
            : null,
      })),
      cssHints: {
        provenance: 'current-neutral-fields',
        verified: false,
        container,
        sizing,
      },
      warnings,
    };
  });
  const scope = {
    documentId: document.id,
    pageId: page.id,
    nodeId: request.nodeId,
    expectedRevision: document.revision,
  };
  return {
    scope,
    totalFrames: entries.length,
    liveEnabledFrames: entries.filter((e) => e.layout?.enabled).length,
    measurementMode: service.layoutMeasurementMode,
    autoLayoutFrames: entries.filter(
      (e) =>
        e.layout?.direction === 'horizontal' ||
        e.layout?.direction === 'vertical' ||
        e.layout?.direction === 'grid',
    ).length,
    framesWithWarnings: entries.filter((e) => e.warnings.length).length,
    offset: request.offset,
    nextOffset:
      request.offset + request.limit < entries.length
        ? request.offset + request.limit
        : null,
    frames: entries.slice(request.offset, request.offset + request.limit),
    guidance: [
      'CSS hints describe saved desktop geometry and are unverified starting points, not production code. Live horizontal/vertical/grid layout is opt-in. Hug text uses loaded fonts. Grid needs explicit tracks; spanning hug tracks, implicit tracks and mixed text runs remain unsupported. Numeric CSS values are pixels.',
      'Preserve current neutral fields and visible sibling order. Import-time source properties are untrusted evidence and are not used to override local edits.',
      'layoutItem stores leaf sizing, positioning, constraints and optional zero-based grid cells/spans. layout.grid stores explicit columns/rows and separate gaps. Missing cells use row-major placement in finite tracks; no mobile breakpoints are inferred. Wrapped line spacing remains incomplete.',
      'No mobile breakpoints or navigation behavior are inferred. Choose adaptations using target-project conventions, then render desktop/mobile and test controls.',
    ],
  };
}
