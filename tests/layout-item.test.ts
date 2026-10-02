function execute(service: DocumentService, input: Record<string, unknown>) {
  const { nodeId: _nodeId, ...request } = input;
  return service.execute(request);
}
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { layoutItemSchema } from '../src/shared/layout-item';
import { normalizeFigma } from '../src/main/figma-import';
import { importedLayoutItem } from '../src/main/layout-item-import';
import { DocumentService } from '../src/main/document-service';
import { getLayoutContext } from '../src/main/layout-context';
import { getDesignContext } from '../src/main/design-context';
import { getCodingBrief } from '../src/main/coding-brief';
import { getDesignChanges } from '../src/main/design-changes';
import { png } from './fixtures/figma.cjs';
const previewId = createHash('sha256').update(png).digest('hex');
function fixture() {
  const raw = {
    id: '1:1',
    name: 'Root',
    type: 'FRAME',
    layoutMode: 'HORIZONTAL',
    constraints: { horizontal: 'LEFT', vertical: 'TOP' },
    absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 300 },
    children: [
      {
        id: '1:2',
        name: 'Text',
        type: 'TEXT',
        characters: 'Current text',
        layoutSizingHorizontal: 'FILL',
        layoutSizingVertical: 'HUG',
        constraints: { horizontal: 'LEFT_RIGHT', vertical: 'TOP' },
        absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 60 },
      },
      {
        id: '1:3',
        name: 'Overlay',
        type: 'RECTANGLE',
        layoutPositioning: 'ABSOLUTE',
        layoutSizingHorizontal: 'FIXED',
        layoutSizingVertical: 'FIXED',
        minWidth: 10,
        maxWidth: 100,
        constraints: { horizontal: 'RIGHT', vertical: 'CENTER' },
        absoluteBoundingBox: { x: 450, y: 100, width: 50, height: 50 },
      },
    ],
  };
  const document = normalizeFigma(
    raw,
    {
      kind: 'figma',
      url: '',
      fileKey: '',
      nodeId: raw.id,
      version: 'test',
      importedAt: new Date().toISOString(),
      previewAssetId: previewId,
      importedRevision: 0,
    },
    {},
    {},
  );
  const source = { response: { nodes: { [raw.id]: { document: raw } } } };
  const assets = [
    { id: previewId, mimeType: 'image/png', bytes: png, role: 'reference' },
  ];
  return { raw, document, source, assets };
}
test('all imported leaf sizing and absolute positioning survive normalization and SQLite reopen', () => {
  const f = fixture(),
    directory = mkdtempSync(path.join(tmpdir(), 'child-layout-')),
    filename = path.join(directory, 'design.db');
  let service = new DocumentService(filename);
  try {
    service.importDocument(f.document, f.source, f.assets);
    service.close();
    service = new DocumentService(filename);
    const document = service.read(f.document.id).document,
      page = document.pages[0],
      root = page.nodes.find((n) => n.source?.nodeId === '1:1')!,
      text = page.nodes.find((n) => n.source?.nodeId === '1:2')!,
      overlay = page.nodes.find((n) => n.source?.nodeId === '1:3')!;
    assert.equal(text.layoutItem?.widthMode, 'FILL');
    assert.equal(text.layoutItem?.heightMode, 'HUG');
    assert.equal(text.layoutItem?.positioning, 'flow');
    assert.equal(overlay.layoutItem?.positioning, 'absolute');
    assert.equal(overlay.layoutItem?.constraints?.horizontal, 'end');
    assert.equal(overlay.layoutItem?.maxWidth, 100);
    const scope = {
      documentId: document.id,
      pageId: page.id,
      nodeId: root.id,
      expectedRevision: 0,
    };
    const context = getDesignContext(service, scope);
    assert.equal(
      context.nodes.find((n) => n.id === text.id)?.layoutItem?.widthMode,
      'FILL',
    );
    const layout = getLayoutContext(service, scope).frames[0];
    assert.deepEqual(layout.absoluteChildIds, [overlay.id]);
    assert.deepEqual(layout.flowChildOrder, [text.id]);
    assert.equal(layout.cssHints.container.position, 'relative');
    assert(!layout.warnings.some((w) => w.includes('differ')));
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('explicit recovery preserves edits, existing metadata and locks; it is atomic and undoable', () => {
  const f = fixture(),
    service = new DocumentService(':memory:');
  try {
    for (const node of f.document.pages[0].nodes) delete node.layoutItem;
    const page = f.document.pages[0],
      root = page.nodes.find((n) => n.parentId === null)!,
      text = page.nodes.find((n) => n.source?.nodeId === '1:2')!,
      overlay = page.nodes.find((n) => n.source?.nodeId === '1:3')!;
    text.text = 'Local edit';
    text.x = 30;
    text.layoutItem = { widthMode: 'FIXED' };
    root.layout!.gap = 41;
    overlay.locked = true;
    service.importDocument(f.document, f.source, f.assets);
    const scope = {
        documentId: f.document.id,
        pageId: page.id,
        nodeId: root.id,
        expectedRevision: 0,
      },
      baseline = getCodingBrief(service, scope).changeTracking.baseline;
    const before = structuredClone(service.read(f.document.id).document);
    execute(service, {
      ...scope,
      command: { type: 'recover_layout_metadata', id: root.id },
    });
    const after = service.read(f.document.id).document;
    assert.equal(after.revision, 1);
    assert.deepEqual(
      after.pages[0].nodes.find((n) => n.id === text.id),
      text,
    );
    assert.deepEqual(
      after.pages[0].nodes.find((n) => n.id === overlay.id),
      overlay,
    );
    assert.equal(
      after.pages[0].nodes.find((n) => n.id === root.id)?.layout?.gap,
      41,
    );
    const changes = getDesignChanges(service, {
      ...scope,
      expectedRevision: 1,
      baseline,
    });
    assert.deepEqual(changes.layers.updated, [root.id]);
    assert.throws(
      () =>
        execute(service, {
          ...scope,
          command: { type: 'recover_layout_metadata', id: root.id },
        }),
      /changed/,
    );
    execute(service, {
      ...scope,
      expectedRevision: 1,
      command: { type: 'undo' },
    });
    const undone = service.read(f.document.id).document;
    assert.deepEqual(undone.pages, before.pages);
  } finally {
    service.close();
  }
});
test('recovery of leaf metadata appears in revision diffs and repeated recovery is a no-op', () => {
  const f = fixture(),
    service = new DocumentService(':memory:');
  try {
    for (const n of f.document.pages[0].nodes) delete n.layoutItem;
    service.importDocument(f.document, f.source, f.assets);
    const page = f.document.pages[0],
      scope = {
        documentId: f.document.id,
        pageId: page.id,
        nodeId: page.nodes[0].id,
        expectedRevision: 0,
      };
    const baseline = getCodingBrief(service, scope).changeTracking.baseline;
    execute(service, {
      ...scope,
      command: { type: 'recover_layout_metadata', id: scope.nodeId },
    });
    assert.equal(
      getDesignChanges(service, { ...scope, expectedRevision: 1, baseline })
        .layers.updated.length,
      3,
    );
    execute(service, {
      ...scope,
      expectedRevision: 1,
      command: { type: 'recover_layout_metadata', id: scope.nodeId },
    });
    assert.equal(service.read(f.document.id).document.revision, 1);
  } finally {
    service.close();
  }
});
test('invalid source layout values are never executable CSS or invented sizing rules', () => {
  assert.equal(
    importedLayoutItem({
      layoutSizingHorizontal: 'url(unsafe)',
      layoutPositioning: 'evil',
      minWidth: Infinity,
      layoutAlign: { toString: 4 },
      constraints: { horizontal: 'constructor' },
    }),
    undefined,
  );
  assert.deepEqual(
    importedLayoutItem({ minWidth: 100, maxWidth: 10 }),
    undefined,
  );
  assert.throws(() => layoutItemSchema.parse({ minWidth: 100, maxWidth: 10 }));
  assert.equal(importedLayoutItem({}, null)?.positioning, undefined);
});
