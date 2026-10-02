import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, type DesignNode } from '../src/shared/design';
import { recalculateAutoLayout } from '../src/shared/auto-layout';
import {
  importedGrid,
  importedLayoutItem,
} from '../src/main/layout-item-import';
import { DocumentService } from '../src/main/document-service';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { importFigmaBundle } from '../src/main/figma-bundle';
import { getLayoutContext } from '../src/main/layout-context';
import { png } from './fixtures/figma.cjs';
const layout = {
  enabled: true,
  direction: 'grid' as const,
  gap: 0,
  padding: { top: 10, right: 10, bottom: 10, left: 10 },
  align: 'MIN',
  justify: 'MIN',
  widthMode: 'FIXED',
  heightMode: 'FIXED',
  wrap: false,
};
test('plugin fills omitted grid properties and its bundle persists tracks/cells into layout handoff', async () => {
  const childRaw = {
    id: '1:2',
    name: 'Grid child',
    type: 'RECTANGLE',
    absoluteBoundingBox: { x: 10, y: 10, width: 80, height: 20 },
  };
  const raw = {
    id: '1:1',
    name: 'Grid import',
    type: 'FRAME',
    layoutMode: 'GRID',
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
    children: [childRaw],
  };
  const liveChild = {
    id: childRaw.id,
    gridRowAnchorIndex: 0,
    gridColumnAnchorIndex: 0,
    gridRowSpan: 1,
    gridColumnSpan: 1,
    gridChildHorizontalAlign: 'MIN',
    gridChildVerticalAlign: 'MIN',
  };
  const selected = {
    id: raw.id,
    name: raw.name,
    type: 'FRAME',
    layoutMode: 'GRID',
    width: 200,
    height: 100,
    gridColumnSizes: [{ type: 'FIXED', value: 80 }],
    gridRowSizes: [{ type: 'HUG' }],
    gridColumnGap: 8,
    gridRowGap: 4,
    children: [liveChild],
    exportAsync: async (options: { format: string }) =>
      options.format === 'JSON_REST_V1'
        ? { document: structuredClone(raw) }
        : png,
  };
  Object.assign(liveChild, { parent: selected });
  const messages: any[] = [];
  const figma = {
    showUI() {},
    currentPage: { selection: [selected] },
    fileKey: '',
    ui: {
      onmessage: async (_input: unknown) => {},
      postMessage: (message: unknown) => messages.push(message),
    },
    base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  };
  vm.runInNewContext(readFileSync('figma-plugin/code.js', 'utf8'), {
    figma,
    __html__: '',
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  await figma.ui.onmessage({
    type: 'export',
    requestId: 'grid',
    compactPreview: true,
  } as never);
  const ready = messages.find((m) => m.type === 'ready');
  assert(ready, JSON.stringify(messages));
  const service = new DocumentService(':memory:');
  try {
    const snapshot = importFigmaBundle(service, Buffer.from(ready.json));
    const doc = snapshot.document,
      root = doc.pages[0].nodes[0],
      child = doc.pages[0].nodes[1];
    assert.equal(root.layout?.enabled, undefined);
    assert.equal(root.layout?.grid?.columns[0].mode, 'FIXED');
    assert.equal(child.layoutItem?.grid?.column, 0);
    assert.equal(child.x, 10);
    const context = getLayoutContext(service, {
      documentId: doc.id,
      pageId: doc.pages[0].id,
      nodeId: root.id,
      expectedRevision: doc.revision,
    });
    assert.equal(
      context.frames[0].cssHints.container.gridTemplateColumns,
      '80px',
    );
    assert.equal(context.frames[0].cssHints.container.rowGap, 4);
  } finally {
    service.close();
  }
});
const child = (root: DesignNode): DesignNode => ({
  ...makeNode('rectangle'),
  parentId: root.id,
  width: 20,
  height: 20,
  layoutItem: { positioning: 'flow', widthMode: 'FILL', heightMode: 'FILL' },
});
test('mixed weighted tracks, spans and row-major placement recalculate without moving absolute layers', () => {
  const root: DesignNode = {
    ...makeNode('frame'),
    width: 320,
    height: 160,
    layout: {
      ...layout,
      grid: {
        columns: [
          { mode: 'FIXED', value: 80 },
          { mode: 'FILL', value: 1 },
          { mode: 'FILL', value: 2 },
        ],
        rows: [
          { mode: 'FIXED', value: 30 },
          { mode: 'FILL', value: 1 },
        ],
        columnGap: 10,
        rowGap: 5,
      },
    },
  };
  const a = child(root),
    b = child(root),
    c = child(root),
    overlay = {
      ...child(root),
      x: 7,
      y: 9,
      layoutItem: { positioning: 'absolute' as const },
    };
  b.layoutItem!.grid = { row: 0, column: 1, rowSpan: 2, columnSpan: 2 };
  recalculateAutoLayout([root, a, b, c, overlay]);
  assert.equal(a.width, 80);
  assert.equal(a.height, 30);
  assert.equal(b.x, 100);
  assert.equal(b.width, 210);
  assert.equal(b.height, 140);
  assert.equal(c.y, 45);
  assert.equal(c.height, 105);
  assert.equal(overlay.x, 7);
  assert.equal(overlay.y, 9);
  root.width = 380;
  recalculateAutoLayout([root, a, b, c, overlay]);
  assert.equal(b.width, 270);
});
test('hug rows use wrapped text at assigned column width and update parent height', () => {
  const root: DesignNode = {
    ...makeNode('frame'),
    width: 220,
    layout: {
      ...layout,
      heightMode: 'HUG',
      grid: {
        columns: [{ mode: 'FILL', value: 1 }],
        rows: [{ mode: 'HUG' }, { mode: 'HUG' }],
        columnGap: 0,
        rowGap: 8,
      },
    },
  };
  const text: DesignNode = {
      ...child(root),
      type: 'text',
      text: 'x'.repeat(30),
      layoutItem: { positioning: 'flow', widthMode: 'FILL', heightMode: 'HUG' },
    },
    next = {
      ...child(root),
      layoutItem: {
        positioning: 'flow' as const,
        widthMode: 'FIXED' as const,
        heightMode: 'FIXED' as const,
      },
    };
  const measure = (n: DesignNode) => ({
    width: n.text.length * 10,
    height: Math.ceil((n.text.length * 10) / n.width) * 20,
  });
  recalculateAutoLayout([root, text, next], undefined, measure);
  assert.equal(text.height, 40);
  assert.equal(next.y, 58);
  assert.equal(root.height, 88);
  root.width = 120;
  recalculateAutoLayout([root, text, next], undefined, measure);
  assert.equal(text.height, 60);
  assert.equal(root.height, 108);
});
test('grid import translates valid tracks and zero-based cells while rejecting unsafe or missing fields', () => {
  const raw = {
    layoutMode: 'GRID',
    gridColumnSizes: [
      { type: 'FIXED', value: 80 },
      { type: 'FLEX', value: 2 },
    ],
    gridRowSizes: [{ type: 'HUG' }],
    gridColumnGap: 8,
    gridRowGap: 4,
  };
  assert.deepEqual(importedGrid(raw)?.columns, [
    { mode: 'FIXED', value: 80 },
    { mode: 'FILL', value: 2 },
  ]);
  assert.equal(
    importedLayoutItem(
      {
        gridColumnAnchorIndex: 1,
        gridRowAnchorIndex: 0,
        gridColumnSpan: 1,
        gridChildHorizontalAlign: 'CENTER',
      },
      raw,
    )?.grid?.column,
    1,
  );
  assert.equal(
    importedGrid({
      ...raw,
      gridColumnSizes: [{ type: 'url(evil)', value: 1 }],
    }),
    undefined,
  );
  assert.equal(importedGrid({ layoutMode: 'GRID' }), undefined);
});
test('overlapping placements and unsupported cycles reject atomically; resize undo restores tracks and geometry', () => {
  const service = new DocumentService(':memory:');
  try {
    const initial = service.read().document,
      documentId = initial.id,
      pageId = initial.pages[0].id;
    const run = (command: unknown) =>
      service.execute({
        documentId,
        pageId,
        expectedRevision: service.read().document.revision,
        command,
      }).document;
    const root: DesignNode = {
        ...makeNode('frame'),
        width: 200,
        height: 100,
        layout: {
          ...layout,
          enabled: false,
          grid: {
            columns: [
              { mode: 'FILL', value: 1 },
              { mode: 'FILL', value: 1 },
            ],
            rows: [{ mode: 'FILL', value: 1 }],
            columnGap: 10,
            rowGap: 0,
          },
        },
      },
      a = child(root),
      b = child(root);
    run({ type: 'create', node: root });
    run({ type: 'create', node: a });
    run({ type: 'create', node: b });
    const enabled = run({
      type: 'set_auto_layout',
      id: root.id,
      enabled: true,
    });
    run({ type: 'update', id: root.id, patch: { width: 300 } });
    assert.deepEqual(run({ type: 'undo' }).pages, enabled.pages);
    run({
      type: 'update',
      id: a.id,
      patch: {
        layoutItem: {
          ...a.layoutItem,
          grid: { row: 0, column: 0, rowSpan: 1, columnSpan: 1 },
        },
      },
    });
    const stable = service.read().document;
    assert.throws(
      () =>
        run({
          type: 'update',
          id: b.id,
          patch: {
            layoutItem: {
              ...b.layoutItem,
              grid: { row: 0, column: 0, rowSpan: 1, columnSpan: 1 },
            },
          },
        }),
      /overlap/,
    );
    assert.deepEqual(service.read().document, stable);
    assert.throws(
      () =>
        run({
          type: 'update',
          id: root.id,
          patch: {
            layout: { ...root.layout, widthMode: 'HUG', enabled: true },
          },
        }),
      /hug grid axis/,
    );
    assert.deepEqual(service.read().document, stable);
  } finally {
    service.close();
  }
});
