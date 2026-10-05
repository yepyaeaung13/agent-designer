import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentService } from '../src/main/document-service';
import { makeNode } from '../src/shared/design';
import { recalculateAutoLayout } from '../src/shared/auto-layout';
import { textLayout } from '../src/renderer/text-layout';
import { normalizeFigma } from '../src/main/figma-import';

test('explicit text sizing overrides legacy height inference and preserves wrapping', () => {
  const node = { ...makeNode('text'), height: 12, text: 'A long label' };
  assert.equal(textLayout(node).width, undefined);
  assert.equal(
    textLayout({ ...node, textSizing: 'auto-height' }).width,
    node.width,
  );
  assert.equal(
    textLayout({ ...node, textSizing: 'auto-height', textWrap: 'char' }).wrap,
    'char',
  );
  assert.equal(textLayout({ ...node, textSizing: 'fixed' }).height, 12);
  assert.equal(
    textLayout({ ...node, textSizing: 'auto-width', textWrap: 'word' }).wrap,
    'none',
  );
});

test('Figma text sizing survives persistence and undo while missing metadata stays legacy', () => {
  const service = new DocumentService(':memory:');
  try {
    for (const [sourceMode, mode] of [
      ['WIDTH_AND_HEIGHT', 'auto-width'],
      ['HEIGHT', 'auto-height'],
      ['NONE', 'fixed'],
      ['TRUNCATE', 'fixed'],
      [undefined, undefined],
    ] as const) {
      const imported = normalizeFigma(
        {
          id: '1:1',
          type: 'TEXT',
          name: 'Label',
          characters: 'Hello',
          textAutoResize: sourceMode,
          absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 20 },
        },
        {
          kind: 'figma',
          url: '',
          fileKey: '',
          nodeId: '1:1',
          version: '',
          importedAt: new Date().toISOString(),
          previewAssetId: 'a'.repeat(64),
          importedRevision: 0,
        },
        {},
      );
      const text = imported.pages[0].nodes[0];
      assert.equal(text.textSizing, mode);
      const snapshot = service.read();
      const request = {
        documentId: snapshot.document.id,
        pageId: snapshot.activePageId,
        expectedRevision: snapshot.document.revision,
      };
      const created = service.execute({
        ...request,
        command: { type: 'create', node: text },
      });
      assert.equal(
        created.document.pages[0].nodes.find((n) => n.id === text.id)
          ?.textSizing,
        mode,
      );
      const changed = service.execute({
        ...request,
        expectedRevision: created.document.revision,
        command: {
          type: 'update',
          id: text.id,
          patch: { textSizing: 'fixed', textWrap: 'char' },
        },
      });
      const undone = service.execute({
        ...request,
        expectedRevision: changed.document.revision,
        command: { type: 'undo' },
      });
      assert.equal(
        undone.document.pages[0].nodes.find((n) => n.id === text.id)
          ?.textSizing,
        mode,
      );
    }
  } finally {
    service.close();
  }
});

const layout = {
  enabled: true,
  direction: 'vertical' as const,
  gap: 8,
  padding: { top: 10, right: 10, bottom: 10, left: 10 },
  align: 'MIN',
  justify: 'MIN',
  widthMode: 'FIXED',
  heightMode: 'HUG',
  wrap: false,
};
const measure = (
  node: ReturnType<typeof makeNode>,
  axis: 'width' | 'height',
) => ({
  width: node.text.length * 10,
  height:
    axis === 'width'
      ? 20
      : Math.ceil((node.text.length * 10) / node.width) * 20,
});
test('fill text is remeasured after width allocation and moves siblings and hug parents', () => {
  const root = { ...makeNode('frame'), width: 220, layout };
  const text = {
    ...makeNode('text'),
    parentId: root.id,
    text: 'A'.repeat(30),
    width: 300,
    height: 20,
    layoutItem: {
      positioning: 'flow' as const,
      widthMode: 'FILL' as const,
      heightMode: 'HUG' as const,
    },
  };
  const sibling = {
    ...makeNode('rectangle'),
    parentId: root.id,
    height: 25,
    layoutItem: { positioning: 'flow' as const },
  };
  recalculateAutoLayout([root, text, sibling], undefined, measure);
  assert.equal(text.width, 200);
  assert.equal(text.height, 40);
  assert.equal(sibling.y, 58);
  assert.equal(root.height, 93);
  root.width = 120;
  recalculateAutoLayout([root, text, sibling], undefined, measure);
  assert.equal(text.width, 100);
  assert.equal(text.height, 60);
  assert.equal(sibling.y, 78);
  assert.equal(root.height, 113);
});
test('width hug respects max bounds before height measurement; fixed text remains fixed', () => {
  const root = { ...makeNode('frame'), layout };
  const text = {
    ...makeNode('text'),
    parentId: root.id,
    text: 'A'.repeat(30),
    layoutItem: {
      positioning: 'flow' as const,
      widthMode: 'HUG' as const,
      heightMode: 'HUG' as const,
      maxWidth: 100,
    },
  };
  recalculateAutoLayout([root, text], undefined, measure);
  assert.equal(text.width, 100);
  assert.equal(text.height, 60);
  text.layoutItem.widthMode = 'FIXED' as never;
  text.layoutItem.heightMode = 'FIXED' as never;
  recalculateAutoLayout([root, text], undefined, () => {
    throw Error('Fixed text should not be measured');
  });
  assert.equal(text.height, 60);
});
test('asynchronous measurement is atomic, undoable and rejects stale results or renderer failures', async () => {
  const service = new DocumentService(':memory:');
  try {
    const first = service.read().document,
      pageId = first.pages[0].id,
      documentId = first.id;
    const root = {
      ...makeNode('frame'),
      layout: { ...layout, enabled: false },
    };
    const execute = (command: unknown) =>
      service.execute({
        documentId,
        pageId,
        expectedRevision: service.read().document.revision,
        command,
      });
    execute({ type: 'create', node: root });
    service.setLayoutRecalculator(async (nodes, previous) => {
      recalculateAutoLayout(nodes, previous);
      return nodes;
    });
    const before = service.read().document;
    const request = {
      documentId,
      pageId,
      expectedRevision: before.revision,
      command: { type: 'set_auto_layout', id: root.id, enabled: true },
    };
    const enabled = (await service.executeAsync(request)).document;
    assert.equal(enabled.revision, before.revision + 1);
    assert.equal(
      enabled.pages[0].nodes.find((n) => n.id === root.id)!.height,
      20,
    );
    execute({ type: 'undo' });
    assert.deepEqual(service.read().document.pages, before.pages);
    service.setLayoutRecalculator(async () => {
      throw Error('Missing font');
    });
    const stable = service.read().document;
    await assert.rejects(
      service.executeAsync({ ...request, expectedRevision: stable.revision }),
      /Missing font/,
    );
    assert.deepEqual(service.read().document, stable);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.setLayoutRecalculator(async (nodes) => {
      await gate;
      return nodes;
    });
    const pending = service.executeAsync({
      ...request,
      expectedRevision: stable.revision,
    });
    execute({ type: 'rename', name: 'Concurrent edit' });
    release();
    await assert.rejects(pending, /changed during/);
    assert.equal(service.read().document.name, 'Concurrent edit');
    assert.equal(
      service.read().document.pages[0].nodes.find((n) => n.id === root.id)!
        .layout!.enabled,
      false,
    );
  } finally {
    service.close();
  }
});
